import { query } from '../config/database.js';
import { buildWithdrawalProofApiUrl } from './withdrawalProofStorage.service.js';
import { batchScammerCheck, isScammerMatch } from './scammer.service.js';
import { getUserPendingShowCount } from './systemUser.service.js';
import {
  formatTimestampSl,
  getBusinessDayStart,
  parseDateWindow,
} from '../utils/slTime.js';

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

  const accountType = row.selected_account_type || details.account_type || '';
  const accountId = details.account_id || details.account_number || '';

  switch (accountType) {
    case 'bank':
      return [details.bank_name, accountId, details.account_name].filter(Boolean).join(' · ') || accountId || '—';
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
  if (['Pending', 'Completed', 'Rejected', 'All'].includes(value)) return value;
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

  if (assignedToUserId != null && status === 'Pending') {
    conditions.push('w.assigned_to = ?');
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

  const dayStart = getBusinessDayStart();
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
    [dayStart, ...pairValues],
  );

  const result = {};
  for (const row of countRows) {
    result[`${row.cashout_method_id}_${row.cashout_account_id}`] = Number(row.cnt) || 0;
  }
  return result;
}

function mapWithdrawalRow(row, adminUsers, assignedUsers, similarCounts) {
  const cashoutAmount = Number(row.cashout_amount) || 0;
  const receivingAmount = Number(row.receiving_amount) || 0;
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
  const simKey = `${row.cashout_method_id}_${row.cashout_account_id}`;
  const todayTxCount = similarCounts[simKey] || 0;

  return {
    id: row.transaction_id,
    withdrawalId: row.id,
    date: formatTimestampSl(row.updated_at),
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
    status: row.transaction_status,
    account: formatWithdrawalAccount(row),
    assigned: assignedName,
    assignedToId: row.assigned_to,
    admin: adminName,
    proof: Boolean(row.cashout_payment_proof),
    proofUrl: buildWithdrawalProofApiUrl(row.cashout_payment_proof),
    proofFileName: row.cashout_payment_proof || null,
    rejectReason:
      row.transaction_status === 'Rejected'
        ? [row.rejected_reason, row.rejected_reason_message].filter(Boolean).join(' — ') || null
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
    requirePaymentProof: !keyword,
  };
}

function isWithdrawalSearchActive(status, params) {
  const normalizedStatus = normalizeStatus(status);
  if (params.keyword?.trim()) return true;
  if (normalizedStatus === 'Pending') return false;

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
  const joins = `
    INNER JOIN users u ON w.user_id = u.id
    INNER JOIN cashout_methods cm ON w.cashout_method_id = cm.id
    LEFT JOIN payment_options po ON w.receiving_payment_option_id = po.id
    LEFT JOIN account_holders ah ON ah.user_id = u.id
  `;

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
    conditions.push('ah.account_number = ?');
    values.push(String(userAccount).trim());
  }

  if (keyword?.trim()) {
    const like = `%${escapeLike(keyword.trim())}%`;
    const adminColumn =
      normalizedStatus === 'Pending'
        ? 'w.pendings_by_admin'
        : normalizedStatus === 'Completed'
          ? 'w.approved_by_admin'
          : 'w.rejected_by_admin';
    const keywordParts = [
      'w.transaction_id LIKE ? ESCAPE \'\\\\\'',
      'w.cashout_account_id LIKE ? ESCAPE \'\\\\\'',
      'u.name LIKE ? ESCAPE \'\\\\\'',
      `EXISTS (
        SELECT 1 FROM account_holders ah_kw
        WHERE ah_kw.user_id = u.id AND ah_kw.account_number LIKE ? ESCAPE '\\\\'
      )`,
    ];
    const keywordValues = [like, like, like, like];

    if (normalizedStatus === 'Pending') {
      keywordParts.push(
        `EXISTS (
          SELECT 1 FROM users exec
          WHERE exec.id = w.assigned_to AND exec.name LIKE ? ESCAPE '\\\\'
        )`,
      );
      keywordValues.push(like);
    }

    keywordParts.push(
      `EXISTS (
        SELECT 1 FROM users admin_user
        WHERE admin_user.id = ${adminColumn}
          AND admin_user.name LIKE ? ESCAPE '\\\\'
      )`,
    );
    keywordValues.push(like);

    conditions.push(`(${keywordParts.join(' OR ')})`);
    values.push(...keywordValues);
  }

  if (dateWindow.from) {
    conditions.push('w.updated_at >= ?');
    values.push(dateWindow.from);
  }
  if (dateWindow.to) {
    conditions.push('w.updated_at < ?');
    values.push(dateWindow.to);
  }

  const whereSql = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const orderSql =
    normalizedStatus === 'Pending' ? 'ORDER BY w.updated_at ASC' : 'ORDER BY w.updated_at DESC';

  const countRows = await query(
    `SELECT COUNT(*) AS total
     FROM withdrawals w
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
          `SELECT w.*, u.name AS user_name, cm.cashout_method_name, po.payment_option_name AS receiving_payment_option_name,
            ah.account_number, ah.email AS customer_email, ah.mobile_number AS customer_mobile
     FROM withdrawals w
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
    values.push(today.from, today.to);
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
  const roles = auth?.roles || [];
  const permissions = auth?.permissions || [];
  const userId = auth?.userId;
  const isExec = isWithdrawalExecutive(roles) && !isAdmin(roles);

  const statusForTotals = normalizeStatus(params.status);
  const assignedToUserId =
    statusForTotals === 'Pending' && isExec ? userId : null;
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

  const result = await listWithdrawalsQuery({
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

  const [scammerFlags, similarCounts] = await Promise.all([
    batchScammerCheck({
      platformIds: result.rows.map((row) => row.cashout_account_id),
      userIds: result.rows.map((row) => row.user_id),
    }),
    batchSimilarWithdrawals(result.rows, statusForTotals === 'All' ? 'Pending' : statusForTotals),
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
    canMutate: permissions.includes('status_update_withdrawal_data') || isAdmin(roles),
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
  const dayStart = getBusinessDayStart();

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
    [dayStart, source.cashout_method_id, source.cashout_account_id],
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
