import { query } from '../config/database.js';
import { env } from '../config/env.js';
import {
  findAccountHolderByUserId,
  isAccountBanned,
  needsVerification,
} from './accountHolder.service.js';
import { queueSmsMessage } from './notification.service.js';
import {
  getTierProgressPercentage,
  getUserPointLevel,
  updateUserPointLevel,
} from './pointEarning.service.js';

const POINT_DIVIDER = env.loyalty.pointDivider;
const MIN_POINTS = env.loyalty.minimumPoints;
const STANDARD_USD = env.loyalty.standardUsdPerBlock;
const PARTNER_USD = env.loyalty.partnerUsdPerBlock;
const STARTER_TX_ID = env.loyalty.starterWithdrawalTransactionId;

function validationError(message, status = 422) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function formatYmdHis(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return '—';
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${d} ${hh}:${mm}`;
}

function formatYmd(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return '';
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function mapUserStatus(status) {
  if (status === 'Approved') return 'Completed';
  return status || 'Pending';
}

function mapAdminStatus(status) {
  if (status === 'Completed') return 'Approved';
  return status;
}

function displayTransactionId(rowId) {
  return String(STARTER_TX_ID + Number(rowId || 0));
}

async function assertLoyaltyAccess(userId) {
  const accountHolder = await findAccountHolderByUserId(userId);
  if (!accountHolder) {
    throw validationError('Account holder not found.', 404);
  }
  if (isAccountBanned(accountHolder)) {
    throw validationError('Your account has been banned. Please contact support.', 403);
  }
  if (needsVerification(accountHolder)) {
    const error = validationError('Complete account verification before using loyalty features.');
    error.code = 'VERIFICATION_REQUIRED';
    throw error;
  }
  return accountHolder;
}

async function getPointTotals(userId) {
  const [earnedRows, withdrawnRows] = await Promise.all([
    query(
      `SELECT COALESCE(SUM(point_earning_amount), 0) AS total
       FROM point_earnings
       WHERE user_id = ?`,
      [userId],
    ),
    query(
      `SELECT COALESCE(SUM(point_withdrawal_amount), 0) AS total
       FROM point_withdrawals
       WHERE user_id = ?
         AND (status IS NULL OR status != 'Rejected')`,
      [userId],
    ),
  ]);

  const earned = Number(earnedRows[0]?.total || 0);
  const withdrawn = Number(withdrawnRows[0]?.total || 0);

  return {
    earned,
    withdrawn,
    remaining: Math.floor(earned - withdrawn),
  };
}

async function getEarnedForYear(userId) {
  const rows = await query(
    `SELECT COALESCE(SUM(point_earning_amount), 0) AS total
     FROM point_earnings
     WHERE user_id = ?
       AND created_at >= DATE_SUB(NOW(), INTERVAL 1 YEAR)`,
    [userId],
  );
  return Number(rows[0]?.total || 0);
}

function buildRateLabel(isPartner) {
  const usd = isPartner ? PARTNER_USD : STANDARD_USD;
  return `($) ${POINT_DIVIDER.toLocaleString()} Trust Points = ${usd} USD`;
}

async function getLatestPointWithdrawalRate(paymentOptionName) {
  const rows = await query(
    `SELECT pwr.rate
     FROM point_withdrawal_rates pwr
     INNER JOIN payment_options po ON po.id = pwr.payment_option_id
     WHERE po.payment_option_name = ?
     ORDER BY pwr.applicable_date DESC, pwr.id DESC
     LIMIT 1`,
    [paymentOptionName],
  );
  return Number(rows[0]?.rate || 1);
}

async function accountExistsForUser(userId, accountType, accountId) {
  const type = String(accountType || '').trim().toUpperCase();
  const id = Number(accountId);
  if (!type || !Number.isInteger(id)) return false;

  const tableByType = {
    XM: 'user_xm_accounts',
    SKRILL: 'user_skrill_accounts',
    NETELLER: 'user_neteller_accounts',
    'PERFECT MONEY': 'user_perfect_money_accounts',
    'BANK TRANSFER': 'user_bank_accounts',
    'CARD PAYMENT': 'user_card_payment_accounts',
    CRYPTO: 'user_crypto_accounts',
  };

  const table = tableByType[type];
  if (!table) return false;

  const rows = await query(
    `SELECT id
     FROM ${table}
     WHERE user_id = ?
       AND id = ?
       AND (is_deleted = 0 OR is_deleted IS NULL OR is_deleted = FALSE)
     LIMIT 1`,
    [userId, id],
  );
  return Boolean(rows[0]);
}

function allocateAffiliateCode(length = 8) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < length; i += 1) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return code;
}

async function ensureAffiliateCode(userId, accountHolder) {
  if (accountHolder.affiliate_code) return accountHolder.affiliate_code;

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const code = allocateAffiliateCode();
    const rows = await query(
      `SELECT id FROM account_holders WHERE affiliate_code = ? LIMIT 1`,
      [code],
    );
    if (!rows[0]) {
      await query(
        `UPDATE account_holders SET affiliate_code = ?, updated_at = NOW() WHERE user_id = ?`,
        [code, userId],
      );
      return code;
    }
  }
  return null;
}

async function notifyStaffLoyaltyWithdrawal(transactionId) {
  const message = `Loyalty Point Withdraw request has been added: ${transactionId}. Please review. Thanks`;
  await Promise.all(
    env.loyalty.staffAlertNumbers.map((msisdn) =>
      queueSmsMessage({
        message,
        msisdn,
        smsType: 'LOYALTY_WITHDRAWAL',
      }).catch(() => null),
    ),
  );
}

function resolveFilterDates(filterTemplate, fromDate, toDate) {
  const template = String(filterTemplate || '').trim().toUpperCase();
  const today = new Date();
  const end = formatYmd(today);

  if (template === 'LAST_7_DAYS' || template === 'WEEKLY') {
    const from = new Date(today);
    from.setDate(from.getDate() - 7);
    return { fromDate: formatYmd(from), toDate: end };
  }
  if (template === 'LAST_MONTH' || template === 'MONTHLY') {
    const from = new Date(today);
    from.setMonth(from.getMonth() - 1);
    return { fromDate: formatYmd(from), toDate: end };
  }

  return {
    fromDate: fromDate ? String(fromDate).slice(0, 10) : null,
    toDate: toDate ? String(toDate).slice(0, 10) : null,
  };
}

export async function getUserLoyaltySummary(userId) {
  const accountHolder = await assertLoyaltyAccess(userId);
  const totals = await getPointTotals(userId);
  const earnedForYear = await getEarnedForYear(userId);
  const isPartner = accountHolder.is_patner === 'YES';

  await updateUserPointLevel(userId);
  const pointLevelDetails = await getUserPointLevel(userId);

  let level = 1;
  let percentage = 0;

  if (pointLevelDetails) {
    level = Number(pointLevelDetails.point_level_id) || 1;
    if (isPartner) {
      percentage = getTierProgressPercentage(level, earnedForYear);
    } else if (totals.remaining >= MIN_POINTS) {
      percentage = 100;
    } else {
      percentage = Math.round((totals.remaining / MIN_POINTS) * 100);
    }
  } else if (isPartner) {
    percentage = getTierProgressPercentage(1, earnedForYear);
  } else if (earnedForYear >= MIN_POINTS) {
    percentage = 100;
  } else {
    percentage = Math.round((earnedForYear / MIN_POINTS) * 100);
  }

  const usdPerBlock = isPartner ? PARTNER_USD : STANDARD_USD;

  return {
    point_summary: {
      earned: totals.earned,
      withdrawn: totals.withdrawn,
      remaining: totals.remaining,
      earned_for_year: earnedForYear,
      level,
      percentage,
    },
    is_partner: isPartner,
    rate_label: buildRateLabel(isPartner),
    usd_value_of_earned: Number(((totals.earned / POINT_DIVIDER) * usdPerBlock).toFixed(2)),
    minimum_points: MIN_POINTS,
    point_divider: POINT_DIVIDER,
    usd_per_block: usdPerBlock,
  };
}

export async function createUserLoyaltyWithdrawal(userId, payload = {}) {
  const accountHolder = await assertLoyaltyAccess(userId);
  const points = Number(payload.withdrawal_point_amount ?? payload.points);
  const accountId = payload.selected_account_id ?? payload.account_id;
  const accountType = String(
    payload.selected_account_type ?? payload.account_type ?? '',
  )
    .trim()
    .toUpperCase();

  if (!Number.isFinite(points) || points <= 0) {
    throw validationError('Withdrawal point amount is required.');
  }
  if (!accountId) {
    throw validationError('Receiving account is required.');
  }
  if (!accountType) {
    throw validationError('Payment option is required.');
  }

  const totals = await getPointTotals(userId);
  if (totals.remaining < MIN_POINTS) {
    throw validationError(
      `Minimum of ${MIN_POINTS.toLocaleString()} loyalty points required to make a withdrawal request.`,
    );
  }
  if (points < MIN_POINTS) {
    throw validationError(`Minimum of ${MIN_POINTS.toLocaleString()} points has to be withdrawn.`);
  }
  if (points > totals.remaining) {
    throw validationError(
      `You cannot withdraw an amount exceeding your existing point balance. Your point balance is ${totals.remaining}.`,
    );
  }

  const accountValid = await accountExistsForUser(userId, accountType, accountId);
  if (!accountValid) {
    throw validationError('Selected receiving account was not found.');
  }

  const rate = await getLatestPointWithdrawalRate(accountType);
  const isPartner = accountHolder.is_patner === 'YES';
  const usdPerBlock = isPartner ? PARTNER_USD : STANDARD_USD;
  const cashoutAmount = (points / POINT_DIVIDER) * usdPerBlock;
  const accountCurrencyAmount = cashoutAmount * rate;

  const insert = await query(
    `INSERT INTO point_withdrawals
      (user_id, point_withdrawal_amount, cashout_amount, account_currency_amount, point_divider,
       payment_option, account_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'Pending', NOW(), NOW())`,
    [
      userId,
      points,
      cashoutAmount,
      accountCurrencyAmount,
      POINT_DIVIDER,
      accountType,
      accountId,
    ],
  );

  const withdrawalId = insert.insertId;
  const transactionId = displayTransactionId(withdrawalId);

  await ensureAffiliateCode(userId, accountHolder);
  await notifyStaffLoyaltyWithdrawal(transactionId);

  const updatedTotals = await getPointTotals(userId);

  return {
    ok: true,
    error: false,
    message:
      'Withdrawal request has been submitted successfully. This process may take up to 24 hours.',
    transaction_id: transactionId,
    remaining_points: updatedTotals.remaining,
    withdrawal: mapUserWithdrawalRow({
      id: withdrawalId,
      point_withdrawal_amount: points,
      cashout_amount: cashoutAmount,
      account_currency_amount: accountCurrencyAmount,
      payment_option: accountType,
      account_id: accountId,
      status: 'Pending',
      created_at: new Date(),
      updated_at: new Date(),
    }),
  };
}

function mapUserWithdrawalRow(row) {
  const points = Number(row.point_withdrawal_amount || 0);
  const cashout = Number(row.cashout_amount || 0);
  const received = Number(row.account_currency_amount || 0);

  return {
    id: displayTransactionId(row.id),
    withdrawal_id: row.id,
    points,
    points_display: points.toLocaleString(),
    amount: `USD ${cashout.toFixed(2)}`,
    received_amount: received.toFixed(2),
    payment_option: row.payment_option,
    account_id: row.account_id,
    status: mapUserStatus(row.status),
    date: formatYmd(row.created_at),
    datetime: formatYmdHis(row.created_at),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function listUserLoyaltyWithdrawals(userId, params = {}) {
  await assertLoyaltyAccess(userId);

  const page = Math.max(1, Number(params.page) || 1);
  const perPage = Math.min(50, Math.max(1, Number(params.per_page) || 10));
  const offset = (page - 1) * perPage;
  const status = params.status && params.status !== 'All Statuses' ? mapAdminStatus(params.status) : null;
  const search = String(params.search ?? params.q ?? '').trim();
  const { fromDate, toDate } = resolveFilterDates(
    params.filter_template ?? params.filterTemplate,
    params.from_date ?? params.fromDate,
    params.to_date ?? params.toDate,
  );

  let sql = `SELECT *
             FROM point_withdrawals
             WHERE user_id = ?`;
  const values = [userId];

  if (status) {
    sql += ` AND status = ?`;
    values.push(status);
  }
  if (fromDate) {
    sql += ` AND DATE(created_at) >= ?`;
    values.push(fromDate);
  }
  if (toDate) {
    sql += ` AND DATE(created_at) <= ?`;
    values.push(toDate);
  }
  if (search) {
    const term = `%${search}%`;
    sql += ` AND (
      CAST(id AS CHAR) LIKE ? OR
      CAST(point_withdrawal_amount AS CHAR) LIKE ? OR
      CAST(cashout_amount AS CHAR) LIKE ? OR
      payment_option LIKE ? OR
      status LIKE ?
    )`;
    values.push(term, term, term, term, term);
  }

  const countRows = await query(`SELECT COUNT(*) AS total FROM (${sql}) AS loyalty_list`, values);
  const total = Number(countRows[0]?.total || 0);

  const rows = await query(`${sql} ORDER BY updated_at DESC LIMIT ? OFFSET ?`, [
    ...values,
    perPage,
    offset,
  ]);

  return {
    transactions: rows.map(mapUserWithdrawalRow),
    pagination: {
      page,
      per_page: perPage,
      total,
      total_pages: Math.max(1, Math.ceil(total / perPage)),
    },
  };
}

function buildAdminDateFilter(filter, fromDate, toDate) {
  const normalized = String(filter || '').trim().toLowerCase();
  const today = new Date();
  const end = formatYmd(today);

  switch (normalized) {
    case 'today':
      return { fromDate: end, toDate: end };
    case 'yesterday': {
      const y = new Date(today);
      y.setDate(y.getDate() - 1);
      const day = formatYmd(y);
      return { fromDate: day, toDate: day };
    }
    case 'last7days': {
      const from = new Date(today);
      from.setDate(from.getDate() - 7);
      return { fromDate: formatYmd(from), toDate: end };
    }
    case 'lastmonth': {
      const from = new Date(today);
      from.setMonth(from.getMonth() - 1);
      return { fromDate: formatYmd(from), toDate: end };
    }
    case 'last6months': {
      const from = new Date(today);
      from.setMonth(from.getMonth() - 6);
      return { fromDate: formatYmd(from), toDate: end };
    }
    case 'currentyear':
      return { fromDate: `${today.getFullYear()}-01-01`, toDate: end };
    case 'lastyear':
      return {
        fromDate: `${today.getFullYear() - 1}-01-01`,
        toDate: `${today.getFullYear() - 1}-12-31`,
      };
    case 'customdate':
      return {
        fromDate: fromDate ? String(fromDate).slice(0, 10) : null,
        toDate: toDate ? String(toDate).slice(0, 10) : null,
      };
    default:
      return { fromDate: null, toDate: null };
  }
}

async function loadAccountDisplay(userId, paymentOption, accountId) {
  const type = String(paymentOption || '').trim().toUpperCase();
  const id = Number(accountId);
  if (!Number.isInteger(id)) {
    return { platform: '—', platformId: '—', platformName: null, platformDetail: '—' };
  }

  const queries = {
    XM: `SELECT xm_account_id AS value FROM user_xm_accounts WHERE user_id = ? AND id = ? LIMIT 1`,
    SKRILL: `SELECT skrill_email AS value FROM user_skrill_accounts WHERE user_id = ? AND id = ? LIMIT 1`,
    NETELLER: `SELECT neteller_email AS value FROM user_neteller_accounts WHERE user_id = ? AND id = ? LIMIT 1`,
    'PERFECT MONEY': `SELECT pm_account_id AS value FROM user_perfect_money_accounts WHERE user_id = ? AND id = ? LIMIT 1`,
    'BANK TRANSFER': `SELECT bank, account_number, beneficiary_name, branch FROM user_bank_accounts WHERE user_id = ? AND id = ? LIMIT 1`,
    'CARD PAYMENT': `SELECT bank, bank_account_number, beneficiary_name, branch FROM user_card_payment_accounts WHERE user_id = ? AND id = ? LIMIT 1`,
    CRYPTO: `SELECT crypto_account_id AS value FROM user_crypto_accounts WHERE user_id = ? AND id = ? LIMIT 1`,
  };

  const sql = queries[type];
  if (!sql) return { platform: type || '—', platformId: '—', platformName: null, platformDetail: '—' };

  const rows = await query(sql, [userId, id]);
  const row = rows[0];
  if (!row) return { platform: type || '—', platformId: '—', platformName: null, platformDetail: '—' };

  if (type === 'BANK TRANSFER' || type === 'CARD PAYMENT') {
    const accountNumber = row.account_number || row.bank_account_number;
    const beneficiaryName = row.beneficiary_name || '—';
    return {
      platform: row.bank || type,
      platformId: accountNumber || '—',
      platformName: beneficiaryName !== '—' ? beneficiaryName : null,
      platformDetail: `${accountNumber || '—'} · ${beneficiaryName}`,
    };
  }

  const accountValue = row.value || '—';
  return {
    platform: type,
    platformId: accountValue,
    platformName: null,
    platformDetail: accountValue,
  };
}

function mapAdminWithdrawalRow(row, accountDisplay) {
  const points = Number(row.point_withdrawal_amount || 0);
  const cashout = Number(row.cashout_amount || 0);
  const received = Number(row.account_currency_amount || 0);

  return {
    id: displayTransactionId(row.id),
    withdrawal_id: row.id,
    date: formatYmdHis(row.created_at),
    userId: row.account_number || `U-${row.user_id}`,
    customer: row.customer_name || '—',
    email: row.email || '—',
    points: points.toFixed(2),
    amount: `LKR ${received.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    amountUsd: `USD ${cashout.toFixed(2)}`,
    method: row.payment_option || '—',
    received: `LKR ${received.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    platform: accountDisplay.platform,
    platformId: accountDisplay.platformId,
    platformName: accountDisplay.platformName,
    platformDetail: accountDisplay.platformDetail,
    status: mapUserStatus(row.status),
    raw_status: row.status,
  };
}

export async function listLoyaltyOrdersForAdmin(params = {}) {
  const page = Math.max(1, Number(params.page) || 1);
  const perPage = Math.min(50, Math.max(1, Number(params.per_page) || 20));
  const offset = (page - 1) * perPage;
  const statusInput = params.status || 'Pending';
  const status = mapAdminStatus(statusInput);
  const keyword = String(params.keyword ?? params.q ?? '').trim();
  const { fromDate, toDate } = buildAdminDateFilter(
    params.filter ?? params.duration,
    params.from_date ?? params.fromDate,
    params.to_date ?? params.toDate,
  );

  let sql = `SELECT pw.*, ah.account_number, ah.first_name, ah.last_name, ah.email,
                    CONCAT(ah.first_name, ' ', ah.last_name) AS customer_name
             FROM point_withdrawals pw
             INNER JOIN account_holders ah ON ah.user_id = pw.user_id
             WHERE 1=1`;
  const values = [];

  if (status !== 'All') {
    sql += ` AND pw.status = ?`;
    values.push(status);
  }

  if (fromDate) {
    sql += ` AND DATE(pw.created_at) >= ?`;
    values.push(fromDate);
  }
  if (toDate) {
    sql += ` AND DATE(pw.created_at) <= ?`;
    values.push(toDate);
  }
  if (keyword) {
    const term = `%${keyword}%`;
    sql += ` AND (
      CAST(pw.id AS CHAR) LIKE ? OR
      ah.account_number LIKE ? OR
      ah.first_name LIKE ? OR
      ah.last_name LIKE ? OR
      ah.email LIKE ? OR
      pw.payment_option LIKE ?
    )`;
    values.push(term, term, term, term, term, term);
  }

  const countRows = await query(`SELECT COUNT(*) AS total FROM (${sql}) AS loyalty_orders`, values);
  const total = Number(countRows[0]?.total || 0);

  const rows = await query(`${sql} ORDER BY pw.created_at DESC LIMIT ? OFFSET ?`, [
    ...values,
    perPage,
    offset,
  ]);

  const orders = [];
  for (const row of rows) {
    const accountDisplay = await loadAccountDisplay(row.user_id, row.payment_option, row.account_id);
    orders.push(mapAdminWithdrawalRow(row, accountDisplay));
  }

  return {
    orders,
    pagination: {
      page,
      per_page: perPage,
      total,
      total_pages: Math.max(1, Math.ceil(total / perPage)),
    },
    starter_transaction_id: STARTER_TX_ID,
  };
}

export async function updateLoyaltyOrderStatus(adminUserId, payload = {}) {
  const transactionId = Number(payload.transaction_id ?? payload.transactionId);
  const nextStatus = mapAdminStatus(payload.withdrawal_request_status ?? payload.status);

  if (!Number.isInteger(transactionId)) {
    throw validationError('Transaction id is required.');
  }
  if (!['Pending', 'Approved', 'Rejected'].includes(nextStatus)) {
    throw validationError('Invalid loyalty order status.');
  }

  const withdrawalId = transactionId - STARTER_TX_ID;
  const rows = await query(`SELECT * FROM point_withdrawals WHERE id = ? LIMIT 1`, [withdrawalId]);
  const withdrawal = rows[0];
  if (!withdrawal) {
    throw validationError(`Invalid point withdrawal transaction id: ${transactionId}`);
  }

  if (nextStatus === 'Pending') {
    await query(
      `UPDATE point_withdrawals
       SET status = ?, pendings_by_admin = ?, updated_at = NOW()
       WHERE id = ?`,
      [nextStatus, adminUserId, withdrawalId],
    );
    await query(
      `INSERT INTO system_user_action_logs (system_user_action_id, admin_user_id, created_at, updated_at)
       VALUES (40, ?, NOW(), NOW())`,
      [adminUserId],
    );
  } else if (nextStatus === 'Approved') {
    await query(
      `UPDATE point_withdrawals
       SET status = ?, approved_by_admin = ?, withdrawn_at = NOW(), updated_at = NOW()
       WHERE id = ?`,
      [nextStatus, adminUserId, withdrawalId],
    );
    await query(
      `INSERT INTO system_user_action_logs (system_user_action_id, admin_user_id, created_at, updated_at)
       VALUES (41, ?, NOW(), NOW())`,
      [adminUserId],
    );
  } else {
    await query(
      `UPDATE point_withdrawals
       SET status = ?, rejected_by_admin = ?, updated_at = NOW()
       WHERE id = ?`,
      [nextStatus, adminUserId, withdrawalId],
    );
    await query(
      `INSERT INTO system_user_action_logs (system_user_action_id, admin_user_id, created_at, updated_at)
       VALUES (42, ?, NOW(), NOW())`,
      [adminUserId],
    );
  }

  return {
    ok: true,
    error: false,
    message: 'Successfully updated the point withdrawal request state',
    status: mapUserStatus(nextStatus),
  };
}
