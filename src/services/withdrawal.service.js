import { query } from '../config/database.js';
import { getDbDriver } from '../config/database.js';
import { AUTHORIZE_WITHDRAWAL_PERMISSION, AUTHORIZER_ROLE_NAME_ALIASES, LARAVEL_USER_MODEL } from '../constants/adminRoles.js';
import { buildWithdrawalProofApiUrl } from './withdrawalProofStorage.service.js';
import { batchScammerCheck, isScammerMatch } from './scammer.service.js';
import { getUserPendingShowCount } from './systemUser.service.js';
import { getUserStatusUpdateScope } from './statusUpdateScope.service.js';
import {
  formatTimestampSl,
  laravelSimilarCountSinceSql,
  parseDateWindow,
} from '../utils/slTime.js';
import { formatCustomerRejectReason } from '../constants/rejectReasons.js';
import { pushAmountKeywordClauses } from '../utils/searchAmount.js';
import { normalizeToActivityIdentifier } from './role.service.js';

const EXCLUDED_USER_IDS = [4, 16405];

function validationError(message, status = 422) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function isWithdrawalExecutive(roles = []) {
  return (
    roles.includes('withdrawal-executive') &&
    !roles.includes('super-admin') &&
    !roles.includes('sub-admin')
  );
}

export function canAuthorizeWithdrawals(permissions = []) {
  return permissions.includes(AUTHORIZE_WITHDRAWAL_PERMISSION);
}

function isAdmin(roles = []) {
  return roles.includes('super-admin') || roles.includes('sub-admin');
}

function roleSlug(role) {
  return String(role || '')
    .trim()
    .toLowerCase()
    .replace(/[_ ]+/g, '-');
}

function hasAuthorizerRole(roles = []) {
  return roles.some((role) => {
    const slug = roleSlug(role);
    return slug === 'withdrawal-authorizer' || slug === 'withdrawal-authorization';
  });
}

function isWithdrawalAuthorizerOnly(roles = [], permissions = []) {
  return (
    (canAuthorizeWithdrawals(permissions) || hasAuthorizerRole(roles)) &&
    !isAdmin(roles) &&
    !isWithdrawalExecutive(roles)
  );
}

/** Keep the requested status. Pending and Pending Authorization are separate queues. */
function resolveWithdrawalListStatus(status) {
  return normalizeStatus(status);
}

let statusEnumReady = false;
let authorizerCache = { value: null, expiresAt: 0 };

export async function ensureWithdrawalAuthorizationSchema() {
  if (statusEnumReady || getDbDriver() === 'sqlite') {
    statusEnumReady = true;
    return;
  }
  try {
    await query(
      `ALTER TABLE withdrawals
       MODIFY transaction_status ENUM('Pending', 'Pending Authorization', 'Completed', 'Rejected') NULL`,
    );
  } catch (error) {
    console.warn('[withdrawals:status-enum]', error.message);
  }
  statusEnumReady = true;
}

export async function hasActiveWithdrawalAuthorizers() {
  if (authorizerCache.value != null && Date.now() < authorizerCache.expiresAt) {
    return authorizerCache.value;
  }
  const value = await loadActiveWithdrawalAuthorizers();
  authorizerCache = { value, expiresAt: Date.now() + 60_000 };
  return value;
}

async function loadActiveWithdrawalAuthorizers() {
  const permissionRows = await query('SELECT id, name FROM permissions');
  const ids = permissionRows
    .filter((row) => normalizeToActivityIdentifier(row.name) === AUTHORIZE_WITHDRAWAL_PERMISSION)
    .map((row) => row.id);

  if (ids.length) {
    const placeholders = ids.map(() => '?').join(', ');
    const viaRole = await query(
      `SELECT COUNT(*) AS cnt
       FROM model_has_roles mhr
       INNER JOIN role_has_permissions rhp ON rhp.role_id = mhr.role_id
       WHERE rhp.permission_id IN (${placeholders})
         AND mhr.model_type = ?`,
      [...ids, LARAVEL_USER_MODEL],
    );
    if (Number(viaRole[0]?.cnt) > 0) return true;

    try {
      const viaDirect = await query(
        `SELECT COUNT(*) AS cnt
         FROM model_has_permissions mhp
         WHERE mhp.permission_id IN (${placeholders})
           AND mhp.model_type = ?`,
        [...ids, LARAVEL_USER_MODEL],
      );
      if (Number(viaDirect[0]?.cnt) > 0) return true;
    } catch {
      // model_has_permissions may be absent
    }
  }

  const rolePlaceholders = AUTHORIZER_ROLE_NAME_ALIASES.map(() => '?').join(', ');
  const viaNamedRole = await query(
    `SELECT COUNT(*) AS cnt
     FROM model_has_roles mhr
     INNER JOIN roles r ON r.id = mhr.role_id
     WHERE r.name IN (${rolePlaceholders})
       AND mhr.model_type = ?`,
    [...AUTHORIZER_ROLE_NAME_ALIASES, LARAVEL_USER_MODEL],
  );
  return Number(viaNamedRole[0]?.cnt) > 0;
}

function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function formatMoney(currency, amount) {
  const value = Number(amount);
  const formatted = Number.isFinite(value)
    ? value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : String(amount ?? '0.00');
  return `${currency || ''} ${formatted}`.trim();
}

function parseAccountDetailsLog(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function formatWithdrawalAccount(row) {
  const details = parseAccountDetailsLog(row.account_details_log);
  if (!details) return '—';

  const accountType = String(row.selected_account_type || details.account_type || '')
    .trim()
    .toLowerCase();
  const accountId = details.account_id || details.account_number || '';

  if (accountType.includes('bank')) {
    return [details.bank_name, accountId, details.account_name].filter(Boolean).join(' · ') || accountId || '—';
  }

  switch (accountType) {
    case 'skrill':
    case 'neteller':
    case 'xm':
    case 'perfect_money':
    case 'crypto':
      return accountId || '—';
    default:
      return accountId || details.account_name || '—';
  }
}

function normalizeStatus(status) {
  const value = String(status || 'Pending').trim();
  if (['Pending', 'Pending Authorization', 'Completed', 'Rejected', 'All'].includes(value)) {
    return value;
  }
  return 'Pending';
}

function buildBaseConditions(status, assignedToUserId, { requirePaymentProof = true } = {}) {
  const conditions = [];
  const values = [];

  if (requirePaymentProof) {
    conditions.push('w.cashout_payment_proof IS NOT NULL');
  }

  if (status !== 'All') {
    conditions.push('w.transaction_status = ?');
    values.push(status);
  }

  if (status === 'Completed' || status === 'Rejected' || status === 'All') {
    conditions.push(`w.user_id NOT IN (${EXCLUDED_USER_IDS.map(() => '?').join(', ')})`);
    values.push(...EXCLUDED_USER_IDS);
  }

  if (
    assignedToUserId != null &&
    (status === 'Pending' || status === 'Pending Authorization')
  ) {
    conditions.push('w.assigned_to = ?');
    values.push(assignedToUserId);
  }

  return { conditions, values };
}

async function fetchAdminNames(adminIds) {
  const ids = [
    ...new Set(
      adminIds
        .map((id) => Number(id))
        .filter((id) => Number.isFinite(id) && id > 0),
    ),
  ];
  if (!ids.length) return {};
  const rows = await query(
    `SELECT id, name FROM users WHERE id IN (${ids.map(() => '?').join(', ')})`,
    ids,
  );
  return Object.fromEntries(rows.map((row) => [Number(row.id), row.name]));
}

async function batchSimilarWithdrawals(rows, status) {
  if (!rows.length) return {};

  const pairs = [
    ...new Map(
      rows.map((row) => [
        `${row.cashout_method_id}_${row.cashout_account_id}`,
        { methodId: row.cashout_method_id, accountId: row.cashout_account_id },
      ]),
    ).values(),
  ];

  const since = laravelSimilarCountSinceSql();
  const statusSql =
    status === 'Completed'
      ? `transaction_status = 'Completed'`
      : `transaction_status != 'Rejected'`;

  const pairClauses = pairs.map(() => '(cashout_method_id = ? AND cashout_account_id = ?)').join(' OR ');
  const pairValues = pairs.flatMap((pair) => [pair.methodId, pair.accountId]);

  const countRows = await query(
    `SELECT cashout_method_id, cashout_account_id, COUNT(*) AS cnt
     FROM withdrawals
     WHERE cashout_payment_proof IS NOT NULL
       AND created_at >= ?
       AND ${statusSql}
       AND (${pairClauses})
     GROUP BY cashout_method_id, cashout_account_id`,
    [since, ...pairValues],
  );

  const result = {};
  for (const row of countRows) {
    result[`${row.cashout_method_id}_${row.cashout_account_id}`] = Number(row.cnt) || 0;
  }
  return result;
}

function firstAdminId(...ids) {
  for (const id of ids) {
    const value = Number(id);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

function lookupAdminName(adminUsers, assignedUsers, userId) {
  const id = firstAdminId(userId);
  if (!id) return null;
  return adminUsers[id] || assignedUsers[id] || String(id);
}

function mapWithdrawalRow(row, adminUsers, assignedUsers, similarCounts) {
  const cashoutAmount = Number(row.cashout_amount) || 0;
  const receivingAmount = Number(row.receiving_amount) || 0;
  const status = String(row.transaction_status || '').trim();
  const assignedName = lookupAdminName(adminUsers, assignedUsers, row.assigned_to) || '—';
  const updatedByName = lookupAdminName(adminUsers, assignedUsers, row.pendings_by_admin) || '—';
  const authorizedById =
    status === 'Completed'
      ? firstAdminId(row.approved_by_admin, row.assigned_to, row.pendings_by_admin)
      : status === 'Rejected'
        ? firstAdminId(row.rejected_by_admin, row.assigned_to, row.pendings_by_admin)
        : status === 'Pending Authorization'
          ? firstAdminId(row.assigned_to, row.pendings_by_admin)
          : null;
  const authorizedByName = lookupAdminName(adminUsers, assignedUsers, authorizedById) || '—';
  const adminId =
    status === 'Completed' || status === 'Rejected'
      ? authorizedById
      : status === 'Pending' || status === 'Pending Authorization'
        ? row.pendings_by_admin
        : null;
  const adminName = lookupAdminName(adminUsers, assignedUsers, adminId) || 'NA';
  const simKey = `${row.cashout_method_id}_${row.cashout_account_id}`;
  const todayTxCount = similarCounts[simKey] || 0;
  const accountDetails = parseAccountDetailsLog(row.account_details_log);
  const selectedAccountType =
    row.selected_account_type || accountDetails?.account_type || '';

  return {
    id: row.transaction_id,
    withdrawalId: row.id,
    date: formatTimestampSl(row.updated_at),
    createdAt: formatTimestampSl(row.created_at),
    userId: row.account_number || String(row.user_id),
    customer: row.user_name ? String(row.user_name).split(' ')[0] : 'N/A',
    platformId: row.cashout_account_id || '—',
    cashoutMethodId: row.cashout_method_id,
    method: row.receiving_payment_option_name || '—',
    amount: formatMoney(row.cashout_amount_currency, cashoutAmount),
    cashoutAmt: formatMoney(row.cashout_amount_currency, cashoutAmount),
    clientPayUsd: String(row.cashout_amount_currency || '').toUpperCase() !== 'LKR' ? cashoutAmount : 0,
    clientPayLkr: String(row.cashout_amount_currency || '').toUpperCase() === 'LKR' ? cashoutAmount : 0,
    receiving: formatMoney(row.receiving_amount_currency, receivingAmount),
    payout: formatMoney(row.receiving_amount_currency, receivingAmount),
    platform: row.cashout_method_name || '—',
    status,
    account: formatWithdrawalAccount(row),
    selectedAccountType,
    bankName: accountDetails?.bank_name || null,
    accountName: accountDetails?.account_name || null,
    bankAccountNo:
      accountDetails?.account_id || accountDetails?.account_number || null,
    assigned: assignedName,
    assignedToId: row.assigned_to,
    admin: adminName,
    updatedBy: updatedByName,
    authorizedBy: authorizedByName,
    proof: Boolean(row.cashout_payment_proof),
    proofUrl: buildWithdrawalProofApiUrl(row.cashout_payment_proof),
    proofFileName: row.cashout_payment_proof || null,
    rejectReason:
      row.transaction_status === 'Rejected'
        ? formatCustomerRejectReason(row.rejected_reason, row.rejected_reason_message) || null
        : null,
    rejectReasonMessage:
      row.transaction_status === 'Rejected' ? row.rejected_reason_message || null : null,
    rejectReasonCategory:
      row.transaction_status === 'Rejected' ? row.rejected_reason || null : null,
    customerEmail: row.customer_email || null,
    customerMobile: row.customer_mobile || null,
    todayTxCount,
    isScammer: false,
  };
}

function sanitizePendingSearchParams(status, params) {
  if (normalizeStatus(status) !== 'Pending' && normalizeStatus(status) !== 'Pending Authorization') {
    return { ...params, requirePaymentProof: true };
  }

  const keyword = params.keyword?.trim() || '';
  return {
    ...params,
    keyword,
    transactionId: null,
    platformId: null,
    userAccount: null,
    amount: null,
    filter: null,
    fromDate: null,
    toDate: null,
    requirePaymentProof: true,
  };
}

function isWithdrawalSearchActive(status, params) {
  const normalizedStatus = normalizeStatus(status);
  if (params.keyword?.trim()) return true;
  if (normalizedStatus === 'Pending') return false;
  if (normalizedStatus === 'Pending Authorization') return false;
  if (normalizedStatus === 'All') {
    return Boolean(
      params.transactionId ||
        params.platformId ||
        params.userAccount ||
        (params.amount != null && params.amount !== '') ||
        params.filter ||
        params.fromDate ||
        params.toDate,
    );
  }

  return Boolean(
    params.transactionId ||
      params.platformId ||
      params.userAccount ||
      (params.amount != null && params.amount !== '') ||
      (params.filter && params.filter !== 'today') ||
      params.fromDate ||
      params.toDate,
  );
}

function sumPageTotals(rows) {
  return rows.reduce(
    (acc, row) => {
      acc.totalCashoutAmount += Number(row.cashout_amount) || 0;
      acc.totalReceivingAmount += Number(row.receiving_amount) || 0;
      return acc;
    },
    { totalCashoutAmount: 0, totalReceivingAmount: 0 },
  );
}

async function listWithdrawalsQuery({
  status,
  page,
  perPage,
  keyword,
  transactionId,
  platformId,
  userAccount,
  amount,
  filter,
  fromDate,
  toDate,
  assignedToUserId,
  requirePaymentProof = true,
  maxLoadRows = null,
}) {
  const normalizedStatus = normalizeStatus(status);
  const pageNum = Math.max(1, Number(page) || 1);
  const requestedTake = Math.min(100, Math.max(1, Number(perPage) || 10));
  const skip = (pageNum - 1) * requestedTake;
  let take = requestedTake;
  if (maxLoadRows != null && maxLoadRows > 0) {
    if (skip >= maxLoadRows) {
      take = 0;
    } else {
      take = Math.min(take, maxLoadRows - skip);
    }
  }

  let effectiveFilter = filter || null;
  let dateWindow = parseDateWindow(effectiveFilter, fromDate, toDate);

  if (
    (normalizedStatus === 'Completed' || normalizedStatus === 'Rejected') &&
    !keyword?.trim() &&
    !transactionId &&
    !platformId &&
    !userAccount &&
    amount == null &&
    !effectiveFilter &&
    !fromDate &&
    !toDate
  ) {
    effectiveFilter = 'today';
    dateWindow = parseDateWindow('today');
  }

  const { conditions, values } = buildBaseConditions(normalizedStatus, assignedToUserId, {
    requirePaymentProof,
  });

  if (transactionId) {
    conditions.push('w.transaction_id = ?');
    values.push(String(transactionId).trim());
  }
  if (platformId) {
    conditions.push('w.cashout_account_id = ?');
    values.push(String(platformId).trim());
  }
  if (amount != null && amount !== '') {
    conditions.push('w.cashout_amount = ?');
    values.push(Number(amount));
  }
  if (userAccount) {
    conditions.push(`EXISTS (
      SELECT 1 FROM account_holders ah_acc
      WHERE ah_acc.user_id = w.user_id AND ah_acc.account_number = ?
    )`);
    values.push(String(userAccount).trim());
  }

  if (keyword?.trim()) {
    const like = `%${escapeLike(keyword.trim())}%`;
    const adminColumn =
      normalizedStatus === 'Pending' || normalizedStatus === 'Pending Authorization'
        ? 'w.pendings_by_admin'
        : normalizedStatus === 'Completed'
          ? 'w.approved_by_admin'
          : 'w.rejected_by_admin';
    const keywordParts = [
      'w.transaction_id LIKE ? ESCAPE \'\\\\\'',
      'w.cashout_account_id LIKE ? ESCAPE \'\\\\\'',
      `EXISTS (
        SELECT 1 FROM users u_kw
        WHERE u_kw.id = w.user_id AND u_kw.name LIKE ? ESCAPE '\\\\'
      )`,
      `EXISTS (
        SELECT 1 FROM account_holders ah_kw
        WHERE ah_kw.user_id = w.user_id AND ah_kw.account_number LIKE ? ESCAPE '\\\\'
      )`,
    ];
    const keywordValues = [like, like, like, like];

    if (
      normalizedStatus === 'Pending' ||
      normalizedStatus === 'Pending Authorization' ||
      normalizedStatus === 'All'
    ) {
      keywordParts.push(
        `EXISTS (
          SELECT 1 FROM users exec
          WHERE exec.id = w.assigned_to AND exec.name LIKE ? ESCAPE '\\\\'
        )`,
      );
      keywordValues.push(like);
    }

    if (normalizedStatus === 'All') {
      keywordParts.push(
        `EXISTS (
          SELECT 1 FROM users admin_user
          WHERE admin_user.id IN (w.pendings_by_admin, w.approved_by_admin, w.rejected_by_admin)
            AND admin_user.name LIKE ? ESCAPE '\\\\'
        )`,
      );
    } else {
      keywordParts.push(
        `EXISTS (
          SELECT 1 FROM users admin_user
          WHERE admin_user.id = ${adminColumn}
            AND admin_user.name LIKE ? ESCAPE '\\\\'
        )`,
      );
    }
    keywordValues.push(like);

    pushAmountKeywordClauses(
      keywordParts,
      keywordValues,
      ['w.cashout_amount', 'w.receiving_amount'],
      keyword,
      escapeLike,
    );

    conditions.push(`(${keywordParts.join(' OR ')})`);
    values.push(...keywordValues);
  }

  if (dateWindow.from) {
    conditions.push('w.updated_at >= ?');
    values.push(formatTimestampSl(dateWindow.from));
  }
  if (dateWindow.to) {
    conditions.push('w.updated_at < ?');
    values.push(formatTimestampSl(dateWindow.to));
  }

  const whereSql = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const orderSql =
    normalizedStatus === 'Pending' || normalizedStatus === 'Pending Authorization'
      ? 'ORDER BY w.updated_at ASC, w.id ASC'
      : 'ORDER BY w.updated_at DESC, w.id DESC';

  const [countRows, idRows] = await Promise.all([
    query(`SELECT COUNT(*) AS total FROM withdrawals w ${whereSql}`, values),
    take <= 0
      ? Promise.resolve([])
      : query(
          `SELECT w.id FROM withdrawals w ${whereSql} ${orderSql} LIMIT ${take} OFFSET ${skip}`,
          values,
        ),
  ]);
  const totalCount = Number(countRows[0]?.total) || 0;
  const totalPages = requestedTake > 0 ? Math.ceil(totalCount / requestedTake) : 1;
  const pageIds = idRows.map((row) => row.id).filter(Boolean);

  const fetchedRows = pageIds.length
    ? await query(
        `SELECT w.*, u.name AS user_name, cm.cashout_method_name, po.payment_option_name AS receiving_payment_option_name,
            ah.account_number, ah.email AS customer_email, ah.mobile_number AS customer_mobile
         FROM withdrawals w
         INNER JOIN users u ON w.user_id = u.id
         INNER JOIN cashout_methods cm ON w.cashout_method_id = cm.id
         LEFT JOIN payment_options po ON w.receiving_payment_option_id = po.id
         LEFT JOIN account_holders ah ON ah.id = (
           SELECT MIN(ah2.id) FROM account_holders ah2 WHERE ah2.user_id = w.user_id
         )
         WHERE w.id IN (${pageIds.map(() => '?').join(', ')})`,
        pageIds,
      )
    : [];
  const fetchedById = new Map(fetchedRows.map((row) => [row.id, row]));
  const rows = pageIds.map((id) => fetchedById.get(id)).filter(Boolean);

  const adminIds = rows.flatMap((row) => [
    row.pendings_by_admin,
    row.approved_by_admin,
    row.rejected_by_admin,
    row.assigned_to,
  ]);
  const assignedIds = rows.map((row) => row.assigned_to).filter(Boolean);
  const [adminUsers, assignedUsers] = await Promise.all([
    fetchAdminNames(adminIds),
    fetchAdminNames(assignedIds),
  ]);

  return {
    rows,
    adminUsers,
    assignedUsers,
    pagination: {
      current_page: pageNum,
      total_pages: totalPages,
      total_count: totalCount,
      per_page: requestedTake,
      has_prev: pageNum > 1,
      has_next: pageNum < totalPages,
    },
  };
}

async function getWithdrawalTotals(status, assignedToUserId) {
  const normalizedStatus = normalizeStatus(status);
  const { conditions, values } = buildBaseConditions(
    normalizedStatus === 'All' ? 'Pending' : normalizedStatus,
    assignedToUserId,
  );

  if (normalizedStatus === 'Completed' || normalizedStatus === 'Rejected') {
    const today = parseDateWindow('today');
    conditions.push('w.updated_at >= ?');
    conditions.push('w.updated_at < ?');
    values.push(formatTimestampSl(today.from), formatTimestampSl(today.to));
  }

  const rows = await query(
    `SELECT
       COALESCE(SUM(w.cashout_amount), 0) AS totalCashoutAmount,
       COALESCE(SUM(w.receiving_amount), 0) AS totalReceivingAmount
     FROM withdrawals w
     WHERE ${conditions.join(' AND ')}`,
    values,
  );

  return {
    totalCashoutAmount: Number(rows[0]?.totalCashoutAmount) || 0,
    totalReceivingAmount: Number(rows[0]?.totalReceivingAmount) || 0,
  };
}

export async function listWithdrawalsForAdmin(auth, params = {}) {
  await ensureWithdrawalAuthorizationSchema();
  const roles = auth?.roles || [];
  const permissions = auth?.permissions || [];
  const userId = auth?.userId;
  const isExec = isWithdrawalExecutive(roles) && !isAdmin(roles);
  const canAuthorize = canAuthorizeWithdrawals(permissions);
  const isAuthorizer = isWithdrawalAuthorizerOnly(roles, permissions);

  const statusForTotals = resolveWithdrawalListStatus(params.status);
  const restrictToAssigned =
    (statusForTotals === 'Pending' && (isExec || isAuthorizer)) ||
    (statusForTotals === 'Pending Authorization' && !isAdmin(roles));
  const assignedToUserId = restrictToAssigned ? userId : null;
  const sanitized = sanitizePendingSearchParams(statusForTotals, {
    keyword: params.keyword,
    transactionId: params.transactionId,
    platformId: params.platformId,
    userAccount: params.userAccount,
    amount: params.amount,
    filter: params.filter,
    fromDate: params.fromDate,
    toDate: params.toDate,
  });

  const maxLoadRows = restrictToAssigned ? await getUserPendingShowCount(userId) : null;

  const [result, makerCheckerEnabled] = await Promise.all([
    listWithdrawalsQuery({
      status: statusForTotals,
      page: params.page,
      perPage: params.perPage,
      keyword: sanitized.keyword,
      transactionId: sanitized.transactionId,
      platformId: sanitized.platformId,
      userAccount: sanitized.userAccount,
      amount: sanitized.amount,
      filter: sanitized.filter,
      fromDate: sanitized.fromDate,
      toDate: sanitized.toDate,
      assignedToUserId,
      requirePaymentProof: sanitized.requirePaymentProof,
      maxLoadRows,
    }),
    hasActiveWithdrawalAuthorizers(),
  ]);

  const searchActive = isWithdrawalSearchActive(statusForTotals, {
    keyword: sanitized.keyword,
    transactionId: sanitized.transactionId,
    platformId: sanitized.platformId,
    userAccount: sanitized.userAccount,
    amount: sanitized.amount,
    filter: sanitized.filter,
    fromDate: sanitized.fromDate,
    toDate: sanitized.toDate,
  });

  const totals = searchActive
    ? sumPageTotals(result.rows)
    : await getWithdrawalTotals(
        statusForTotals === 'All' ? 'Pending' : statusForTotals,
        assignedToUserId,
      );

  const [scammerFlags, similarCounts, statusScope] = await Promise.all([
    batchScammerCheck({
      platformIds: result.rows.map((row) => row.cashout_account_id),
      userIds: result.rows.map((row) => row.user_id),
    }),
    batchSimilarWithdrawals(result.rows, statusForTotals === 'All' ? 'Pending' : statusForTotals),
    getUserStatusUpdateScope(userId),
  ]);

  return {
    withdrawals: result.rows.map((row) => ({
      ...mapWithdrawalRow(row, result.adminUsers, result.assignedUsers, similarCounts),
      isScammer: isScammerMatch(scammerFlags, {
        platformId: row.cashout_account_id,
        userId: row.user_id,
      }),
    })),
    totals,
    pagination: result.pagination,
    isAdmin: isAdmin(roles),
    canMutate:
      permissions.includes('status_update_withdrawal_data') ||
      canAuthorize ||
      isAdmin(roles),
    makerCheckerEnabled,
    isWithdrawalAuthorizer: isAuthorizer,
    canAuthorizeWithdrawals: canAuthorize,
    isWithdrawalExecutive: isExec,
    allowed_withdrawal_statuses: statusScope.allowed_withdrawal_statuses,
  };
}

export async function getWithdrawalByTransactionId(auth, transactionId) {
  if (!transactionId) {
    throw validationError('Transaction id is required.');
  }
  const data = await listWithdrawalsForAdmin(auth, {
    status: 'All',
    transactionId,
    page: 1,
    perPage: 1,
  });
  return data.withdrawals[0] || null;
}

const WITHDRAWAL_LIST_JOINS = `
  INNER JOIN users u ON w.user_id = u.id
  INNER JOIN cashout_methods cm ON w.cashout_method_id = cm.id
  LEFT JOIN payment_options po ON w.receiving_payment_option_id = po.id
  LEFT JOIN account_holders ah ON ah.user_id = u.id
`;

export async function listSimilarWithdrawalsToday(auth, { withdrawalId, transactionId } = {}) {
  if (!withdrawalId && !transactionId) {
    throw validationError('Withdrawal id or transaction id is required.');
  }

  const lookupRows = await query(
    withdrawalId
      ? `SELECT w.id, w.transaction_id, w.cashout_method_id, w.cashout_account_id, w.transaction_status
         FROM withdrawals w WHERE w.id = ? LIMIT 1`
      : `SELECT w.id, w.transaction_id, w.cashout_method_id, w.cashout_account_id, w.transaction_status
         FROM withdrawals w WHERE w.transaction_id = ? LIMIT 1`,
    [withdrawalId || transactionId],
  );
  const source = lookupRows[0];
  if (!source) {
    const error = validationError('Withdrawal not found.', 404);
    throw error;
  }

  const statusSql =
    source.transaction_status === 'Completed'
      ? `w.transaction_status = 'Completed'`
      : `w.transaction_status != 'Rejected'`;
  const since = laravelSimilarCountSinceSql();

  const rows = await query(
    `SELECT w.*, u.name AS user_name, cm.cashout_method_name, po.payment_option_name AS receiving_payment_option_name,
            ah.account_number, ah.email AS customer_email, ah.mobile_number AS customer_mobile
     FROM withdrawals w
     ${WITHDRAWAL_LIST_JOINS}
     WHERE w.cashout_payment_proof IS NOT NULL
       AND w.created_at >= ?
       AND w.cashout_method_id = ?
       AND w.cashout_account_id = ?
       AND ${statusSql}
     ORDER BY w.created_at DESC`,
    [since, source.cashout_method_id, source.cashout_account_id],
  );

  const adminIds = rows.flatMap((row) => [
    row.pendings_by_admin,
    row.approved_by_admin,
    row.rejected_by_admin,
    row.assigned_to,
  ]);
  const assignedIds = rows.map((row) => row.assigned_to).filter(Boolean);
  const [adminUsers, assignedUsers, scammerFlags] = await Promise.all([
    fetchAdminNames(adminIds),
    fetchAdminNames(assignedIds),
    batchScammerCheck({
      platformIds: rows.map((row) => row.cashout_account_id),
      userIds: rows.map((row) => row.user_id),
    }),
  ]);

  const count = rows.length;
  const similarCounts = {
    [`${source.cashout_method_id}_${source.cashout_account_id}`]: count,
  };

  return {
    withdrawals: rows.map((row) => ({
      ...mapWithdrawalRow(row, adminUsers, assignedUsers, similarCounts),
      isScammer: isScammerMatch(scammerFlags, {
        platformId: row.cashout_account_id,
        userId: row.user_id,
      }),
    })),
  };
}
