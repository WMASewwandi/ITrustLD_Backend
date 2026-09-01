import { query } from '../config/database.js';
import { buildDepositProofApiUrl } from './depositProofStorage.service.js';
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

const EXCLUDED_USER_IDS = [4, 16405];

function validationError(message, status = 422) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function isDepositExecutive(roles = []) {
  return (
    roles.includes('deposit-executive') &&
    !roles.includes('super-admin') &&
    !roles.includes('sub-admin')
  );
}

function isAdmin(roles = []) {
  return roles.includes('super-admin') || roles.includes('sub-admin');
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

function resolveDepositProofUrl(filename) {
  return buildDepositProofApiUrl(filename);
}

function normalizeStatus(status) {
  const value = String(status || 'Pending').trim();
  if (['Pending', 'Completed', 'Rejected', 'All'].includes(value)) return value;
  return 'Pending';
}

function buildBaseConditions(status, assignedToUserId, { requirePaymentProof = true } = {}) {
  const conditions = [];
  const values = [];

  if (requirePaymentProof) {
    conditions.push('d.payment_proof IS NOT NULL');
  }

  if (status !== 'All') {
    conditions.push('d.transaction_status = ?');
    values.push(status);
  }

  if (status === 'Completed' || status === 'Rejected' || status === 'All') {
    conditions.push(`d.user_id NOT IN (${EXCLUDED_USER_IDS.map(() => '?').join(', ')})`);
    values.push(...EXCLUDED_USER_IDS);
  }

  if (assignedToUserId != null && status === 'Pending') {
    conditions.push('d.assigned_to = ?');
    values.push(assignedToUserId);
  }

  return { conditions, values };
}

async function fetchAdminNames(adminIds) {
  const ids = [...new Set(adminIds.filter(Boolean))];
  if (!ids.length) return {};
  const rows = await query(
    `SELECT id, name FROM users WHERE id IN (${ids.map(() => '?').join(', ')})`,
    ids,
  );
  return Object.fromEntries(rows.map((row) => [row.id, row.name]));
}

async function batchSimilarDeposits(rows, status) {
  if (!rows.length) return {};

  const pairs = [
    ...new Map(
      rows.map((row) => [
        `${row.topup_method_id}_${row.topup_account_id}`,
        { methodId: row.topup_method_id, accountId: row.topup_account_id },
      ]),
    ).values(),
  ];

  const since = laravelSimilarCountSinceSql();
  const statusSql =
    status === 'Completed'
      ? `transaction_status = 'Completed'`
      : `transaction_status != 'Rejected'`;

  const pairClauses = pairs.map(() => '(topup_method_id = ? AND topup_account_id = ?)').join(' OR ');
  const pairValues = pairs.flatMap((pair) => [pair.methodId, pair.accountId]);

  const countRows = await query(
    `SELECT topup_method_id, topup_account_id, COUNT(*) AS cnt
     FROM deposits
     WHERE payment_proof IS NOT NULL
       AND created_at >= ?
       AND ${statusSql}
       AND (${pairClauses})
     GROUP BY topup_method_id, topup_account_id`,
    [since, ...pairValues],
  );

  const result = {};
  for (const row of countRows) {
    result[`${row.topup_method_id}_${row.topup_account_id}`] = Number(row.cnt) || 0;
  }
  return result;
}

function mapDepositRow(row, adminUsers, assignedUsers, similarCounts = {}) {
  const paymentAmount = Number(row.payment_amount) || 0;
  const depositAmount = Number(row.deposit_amount) || 0;
  const adminId =
    row.transaction_status === 'Pending'
      ? row.pendings_by_admin
      : row.transaction_status === 'Completed'
        ? row.approved_by_admin
        : row.rejected_by_admin;
  const adminName = adminId ? adminUsers[adminId] || String(adminId) : 'NA';
  const assignedName = row.assigned_to
    ? assignedUsers[row.assigned_to] || String(row.assigned_to)
    : '—';
  const simKey = `${row.topup_method_id}_${row.topup_account_id}`;
  const todayTxCount = similarCounts[simKey] || 0;

  return {
    id: row.transaction_id,
    depositId: row.id,
    date: formatTimestampSl(row.updated_at),
    createdAt: formatTimestampSl(row.created_at),
    userId: row.account_number || String(row.user_id),
    customer: row.user_name ? String(row.user_name).split(' ')[0] : 'N/A',
    platformId: row.topup_account_id || '—',
    method: row.payment_option_name || '—',
    clientPay: formatMoney(row.payment_amount_currency, paymentAmount),
    clientPayLkr: String(row.payment_amount_currency || '').toUpperCase() === 'LKR' ? paymentAmount : 0,
    clientPayUsd: String(row.payment_amount_currency || '').toUpperCase() !== 'LKR' ? paymentAmount : 0,
    platform: row.topup_method_name || '—',
    deposited: formatMoney(row.deposit_amount_currency, depositAmount),
    amount: formatMoney(row.deposit_amount_currency, depositAmount),
    received: formatMoney(row.deposit_amount_currency, depositAmount),
    status: row.transaction_status,
    account: row.account_number || 'N/A',
    assigned: assignedName,
    assignedToId: row.assigned_to,
    admin: adminName,
    proof: Boolean(row.payment_proof),
    proofUrl: resolveDepositProofUrl(row.payment_proof),
    proofFileName: row.payment_proof || null,
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
    topupMethodId: row.topup_method_id,
    todayTxCount,
    isScammer: false,
  };
}

function sanitizePendingSearchParams(status, params) {
  if (normalizeStatus(status) !== 'Pending') {
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

function isDepositSearchActive(status, params) {
  const normalizedStatus = normalizeStatus(status);
  if (params.keyword?.trim()) return true;
  if (normalizedStatus === 'Pending') return false;
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
      acc.totalDepositAmount += Number(row.deposit_amount) || 0;
      acc.totalPaymentAmount += Number(row.payment_amount) || 0;
      return acc;
    },
    { totalDepositAmount: 0, totalPaymentAmount: 0 },
  );
}

async function listDepositsQuery({
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
  const joins = `
    INNER JOIN users u ON d.user_id = u.id
    INNER JOIN topup_methods tm ON d.topup_method_id = tm.id
    LEFT JOIN payment_options po ON d.payment_option_id = po.id
    LEFT JOIN account_holders ah ON ah.user_id = u.id
  `;

  if (transactionId) {
    conditions.push('d.transaction_id = ?');
    values.push(String(transactionId).trim());
  }
  if (platformId) {
    conditions.push('d.topup_account_id = ?');
    values.push(String(platformId).trim());
  }
  if (amount != null && amount !== '') {
    conditions.push('d.deposit_amount = ?');
    values.push(Number(amount));
  }
  if (userAccount) {
    conditions.push('ah.account_number = ?');
    values.push(String(userAccount).trim());
  }

  if (keyword?.trim()) {
    const like = `%${escapeLike(keyword.trim())}%`;
    const adminColumn =
      normalizedStatus === 'Pending'
        ? 'd.pendings_by_admin'
        : normalizedStatus === 'Completed'
          ? 'd.approved_by_admin'
          : 'd.rejected_by_admin';
    const keywordParts = [
      'd.transaction_id LIKE ? ESCAPE \'\\\\\'',
      'd.topup_account_id LIKE ? ESCAPE \'\\\\\'',
      'u.name LIKE ? ESCAPE \'\\\\\'',
      `EXISTS (
        SELECT 1 FROM account_holders ah_kw
        WHERE ah_kw.user_id = u.id AND ah_kw.account_number LIKE ? ESCAPE '\\\\'
      )`,
    ];
    const keywordValues = [like, like, like, like];

    if (normalizedStatus === 'Pending' || normalizedStatus === 'All') {
      keywordParts.push(
        `EXISTS (
          SELECT 1 FROM users exec
          WHERE exec.id = d.assigned_to AND exec.name LIKE ? ESCAPE '\\\\'
        )`,
      );
      keywordValues.push(like);
    }

    if (normalizedStatus === 'All') {
      keywordParts.push(
        `EXISTS (
          SELECT 1 FROM users admin_user
          WHERE admin_user.id IN (d.pendings_by_admin, d.approved_by_admin, d.rejected_by_admin)
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
      ['d.deposit_amount', 'd.payment_amount'],
      keyword,
      escapeLike,
    );

    conditions.push(`(${keywordParts.join(' OR ')})`);
    values.push(...keywordValues);
  }

  if (dateWindow.from) {
    conditions.push('d.updated_at >= ?');
    values.push(formatTimestampSl(dateWindow.from));
  }
  if (dateWindow.to) {
    conditions.push('d.updated_at < ?');
    values.push(formatTimestampSl(dateWindow.to));
  }

  const whereSql = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const orderSql =
    normalizedStatus === 'Pending' ? 'ORDER BY d.updated_at ASC' : 'ORDER BY d.updated_at DESC';

  const countRows = await query(
    `SELECT COUNT(*) AS total
     FROM deposits d
     ${joins}
     ${whereSql}`,
    values,
  );
  const totalCount = Number(countRows[0]?.total) || 0;
  const totalPages = requestedTake > 0 ? Math.ceil(totalCount / requestedTake) : 1;

  const rows =
    take <= 0
      ? []
      : await query(
          `SELECT d.*, u.name AS user_name, tm.topup_method_name, po.payment_option_name,
            ah.account_number, ah.email AS customer_email, ah.mobile_number AS customer_mobile
     FROM deposits d
     ${joins}
     ${whereSql}
     ${orderSql}
     LIMIT ${take} OFFSET ${skip}`,
          values,
        );

  const adminIds = rows.flatMap((row) => [
    row.pendings_by_admin,
    row.approved_by_admin,
    row.rejected_by_admin,
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

async function getDepositTotals(status, assignedToUserId) {
  const normalizedStatus = normalizeStatus(status);
  const { conditions, values } = buildBaseConditions(
    normalizedStatus === 'All' ? 'Pending' : normalizedStatus,
    assignedToUserId,
  );

  if (normalizedStatus === 'Completed' || normalizedStatus === 'Rejected') {
    const today = parseDateWindow('today');
    conditions.push('d.updated_at >= ?');
    conditions.push('d.updated_at < ?');
    values.push(formatTimestampSl(today.from), formatTimestampSl(today.to));
  }

  const rows = await query(
    `SELECT
       COALESCE(SUM(d.deposit_amount), 0) AS totalDepositAmount,
       COALESCE(SUM(d.payment_amount), 0) AS totalPaymentAmount
     FROM deposits d
     WHERE ${conditions.join(' AND ')}`,
    values,
  );

  return {
    totalDepositAmount: Number(rows[0]?.totalDepositAmount) || 0,
    totalPaymentAmount: Number(rows[0]?.totalPaymentAmount) || 0,
  };
}

export async function listDepositsForAdmin(auth, params = {}) {
  const roles = auth?.roles || [];
  const userId = auth?.userId;
  const isExec = isDepositExecutive(roles) && !isAdmin(roles);
  const statusForTotals = normalizeStatus(params.status);
  const assignedToUserId = statusForTotals === 'Pending' && isExec ? userId : null;
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

  const maxLoadRows =
    statusForTotals === 'Pending' && isExec ? await getUserPendingShowCount(userId) : null;

  const result = await listDepositsQuery({
    status: params.status,
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
  });

  const searchActive = isDepositSearchActive(statusForTotals, {
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
    : await getDepositTotals(
        statusForTotals === 'All' ? 'Pending' : statusForTotals,
        assignedToUserId,
      );

  const scammerFlags = await batchScammerCheck({
    platformIds: result.rows.map((row) => row.topup_account_id),
    userIds: result.rows.map((row) => row.user_id),
  });
  const similarCounts = await batchSimilarDeposits(
    result.rows,
    statusForTotals === 'All' ? 'Pending' : statusForTotals,
  );
  const permissions = auth?.permissions || [];
  const statusScope = await getUserStatusUpdateScope(auth?.userId);

  return {
    deposits: result.rows.map((row) => ({
      ...mapDepositRow(row, result.adminUsers, result.assignedUsers, similarCounts),
      isScammer: isScammerMatch(scammerFlags, {
        platformId: row.topup_account_id,
        userId: row.user_id,
      }),
    })),
    totals,
    pagination: result.pagination,
    isAdmin: isAdmin(roles),
    canMutate: permissions.includes('status_update_deposit_data') || isAdmin(roles),
    allowed_deposit_statuses: statusScope.allowed_deposit_statuses,
  };
}

export async function getDepositByTransactionId(auth, transactionId) {
  if (!transactionId) {
    throw validationError('Transaction id is required.');
  }
  const data = await listDepositsForAdmin(auth, {
    status: 'All',
    transactionId,
    page: 1,
    perPage: 1,
  });
  return data.deposits[0] || null;
}

export async function listSimilarDepositsToday(auth, { depositId, transactionId } = {}) {
  if (!depositId && !transactionId) {
    throw validationError('Deposit id or transaction id is required.');
  }

  const lookupRows = await query(
    depositId
      ? `SELECT d.id, d.transaction_id, d.topup_method_id, d.topup_account_id, d.transaction_status
         FROM deposits d WHERE d.id = ? LIMIT 1`
      : `SELECT d.id, d.transaction_id, d.topup_method_id, d.topup_account_id, d.transaction_status
         FROM deposits d WHERE d.transaction_id = ? LIMIT 1`,
    [depositId || transactionId],
  );
  const source = lookupRows[0];
  if (!source) {
    throw validationError('Deposit not found.', 404);
  }

  if (!source.topup_method_id || !source.topup_account_id) {
    return { deposits: [] };
  }

  const statusSql =
    source.transaction_status === 'Completed'
      ? `d.transaction_status = 'Completed'`
      : `d.transaction_status != 'Rejected'`;
  const since = laravelSimilarCountSinceSql();
  const joins = `
    INNER JOIN users u ON d.user_id = u.id
    INNER JOIN topup_methods tm ON d.topup_method_id = tm.id
    LEFT JOIN payment_options po ON d.payment_option_id = po.id
    LEFT JOIN account_holders ah ON ah.user_id = u.id
  `;

  const rows = await query(
    `SELECT d.*, u.name AS user_name, tm.topup_method_name, po.payment_option_name,
            ah.account_number, ah.email AS customer_email, ah.mobile_number AS customer_mobile
     FROM deposits d
     ${joins}
     WHERE d.payment_proof IS NOT NULL
       AND d.created_at >= ?
       AND d.topup_method_id = ?
       AND d.topup_account_id = ?
       AND ${statusSql}
     ORDER BY d.created_at DESC`,
    [since, source.topup_method_id, source.topup_account_id],
  );

  const adminIds = rows.flatMap((row) => [
    row.pendings_by_admin,
    row.approved_by_admin,
    row.rejected_by_admin,
  ]);
  const assignedIds = rows.map((row) => row.assigned_to).filter(Boolean);
  const [adminUsers, assignedUsers, scammerFlags] = await Promise.all([
    fetchAdminNames(adminIds),
    fetchAdminNames(assignedIds),
    batchScammerCheck({
      platformIds: rows.map((row) => row.topup_account_id),
      userIds: rows.map((row) => row.user_id),
    }),
  ]);

  const count = rows.length;
  const similarCounts = {
    [`${source.topup_method_id}_${source.topup_account_id}`]: count,
  };

  return {
    deposits: rows.map((row) => ({
      ...mapDepositRow(row, adminUsers, assignedUsers, similarCounts),
      isScammer: isScammerMatch(scammerFlags, {
        platformId: row.topup_account_id,
        userId: row.user_id,
      }),
    })),
  };
}
