import { query } from '../config/database.js';
import {
  findAccountHolderByUserId,
  isAccountBanned,
  needsVerification,
} from './accountHolder.service.js';
import { autoAssignDeposit } from './depositAssignment.service.js';
import { storeDepositProof } from './depositProofStorage.service.js';
import { bumpAdminNavCounts } from './adminNavCountsRevision.service.js';
import { resolveWalletLogoPublicUrl } from './walletLogoStorage.service.js';
import { ensureWalletNavigateSchema } from './wallet.service.js';
import {
  formatDateTimeParts,
  nowSqlDateTime,
  resolveFilterDateRange,
} from '../utils/slTime.js';
import {
  attachPendingCounts,
  assertDepositMethodPendingLimit,
  getOpenDepositCountsByMethod,
} from './pendingMethodLimit.service.js';

function validationError(message, status = 422) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function generateTransactionId(userId) {
  const paddedUserId = String(userId).padStart(2, '0');
  const randomDigits = 12 - paddedUserId.length;
  const max = 10 ** randomDigits - 1;
  const randomPart = String(Math.floor(Math.random() * (max + 1))).padStart(randomDigits, '0');
  return `${paddedUserId}${randomPart}`;
}

async function assertDepositAccess(userId) {
  const accountHolder = await findAccountHolderByUserId(userId);
  if (!accountHolder) {
    throw validationError('Account holder not found.', 404);
  }
  if (isAccountBanned(accountHolder)) {
    throw validationError('Your account has been banned. Please contact support.', 403);
  }
  if (needsVerification(accountHolder)) {
    const error = validationError('Complete account verification before making a deposit.');
    error.code = 'VERIFICATION_REQUIRED';
    throw error;
  }
  return accountHolder;
}

function mapTopupMethodRow(row) {
  const platformTypeRaw = row.platform_id_type || row.topup_method_id_type || '';
  const platformTypes = String(platformTypeRaw)
    .split(/[,|]/)
    .map((item) => item.trim())
    .filter(Boolean);
  const allowNavigateButton = Boolean(Number(row.allow_navigate_button));
  const navigateUrl = allowNavigateButton ? String(row.navigate_url || '').trim() || null : null;
  const navigateButtonLabel = allowNavigateButton
    ? String(row.navigate_button_label || '').trim() || null
    : null;

  return {
    id: row.id,
    name: row.topup_method_name,
    currency: row.topup_method_currency || 'USD',
    platformType: platformTypes.join(',') || platformTypeRaw,
    platformTypes,
    minLimit: Number(row.minimum_limit ?? 0),
    maxLimit: Number(row.maximum_limit ?? 0),
    terms: row.tnc || '',
    logoUrl: resolveWalletLogoPublicUrl(row.topup_method_logo),
    allowNavigateButton,
    allow_navigate_button: allowNavigateButton,
    navigateUrl,
    navigate_url: navigateUrl,
    navigateButtonLabel,
    navigate_button_label: navigateButtonLabel,
  };
}

function mapPaymentOptionRow(row) {
  return {
    id: row.id,
    name: row.payment_option_name,
    currency: row.payment_option_currency,
    priority: row.priority === 'YES',
  };
}

async function loadTopupMethods() {
  await ensureWalletNavigateSchema();
  const rows = await query(
    `SELECT tm.*
     FROM topup_methods tm
     WHERE UPPER(tm.availability) = 'AVAILABLE'
       AND (tm.is_deleted = 0 OR tm.is_deleted IS NULL)
       AND EXISTS (
         SELECT 1
         FROM deposit_rates dr
         WHERE dr.topup_method_id = tm.id
           AND (dr.is_deleted = 0 OR dr.is_deleted IS NULL)
       )
     ORDER BY tm.id ASC`,
  );
  return rows.map(mapTopupMethodRow);
}

async function loadRecentDepositAmounts(userId) {
  const rows = await query(
    `SELECT deposit_amount
     FROM deposits
     WHERE user_id = ?
     ORDER BY created_at DESC
     LIMIT 30`,
    [userId],
  );
  const seen = new Set();
  const amounts = [];
  for (const row of rows) {
    const value = Number(row.deposit_amount);
    if (!Number.isFinite(value)) continue;
    const key = value.toFixed(2);
    if (seen.has(key)) continue;
    seen.add(key);
    amounts.push(key);
    if (amounts.length >= 5) break;
  }
  return amounts;
}

async function loadDepositRatesForMethod(topupMethodId) {
  const rows = await query(
    `SELECT dr.id, dr.topup_method_id, dr.payment_option_id, dr.rate, dr.applicable_date,
            po.payment_option_name, po.payment_option_currency, po.priority, po.availability
     FROM deposit_rates dr
     INNER JOIN payment_options po ON po.id = dr.payment_option_id
     INNER JOIN topup_methods tm ON tm.id = dr.topup_method_id
     WHERE dr.topup_method_id = ?
       AND (dr.is_deleted = 0 OR dr.is_deleted IS NULL)
       AND UPPER(tm.availability) = 'AVAILABLE'
       AND UPPER(po.availability) = 'AVAILABLE'
       AND (po.is_deleted = 0 OR po.is_deleted IS NULL)
     ORDER BY dr.id DESC`,
    [topupMethodId],
  );

  const latestByKey = new Map();
  for (const row of rows) {
    const key = String(row.payment_option_id);
    if (!latestByKey.has(key)) {
      latestByKey.set(key, {
        id: row.id,
        topupMethodId: row.topup_method_id,
        paymentOptionId: row.payment_option_id,
        rate: Number(row.rate),
        applicableDate: row.applicable_date,
        paymentOptionName: row.payment_option_name,
        paymentOptionCurrency: row.payment_option_currency,
      });
    }
  }
  return Array.from(latestByKey.values());
}

async function loadPriorityDepositRate(topupMethodId) {
  const rows = await query(
    `SELECT dr.id, dr.rate, dr.payment_option_id, po.payment_option_currency, po.payment_option_name
     FROM deposit_rates dr
     INNER JOIN payment_options po ON po.id = dr.payment_option_id
     INNER JOIN topup_methods tm ON tm.id = dr.topup_method_id
     WHERE dr.topup_method_id = ?
       AND (dr.is_deleted = 0 OR dr.is_deleted IS NULL)
       AND UPPER(tm.availability) = 'AVAILABLE'
       AND UPPER(po.availability) = 'AVAILABLE'
       AND po.priority = 'YES'
       AND (po.is_deleted = 0 OR po.is_deleted IS NULL)
     ORDER BY dr.id DESC
     LIMIT 1`,
    [topupMethodId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    rate: Number(row.rate),
    paymentOptionId: row.payment_option_id,
    paymentOptionCurrency: row.payment_option_currency,
    paymentOptionName: row.payment_option_name,
  };
}

async function loadSupportedPaymentOptions(topupMethodId, topupMethodName) {
  const rows = await query(
    `SELECT po.id, po.payment_option_name, po.payment_option_currency, po.priority
     FROM wallet_supported_payment_options wspo
     INNER JOIN payment_options po ON po.id = wspo.payment_option_id
     WHERE wspo.wallet_id = ?
       AND wspo.wallet_type = 'topup'
       AND UPPER(wspo.status) = 'ACTIVE'
       AND UPPER(po.availability) = 'AVAILABLE'
       AND (po.is_deleted = 0 OR po.is_deleted IS NULL)
     ORDER BY po.id ASC`,
    [topupMethodId],
  );

  const methodName = String(topupMethodName || '').trim().toLowerCase();
  return rows
    .filter((row) => String(row.payment_option_name || '').trim().toLowerCase() !== methodName)
    .map(mapPaymentOptionRow);
}

async function getTopupMethodById(topupMethodId) {
  const rows = await query(
    `SELECT *
     FROM topup_methods
     WHERE id = ?
       AND UPPER(availability) = 'AVAILABLE'
       AND (is_deleted = 0 OR is_deleted IS NULL)
     LIMIT 1`,
    [topupMethodId],
  );
  return rows[0] ? mapTopupMethodRow(rows[0]) : null;
}

async function loadPaymentAccounts(paymentOptionName) {
  const name = String(paymentOptionName || '').trim().toLowerCase();

  if (name === 'bank transfer') {
    const rows = await query(
      `SELECT id, bank_account_number, beneficiary_name, bank, branch
       FROM admin_bank_accounts
       WHERE status = 'AVAILABLE' AND (is_deleted = 0 OR is_deleted IS NULL)
       ORDER BY id ASC`,
    );
    return {
      type: 'bank_transfer',
      accounts: rows.map((row) => ({
        id: row.id,
        accountNumber: row.bank_account_number,
        name: row.beneficiary_name,
        bank: row.bank,
        branch: row.branch,
      })),
    };
  }

  if (name === 'crypto' || name === 'binance') {
    const rows = await query(
      `SELECT id, trc20_wallet_address, binance_email
       FROM admin_binance_accounts
       WHERE status = 'AVAILABLE' AND (is_deleted = 0 OR is_deleted IS NULL)
       ORDER BY id ASC`,
    );
    return {
      type: 'binance',
      accounts: rows.map((row) => ({
        id: row.id,
        trc20WalletAddress: row.trc20_wallet_address,
        binanceEmail: row.binance_email,
      })),
    };
  }

  if (name === 'xm') {
    const rows = await query(
      `SELECT id, xm_account_id
       FROM admin_xm_accounts
       WHERE status = 'AVAILABLE' AND (is_deleted = 0 OR is_deleted IS NULL)
       ORDER BY id ASC`,
    );
    return {
      type: 'xm',
      accounts: rows.map((row) => ({
        id: row.id,
        accountId: row.xm_account_id,
      })),
    };
  }

  if (name === 'skrill') {
    const rows = await query(
      `SELECT id, skrill_email
       FROM admin_skrill_accounts
       WHERE status = 'AVAILABLE' AND (is_deleted = 0 OR is_deleted IS NULL)
       ORDER BY id ASC`,
    );
    return {
      type: 'skrill',
      accounts: rows.map((row) => ({
        id: row.id,
        email: row.skrill_email,
      })),
    };
  }

  if (name === 'neteller') {
    const rows = await query(
      `SELECT id, neteller_email
       FROM admin_neteller_accounts
       WHERE status = 'AVAILABLE' AND (is_deleted = 0 OR is_deleted IS NULL)
       ORDER BY id ASC`,
    );
    return {
      type: 'neteller',
      accounts: rows.map((row) => ({
        id: row.id,
        email: row.neteller_email,
      })),
    };
  }

  if (name === 'perfect money') {
    const rows = await query(
      `SELECT id, pm_account_id
       FROM admin_perfect_money_accounts
       WHERE status = 'AVAILABLE' AND (is_deleted = 0 OR is_deleted IS NULL)
       ORDER BY id ASC`,
    );
    return {
      type: 'perfect_money',
      accounts: rows.map((row) => ({
        id: row.id,
        accountId: row.pm_account_id,
      })),
    };
  }

  if (name === 'card payment') {
    const rows = await query(
      `SELECT id, card_payment_link
       FROM admin_card_payment_links
       WHERE status = 'AVAILABLE' AND (is_deleted = 0 OR is_deleted IS NULL)
       ORDER BY id ASC`,
    );
    return {
      type: 'card_payment',
      accounts: rows.map((row) => ({
        id: row.id,
        cardPaymentLink: row.card_payment_link,
      })),
    };
  }

  return { type: 'unknown', accounts: [] };
}

export async function getDepositBootstrap(userId) {
  const accountHolder = await findAccountHolderByUserId(userId);
  if (!accountHolder) {
    throw validationError('Account holder not found.', 404);
  }
  if (isAccountBanned(accountHolder)) {
    throw validationError('Your account has been banned. Please contact support.', 403);
  }

  const verificationComplete = !needsVerification(accountHolder);
  const [topupMethods, recentAmounts, pendingCounts] = await Promise.all([
    loadTopupMethods(),
    loadRecentDepositAmounts(userId),
    getOpenDepositCountsByMethod(userId),
  ]);

  return {
    verification_complete: verificationComplete,
    account_holder: {
      account_number: accountHolder.account_number,
      first_name: accountHolder.first_name,
      last_name: accountHolder.last_name,
    },
    topup_methods: attachPendingCounts(topupMethods, pendingCounts),
    recent_amounts: recentAmounts,
  };
}

export async function getDepositMethodDetails(userId, { topupMethodId, depositAmount, depositAmountCurrency }) {
  await assertDepositAccess(userId);

  const methodId = Number(topupMethodId);
  if (!Number.isInteger(methodId) || methodId <= 0) {
    throw validationError('Top-up method is required.');
  }

  const topupMethod = await getTopupMethodById(methodId);
  if (!topupMethod) {
    throw validationError('Selected top-up method is not available.');
  }

  await assertDepositMethodPendingLimit(userId, methodId, topupMethod.name);

  const [paymentOptions, depositRates, priorityRate] = await Promise.all([
    loadSupportedPaymentOptions(methodId, topupMethod.name),
    loadDepositRatesForMethod(methodId),
    loadPriorityDepositRate(methodId),
  ]);

  if (!priorityRate) {
    throw validationError('No deposit rate is configured for this top-up method.');
  }

  const amount = Number(depositAmount);
  const currency = String(depositAmountCurrency || topupMethod.currency || 'USD').trim() || 'USD';

  return {
    topup_method: topupMethod,
    deposit_amount: Number.isFinite(amount) ? amount : null,
    deposit_amount_currency: currency,
    payment_options: paymentOptions,
    deposit_rates: depositRates,
    priority_rate: priorityRate,
    initial_payment_amount:
      Number.isFinite(amount) && priorityRate.rate
        ? Math.round((amount * priorityRate.rate + Number.EPSILON) * 100) / 100
        : null,
    initial_payment_currency: priorityRate.paymentOptionCurrency,
  };
}

function validateTopupAccountId(methodName, accountId) {
  const value = String(accountId || '').trim();
  const name = String(methodName || '').trim().toLowerCase();

  if (!value) return 'Top-up account ID is required.';

  if (name === 'xm') {
    if (value.length < 7 || value.length > 9) {
      return 'Account ID must be between 7 and 9 characters long.';
    }
    return null;
  }

  if (name === 'skrill' || name === 'neteller' || name === 'binance') {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      return 'Please enter a valid email address.';
    }
    return null;
  }

  if (name === 'perfect money') {
    if (!/^U\d{8}$/.test(value)) {
      return 'Account ID must start with "U" followed by 8 digits.';
    }
    return null;
  }

  return null;
}

export async function createUserDeposit(userId, payload) {
  const accountHolder = await assertDepositAccess(userId);

  const paymentOptionId = Number(payload.payment_option_id ?? payload.payment_option);
  const depositAmount = Number(payload.deposit_amount);
  const paymentAmount = Number(payload.payment_amount);
  const topupMethodId = Number(payload.topup_method_id);
  const paymentOptionRate = Number(payload.payment_option_rate);
  const paymentOptionRateId = Number(payload.payment_option_rate_id);
  const topupAccountId = String(payload.topup_account_id || '').trim();
  const depositAmountCurrency = String(payload.deposit_amount_currency || 'USD').trim();
  const paymentAmountCurrency = String(payload.payment_amount_currency || '').trim();

  if (!Number.isInteger(paymentOptionId) || paymentOptionId <= 0) {
    throw validationError('Payment option is required.');
  }
  if (!depositAmountCurrency) throw validationError('Deposit amount currency is required.');
  if (!Number.isFinite(depositAmount) || depositAmount <= 0) {
    throw validationError('Deposit amount must be greater than zero.');
  }
  if (!paymentAmountCurrency) throw validationError('Payment amount currency is required.');
  if (!Number.isFinite(paymentAmount) || paymentAmount <= 0) {
    throw validationError('Payment amount must be greater than zero.');
  }
  if (!Number.isInteger(topupMethodId) || topupMethodId <= 0) {
    throw validationError('Top-up method is required.');
  }
  if (!Number.isFinite(paymentOptionRate) || paymentOptionRate <= 0) {
    throw validationError('Payment option rate is required.');
  }
  if (!Number.isInteger(paymentOptionRateId) || paymentOptionRateId <= 0) {
    throw validationError('Payment option rate id is required.');
  }

  const topupMethod = await getTopupMethodById(topupMethodId);
  if (!topupMethod) {
    throw validationError('Selected top-up method is not available.');
  }

  await assertDepositMethodPendingLimit(userId, topupMethodId, topupMethod.name);

  const accountError = validateTopupAccountId(topupMethod.name, topupAccountId);
  if (accountError) throw validationError(accountError);

  if (depositAmount < topupMethod.minLimit || depositAmount > topupMethod.maxLimit) {
    throw validationError(
      `Deposit amount must be between USD ${topupMethod.minLimit} and USD ${topupMethod.maxLimit}.`,
    );
  }

  const transactionId = generateTransactionId(userId);
  const now = nowSqlDateTime();

  const result = await query(
    `INSERT INTO deposits (
      user_id, transaction_id, payment_option_id,
      deposit_amount_currency, deposit_amount,
      payment_amount_currency, payment_amount,
      applied_payment_option_rate, applied_payment_option_rate_id,
      topup_method_id, topup_account_id,
      transaction_status, message, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending', 'Your deposit is being processed.', ?, ?)`,
    [
      userId,
      transactionId,
      paymentOptionId,
      depositAmountCurrency,
      depositAmount,
      paymentAmountCurrency,
      paymentAmount,
      paymentOptionRate,
      paymentOptionRateId,
      topupMethodId,
      topupAccountId,
      now,
      now,
    ],
  );

  bumpAdminNavCounts();

  return {
    id: result.insertId,
    transaction_id: transactionId,
    account_holder: {
      account_number: accountHolder.account_number,
      first_name: accountHolder.first_name,
      last_name: accountHolder.last_name,
    },
  };
}

async function getUserDepositById(userId, depositId) {
  const id = Number(depositId);
  if (!Number.isInteger(id) || id <= 0) {
    throw validationError('Deposit id is required.');
  }

  const rows = await query(
    `SELECT d.*, po.payment_option_name, tm.topup_method_name, tm.tnc, tm.topup_method_logo
     FROM deposits d
     LEFT JOIN payment_options po ON po.id = d.payment_option_id
     LEFT JOIN topup_methods tm ON tm.id = d.topup_method_id
     WHERE d.id = ? AND d.user_id = ?
     LIMIT 1`,
    [id, userId],
  );
  return rows[0] ?? null;
}

export async function getDepositPaymentProofContext(userId, depositId) {
  await assertDepositAccess(userId);
  const deposit = await getUserDepositById(userId, depositId);
  if (!deposit) {
    throw validationError('Deposit not found.', 404);
  }
  if (deposit.payment_proof) {
    throw validationError('Payment proof has already been submitted for this deposit.');
  }

  const paymentAccounts = await loadPaymentAccounts(deposit.payment_option_name);

  return {
    deposit: {
      id: deposit.id,
      transaction_id: deposit.transaction_id,
      payment_amount: Number(deposit.payment_amount),
      payment_amount_currency: deposit.payment_amount_currency,
      deposit_amount: Number(deposit.deposit_amount),
      deposit_amount_currency: deposit.deposit_amount_currency,
      topup_method_id: deposit.topup_method_id,
      topup_method_name: deposit.topup_method_name,
      topup_method_logo_url: resolveWalletLogoPublicUrl(deposit.topup_method_logo),
      payment_option_name: deposit.payment_option_name,
      topup_account_id: deposit.topup_account_id,
    },
    payment_account_type: paymentAccounts.type,
    payment_accounts: paymentAccounts.accounts,
    terms: deposit.tnc || '',
  };
}

export async function saveDepositPaymentProof(userId, depositId, file) {
  await assertDepositAccess(userId);
  const deposit = await getUserDepositById(userId, depositId);
  if (!deposit) {
    throw validationError('Deposit not found.', 404);
  }
  if (deposit.payment_proof) {
    throw validationError('Payment proof has already been submitted for this deposit.');
  }

  await assertDepositMethodPendingLimit(userId, deposit.topup_method_id, deposit.topup_method_name);

  if (!file) {
    return {
      error: true,
      message: 'Payment proof should be less than 2Mb. Kindly reupload.',
    };
  }

  const filename = await storeDepositProof(file);

  await query(
    `UPDATE deposits
     SET payment_proof = ?, updated_at = ?
     WHERE id = ? AND user_id = ?`,
    [filename, nowSqlDateTime(), deposit.id, userId],
  );

  const updatedDeposit = { ...deposit, payment_proof: filename };
  try {
    await autoAssignDeposit(updatedDeposit);
  } catch (error) {
    console.error('[deposit:auto-assign]', error.message);
  }

  bumpAdminNavCounts();

  return {
    error: false,
    message: 'Successfully recorded the deposit proof details.',
  };
}

function resolveFilterDates(filterTemplate, fromDate, toDate) {
  return resolveFilterDateRange(filterTemplate, fromDate, toDate);
}

function formatDepositDateTime(value) {
  return formatDateTimeParts(value);
}

function mapUserDepositTransaction(row) {
  const created = formatDepositDateTime(row.created_at);
  const depositAmount = Number(row.deposit_amount);
  const paymentAmount = Number(row.payment_amount);

  return {
    id: row.transaction_id,
    depositId: row.id,
    type: 'Top-up',
    method: row.topup_method_name || '—',
    amount: `${row.deposit_amount_currency || 'USD'} ${Number.isFinite(depositAmount) ? depositAmount.toFixed(2) : '0.00'}`,
    paymentAmount: `${row.payment_amount_currency || '—'} ${Number.isFinite(paymentAmount) ? paymentAmount.toFixed(2) : '0.00'}`,
    fee: `${row.deposit_amount_currency || 'USD'} 0.00`,
    netAmount: `${row.deposit_amount_currency || 'USD'} ${Number.isFinite(depositAmount) ? depositAmount.toFixed(2) : '0.00'}`,
    currency: row.deposit_amount_currency || 'USD',
    date: created.date,
    time: created.time,
    createdAt: created.iso,
    status: row.transaction_status || 'Pending',
    account: row.topup_account_id || '—',
    paymentOption: row.payment_option_name || '—',
    reference: row.transaction_id,
    note: row.message || '',
    rejectedReason:
      row.transaction_status === 'Rejected'
        ? [row.rejected_reason_message, row.rejected_reason].filter(Boolean).join(' — ') || ''
        : '',
  };
}

async function loadTopupMethodsForFilters() {
  const rows = await query(
    `SELECT id, topup_method_name
     FROM topup_methods
     WHERE UPPER(availability) = 'AVAILABLE'
       AND (is_deleted = 0 OR is_deleted IS NULL)
     ORDER BY id ASC`,
  );
  return rows.map((row) => ({ id: row.id, name: row.topup_method_name }));
}

function parseTransactionStatusFilter(status) {
  const value = String(status || '').trim();
  if (!value || value === 'All Statuses' || value.toLowerCase() === 'all') {
    return null;
  }
  return value;
}

function parseUserDepositListFilters(params = {}) {
  const { fromDate, toDate } = resolveFilterDates(
    params.filter_template ?? params.filterTemplate,
    params.from_date ?? params.fromDate,
    params.to_date ?? params.toDate,
  );
  const topupMethodId = params.topup_method_id ?? params.topupMethodId;
  const parsedTopupMethodId =
    topupMethodId != null && String(topupMethodId).trim() !== ''
      ? Number(topupMethodId)
      : null;
  const status = parseTransactionStatusFilter(params.status ?? params.transaction_status);
  const search = String(params.search ?? params.q ?? '').trim() || null;

  return {
    fromDate,
    toDate,
    topupMethodId: Number.isInteger(parsedTopupMethodId) ? parsedTopupMethodId : null,
    parsedTopupMethodId,
    status,
    search,
  };
}

function buildUserDepositListQuery(userId, filters = {}) {
  const { fromDate, toDate, topupMethodId, status, search } = filters;
  let sql = `SELECT d.*, po.payment_option_name, tm.topup_method_name
             FROM deposits d
             LEFT JOIN payment_options po ON po.id = d.payment_option_id
             LEFT JOIN topup_methods tm ON tm.id = d.topup_method_id
             WHERE d.user_id = ?
               AND d.payment_proof IS NOT NULL`;
  const values = [userId];

  if (fromDate) {
    sql += ` AND DATE(d.created_at) >= ?`;
    values.push(fromDate);
  }
  if (toDate) {
    sql += ` AND DATE(d.created_at) <= ?`;
    values.push(toDate);
  }
  if (topupMethodId) {
    sql += ` AND d.topup_method_id = ?`;
    values.push(topupMethodId);
  }
  if (status) {
    sql += ` AND d.transaction_status = ?`;
    values.push(status);
  }
  if (search) {
    const term = `%${search}%`;
    sql += ` AND (
      d.transaction_id LIKE ? OR
      tm.topup_method_name LIKE ? OR
      d.topup_account_id LIKE ? OR
      po.payment_option_name LIKE ? OR
      d.message LIKE ?
    )`;
    values.push(term, term, term, term, term);
  }

  return { sql, values };
}

export async function listUserDepositTransactions(userId, params = {}) {
  await assertDepositAccess(userId);

  const page = Math.max(1, Number(params.page) || 1);
  const perPage = Math.min(50, Math.max(1, Number(params.per_page) || 10));
  const offset = (page - 1) * perPage;

  const { fromDate, toDate, topupMethodId, parsedTopupMethodId, status, search } =
    parseUserDepositListFilters(params);

  const { sql, values } = buildUserDepositListQuery(userId, {
    fromDate,
    toDate,
    topupMethodId,
    status,
    search,
  });

  const countRows = await query(
    `SELECT COUNT(*) AS total FROM (${sql}) AS deposit_list`,
    values,
  );
  const total = Number(countRows[0]?.total) || 0;

  const rows = await query(
    `${sql} ORDER BY d.id DESC LIMIT ? OFFSET ?`,
    [...values, perPage, offset],
  );

  const [topupMethods] = await Promise.all([loadTopupMethodsForFilters()]);

  return {
    transactions: rows.map(mapUserDepositTransaction),
    pagination: {
      page,
      per_page: perPage,
      total,
      total_pages: Math.max(1, Math.ceil(total / perPage)),
    },
    filters: {
      from_date: fromDate,
      to_date: toDate,
      topup_method_id: parsedTopupMethodId,
      filter_template: params.filter_template ?? params.filterTemplate ?? null,
      status,
      search,
    },
    topup_methods: topupMethods,
  };
}

export async function getUserDepositTransaction(userId, transactionId) {
  await assertDepositAccess(userId);
  const txId = String(transactionId || '').trim();
  if (!txId) throw validationError('Transaction id is required.');

  const rows = await query(
    `SELECT d.*, po.payment_option_name, tm.topup_method_name
     FROM deposits d
     LEFT JOIN payment_options po ON po.id = d.payment_option_id
     LEFT JOIN topup_methods tm ON tm.id = d.topup_method_id
     WHERE d.user_id = ? AND d.transaction_id = ?
     LIMIT 1`,
    [userId, txId],
  );

  const row = rows[0];
  if (!row) throw validationError('Transaction not found.', 404);
  return mapUserDepositTransaction(row);
}

function csvEscape(value) {
  const text = value == null ? '' : String(value);
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export async function exportUserDepositTransactions(userId, params = {}) {
  await assertDepositAccess(userId);

  const { fromDate, toDate, topupMethodId, status, search } = parseUserDepositListFilters(params);
  const { sql, values } = buildUserDepositListQuery(userId, {
    fromDate,
    toDate,
    topupMethodId,
    status,
    search,
  });
  const rows = await query(`${sql} ORDER BY d.id DESC`, values);

  const headings = [
    'id',
    'user_id',
    'transaction_id',
    'payment_option_id',
    'deposit_amount_currency',
    'payment_amount_currency',
    'deposit_amount',
    'payment_amount',
    'applied_payment_option_rate',
    'applied_payment_option_rate_id',
    'payment_proof',
    'topup_method_id',
    'topup_account_id',
    'transaction_status',
    'message',
    'created_at',
    'updated_at',
  ];

  const lines = [headings.join(',')];
  for (const row of rows) {
    lines.push(headings.map((key) => csvEscape(row[key])).join(','));
  }

  return {
    filename: 'deposit-transactions.csv',
    content: `\uFEFF${lines.join('\n')}`,
    mimeType: 'text/csv; charset=utf-8',
  };
}

export async function listUserDepositTransactionsForPrint(userId, params = {}) {
  await assertDepositAccess(userId);

  const { fromDate, toDate, topupMethodId, status, search } = parseUserDepositListFilters(params);
  const { sql, values } = buildUserDepositListQuery(userId, {
    fromDate,
    toDate,
    topupMethodId,
    status,
    search,
  });

  const rows = await query(`${sql} ORDER BY d.id DESC`, values);
  return rows.map(mapUserDepositTransaction);
}
