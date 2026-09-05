import { query } from '../config/database.js';
import { env } from '../config/env.js';
import { columnExists } from '../db/helpers.js';
import { formatTimestampSl, formatYmdColombo, parseDbDateTime } from '../utils/slTime.js';
import { sendEmailAndSms } from './notification.service.js';
import { rateChangeEmailHtml } from './mail.templates.js';
import { fullyVerifiedAccountSql } from './accountHolder.service.js';
import { ensureWalletCatalogLinksForRates } from './wallet.service.js';
import { syncCustomPayAccountCategoryPaymentOptions } from './customPayAccount.service.js';

function validationError(message, status = 422) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function parsePositiveInt(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw validationError(`${label} is required.`);
  }
  return parsed;
}

function parseRate(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw validationError(`${label} must be numeric.`);
  }
  return parsed;
}

function formatTimestamp(value) {
  if (!value) return '';
  return formatTimestampSl(value) || String(value);
}

function formatDateOnly(value) {
  if (!value) return '';
  const raw = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const date = parseDbDateTime(value);
  if (!date) return raw.slice(0, 10);
  return formatYmdColombo(date);
}

async function resolvePaymentOptionByName(methodName) {
  const name = String(methodName ?? '').trim();
  if (!name) {
    throw validationError('Payment option is required.', 404);
  }

  const rows = await query(
    `SELECT id, payment_option_name, payment_option_currency
     FROM payment_options
     WHERE LOWER(payment_option_name) = LOWER(?)
       AND (is_deleted = 0 OR is_deleted IS NULL)
     ORDER BY id ASC
     LIMIT 1`,
    [name],
  );

  const row = rows[0];
  if (!row) {
    throw validationError('Payment option not found in the database.', 404);
  }

  return {
    id: row.id,
    name: row.payment_option_name,
    currency: row.payment_option_currency,
  };
}

export async function listRatePaymentOptions() {
  await syncCustomPayAccountCategoryPaymentOptions();
  const rows = await query(
    `SELECT id, payment_option_name, payment_option_currency
     FROM payment_options
     WHERE (is_deleted = 0 OR is_deleted IS NULL)
       AND UPPER(availability) = 'AVAILABLE'
     ORDER BY id ASC`,
  );

  const seen = new Set();
  const paymentOptions = [];

  for (const row of rows) {
    const key = String(row.payment_option_name || '').trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    paymentOptions.push({
      id: row.id,
      name: row.payment_option_name,
      currency: row.payment_option_currency,
    });
  }

  return paymentOptions;
}

export async function listWalletsForRates(paymentOptionId) {
  await ensureWalletCatalogLinksForRates();
  const optionId = Number(paymentOptionId);
  if (!Number.isInteger(optionId) || optionId <= 0) {
    throw validationError('Payment option is required.');
  }

  const rows = await query(
    `SELECT w.id, w.wallet_name
     FROM wallets w
     WHERE EXISTS (
       SELECT 1
       FROM topup_methods t
       INNER JOIN wallet_supported_payment_options wspo
         ON wspo.wallet_id = t.id
        AND wspo.wallet_type = 'topup'
       WHERE t.wallet_id = w.id
         AND (t.is_deleted = 0 OR t.is_deleted IS NULL)
         AND UPPER(t.availability) = 'AVAILABLE'
         AND wspo.payment_option_id = ?
         AND UPPER(wspo.status) = 'ACTIVE'
     )
     OR EXISTS (
       SELECT 1
       FROM cashout_methods c
       INNER JOIN wallet_supported_payment_options wspo
         ON wspo.wallet_id = c.id
        AND wspo.wallet_type = 'cashout'
       WHERE c.wallet_id = w.id
         AND (c.is_deleted = 0 OR c.is_deleted IS NULL)
         AND UPPER(c.availability) = 'AVAILABLE'
         AND wspo.payment_option_id = ?
         AND UPPER(wspo.status) = 'ACTIVE'
     )
     ORDER BY w.wallet_name ASC, w.id ASC`,
    [optionId, optionId],
  );

  return rows.map((row) => ({
    id: row.id,
    name: row.wallet_name,
  }));
}

async function walletAllowsPaymentOption(walletId, paymentOptionId) {
  const optionId = Number(paymentOptionId);
  if (!Number.isInteger(optionId) || optionId <= 0) return false;

  const topup = await query(
    `SELECT t.id
     FROM topup_methods t
     INNER JOIN wallet_supported_payment_options wspo
       ON wspo.wallet_id = t.id
      AND wspo.wallet_type = 'topup'
     WHERE t.wallet_id = ?
       AND wspo.payment_option_id = ?
       AND UPPER(wspo.status) = 'ACTIVE'
       AND (t.is_deleted = 0 OR t.is_deleted IS NULL)
       AND UPPER(t.availability) = 'AVAILABLE'
     LIMIT 1`,
    [walletId, optionId],
  );
  if (topup[0]) return true;

  const cashout = await query(
    `SELECT c.id
     FROM cashout_methods c
     INNER JOIN wallet_supported_payment_options wspo
       ON wspo.wallet_id = c.id
      AND wspo.wallet_type = 'cashout'
     WHERE c.wallet_id = ?
       AND wspo.payment_option_id = ?
       AND UPPER(wspo.status) = 'ACTIVE'
       AND (c.is_deleted = 0 OR c.is_deleted IS NULL)
       AND UPPER(c.availability) = 'AVAILABLE'
     LIMIT 1`,
    [walletId, optionId],
  );
  return Boolean(cashout[0]);
}

function insertedId(result) {
  const id = Number(result?.insertId ?? result?.lastInsertRowid ?? 0);
  return Number.isInteger(id) && id > 0 ? id : 0;
}

const METHOD_NOT_DELETED_SQL = `(is_deleted = 0 OR is_deleted IS NULL)`;
const METHOD_USABLE_SQL = `${METHOD_NOT_DELETED_SQL}
       AND (availability IS NULL OR UPPER(TRIM(availability)) <> 'NOT_AVAILABLE')`;

async function linkMethodWalletId(tableName, methodId, walletId) {
  await query(
    `UPDATE ${tableName}
     SET wallet_id = ?, availability = 'AVAILABLE', updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [walletId, methodId],
  );
}

async function findLatestMethodForWallet(kind, walletId, walletName) {
  const table = kind === 'topup' ? 'topup_methods' : 'cashout_methods';
  const nameColumn = kind === 'topup' ? 'topup_method_name' : 'cashout_method_name';

  const byWallet = await query(
    `SELECT id, ${nameColumn} AS method_name, wallet_id
     FROM ${table}
     WHERE wallet_id = ?
       AND ${METHOD_USABLE_SQL}
     ORDER BY id DESC
     LIMIT 1`,
    [walletId],
  );
  if (byWallet[0]) return byWallet[0];

  const name = String(walletName || '').trim();
  if (!name) return null;

  const byName = await query(
    `SELECT id, ${nameColumn} AS method_name, wallet_id
     FROM ${table}
     WHERE UPPER(TRIM(${nameColumn})) = UPPER(?)
       AND ${METHOD_NOT_DELETED_SQL}
     ORDER BY id DESC
     LIMIT 1`,
    [name],
  );
  const row = byName[0];
  if (!row) return null;

  await linkMethodWalletId(table, row.id, walletId);
  row.wallet_id = walletId;
  return row;
}

async function resolvePayAccountForWalletName(walletName) {
  const name = String(walletName || '').trim();
  if (!name) return { type: null, id: null };
  try {
    const rows = await query(
      `SELECT r.id
       FROM pay_account_records r
       INNER JOIN pay_account_categories c ON c.id = r.category_id
       WHERE r.is_deleted = 0
         AND c.is_deleted = 0
         AND UPPER(TRIM(c.name)) = UPPER(?)
       ORDER BY r.id ASC
       LIMIT 1`,
      [name],
    );
    const id = Number(rows[0]?.id);
    if (Number.isInteger(id) && id > 0) {
      return { type: 'custom', id };
    }
  } catch {
    return { type: null, id: null };
  }
  return { type: null, id: null };
}

async function copyTopupPaymentOptionsToCashout(topupMethodId, cashoutMethodId) {
  const options = await query(
    `SELECT payment_option_id
     FROM wallet_supported_payment_options
     WHERE wallet_id = ?
       AND wallet_type = 'topup'
       AND UPPER(status) = 'ACTIVE'`,
    [topupMethodId],
  );
  for (const option of options) {
    const paymentOptionId = Number(option.payment_option_id);
    if (!Number.isInteger(paymentOptionId) || paymentOptionId <= 0) continue;
    const existing = await query(
      `SELECT id
       FROM wallet_supported_payment_options
       WHERE wallet_id = ?
         AND wallet_type = 'cashout'
         AND payment_option_id = ?
       LIMIT 1`,
      [cashoutMethodId, paymentOptionId],
    );
    if (existing[0]) {
      await query(
        `UPDATE wallet_supported_payment_options
         SET status = 'ACTIVE', updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [existing[0].id],
      );
      continue;
    }
    await query(
      `INSERT INTO wallet_supported_payment_options
         (wallet_id, wallet_type, payment_option_id, status, created_at, updated_at)
       VALUES (?, 'cashout', ?, 'ACTIVE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [cashoutMethodId, paymentOptionId],
    );
  }
}

async function cloneTopupMethodAsCashout(topupMethod, walletId) {
  const rows = await query(`SELECT * FROM topup_methods WHERE id = ? LIMIT 1`, [topupMethod.id]);
  const src = rows[0];
  if (!src) return null;

  const insertColumns = [
    'cashout_method_name',
    'cashout_method_currency',
    'cashout_method_id_type',
    'platform_id_type',
    'cashout_method_logo',
    'availability',
    'minimum_limit',
    'maximum_limit',
    'is_deleted',
    'tnc',
    'wallet_id',
  ];
  const insertValues = [
    src.topup_method_name,
    src.topup_method_currency,
    src.topup_method_id_type,
    src.platform_id_type,
    src.topup_method_logo,
    'AVAILABLE',
    src.minimum_limit,
    src.maximum_limit,
    0,
    src.tnc,
    walletId,
  ];

  if (await columnExists('cashout_methods', 'pay_account_type')) {
    const payAccount = await resolvePayAccountForWalletName(src.topup_method_name);
    insertColumns.push('pay_account_type', 'pay_account_id');
    insertValues.push(payAccount.type, payAccount.id);
  }

  if (await columnExists('cashout_methods', 'allow_navigate_button')) {
    insertColumns.push('allow_navigate_button', 'navigate_url', 'navigate_button_label');
    insertValues.push(
      src.allow_navigate_button ?? 0,
      src.navigate_url ?? null,
      src.navigate_button_label ?? null,
    );
  }

  const placeholders = [...insertValues.map(() => '?'), 'CURRENT_TIMESTAMP', 'CURRENT_TIMESTAMP'].join(', ');
  const result = await query(
    `INSERT INTO cashout_methods (${insertColumns.join(', ')}, created_at, updated_at)
     VALUES (${placeholders})`,
    insertValues,
  );
  const cashoutId = insertedId(result);
  if (!cashoutId) return null;

  await copyTopupPaymentOptionsToCashout(src.id, cashoutId);
  return {
    id: cashoutId,
    method_name: src.topup_method_name,
    wallet_id: walletId,
  };
}

async function getLatestTopupMethodForWallet(walletId, walletName) {
  return findLatestMethodForWallet('topup', walletId, walletName);
}

async function getLatestCashoutMethodForWallet(walletId, walletName) {
  return findLatestMethodForWallet('cashout', walletId, walletName);
}

async function assertWalletForRates(walletId) {
  const walletRows = await query(`SELECT id, wallet_name FROM wallets WHERE id = ? LIMIT 1`, [
    walletId,
  ]);
  const wallet = walletRows[0];
  if (!wallet) {
    throw validationError('No wallet for this id is available.');
  }

  const topupMethod = await getLatestTopupMethodForWallet(walletId, wallet.wallet_name);
  const cashoutMethod = await getLatestCashoutMethodForWallet(walletId, wallet.wallet_name);
  if (!topupMethod && !cashoutMethod) {
    throw validationError('Selected wallet has no available topup or cashout methods.');
  }

  return { wallet, topupMethod, cashoutMethod };
}

function parseNotifyFlag(value) {
  return value === true || value === 1 || value === '1' || String(value).toLowerCase() === 'true';
}

function formatRateForEmail(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return parsed.toFixed(2);
}

async function resolvePaymentOptionById(paymentOptionId) {
  const rows = await query(
    `SELECT id, payment_option_name, payment_option_currency
     FROM payment_options
     WHERE id = ?
       AND (is_deleted = 0 OR is_deleted IS NULL)
     LIMIT 1`,
    [paymentOptionId],
  );
  return rows[0] ?? null;
}

async function listRateNotifyRecipients() {
  return query(
    `SELECT user_id, email, mobile_number, first_name
     FROM account_holders
     WHERE COALESCE(account_status, 'ACTIVE') != 'BANNED'
       AND email IS NOT NULL
       AND TRIM(email) != ''
       AND ${fullyVerifiedAccountSql()}`,
  );
}

function buildRateChangeSmsMessage(details) {
  const method = details.paymentOptionName || 'payment';
  const wallet = details.walletName || 'selected method';
  const unit = details.currency || 'USD';
  const parts = [];

  if (details.depositRate != null && details.depositRate !== '') {
    parts.push(`Deposit ${details.depositRate} ${unit}`);
  }
  if (details.withdrawalRate != null && details.withdrawalRate !== '') {
    parts.push(`Withdrawal ${details.withdrawalRate} ${unit}`);
  }

  const ratesText = parts.length ? ` ${parts.join(', ')}.` : '';
  if (details.isUpdate) {
    return `iTrustLD: ${method} rates for ${wallet} updated.${ratesText}`;
  }
  return `iTrustLD: New ${method} rates for ${wallet} available.${ratesText}`;
}

async function sendRateChangeNotifications(details) {
  const recipients = await listRateNotifyRecipients();
  if (!recipients.length) {
    console.info('[rate-notify] no fully verified recipients');
    return;
  }

  const dashboardUrl = `${env.userAppUrl}/dashboard`;
  const subject = details.isUpdate
    ? `iTrustLD ${details.paymentOptionName} rates updated`
    : `iTrustLD new ${details.paymentOptionName} rates available`;
  const smsMessage = buildRateChangeSmsMessage(details);
  const text = `${subject}. Deposit: ${details.depositRate ?? '—'}, Withdrawal: ${details.withdrawalRate ?? '—'}.`;

  let successCount = 0;
  let failureCount = 0;

  for (const recipient of recipients) {
    try {
      const html = rateChangeEmailHtml({
        firstName: recipient.first_name,
        paymentOptionName: details.paymentOptionName,
        walletName: details.walletName,
        currency: details.currency,
        depositRate: details.depositRate,
        withdrawalRate: details.withdrawalRate,
        isUpdate: details.isUpdate,
        dashboardUrl,
      });
      await sendEmailAndSms({
        email: recipient.email,
        subject,
        html,
        text,
        smsMessage,
        msisdn: recipient.mobile_number || null,
        userId: recipient.user_id || null,
        smsType: 'RATE_CHANGE',
      });
      successCount += 1;
    } catch (error) {
      failureCount += 1;
      console.error('[rate-notify] failed for', recipient.email, error.message);
    }
  }

  console.info('[rate-notify] complete', { successCount, failureCount, total: recipients.length });
}

function scheduleRateChangeNotifications(details) {
  void sendRateChangeNotifications(details).catch((error) => {
    console.error('[rate-notify]', error.message);
  });
}

async function maybeNotifyRateChange({
  notifyUsersByEmail,
  paymentOptionId,
  wallet,
  depositRate,
  withdrawalRate,
  isUpdate,
}) {
  if (!parseNotifyFlag(notifyUsersByEmail)) return;

  const paymentOption = await resolvePaymentOptionById(paymentOptionId);
  scheduleRateChangeNotifications({
    paymentOptionName: paymentOption?.payment_option_name || 'payment',
    currency: paymentOption?.payment_option_currency || 'USD',
    walletName: wallet?.wallet_name || 'selected method',
    depositRate: depositRate == null ? null : formatRateForEmail(depositRate),
    withdrawalRate: withdrawalRate == null ? null : formatRateForEmail(withdrawalRate),
    isUpdate: Boolean(isUpdate),
  });
}

function mapDepositRateRow(row) {
  return {
    id: row.id,
    adminId: row.admin_id ?? '',
    topupMethodId: row.topup_method_id,
    topupMethod: row.topup_method_name || '',
    walletId: row.wallet_id ?? null,
    depositRate: Number(row.rate).toFixed(2),
    changedDate: formatTimestamp(row.applicable_date),
  };
}

function mapWithdrawalRateRow(row) {
  return {
    id: row.id,
    adminId: row.admin_id ?? '',
    cashoutMethodId: row.cashout_method_id,
    cashoutMethod: row.cashout_method_name || '',
    walletId: row.wallet_id ?? null,
    withdrawRate: Number(row.rate).toFixed(2),
    changedDate: formatTimestamp(row.applicable_date),
  };
}

function mapPointWithdrawalRateRow(row) {
  return {
    id: row.id,
    paymentOptionId: row.payment_option_id,
    paymentOption: row.payment_option_name || String(row.payment_option_id ?? ''),
    rate: Number(row.rate).toFixed(2),
    applicableDate: formatTimestamp(row.applicable_date),
  };
}

export async function getRatesManagementData(methodName) {
  await syncCustomPayAccountCategoryPaymentOptions();
  const paymentOption = await resolvePaymentOptionByName(methodName);

  const depositRows = await query(
    `SELECT dr.id, dr.admin_id, dr.topup_method_id, dr.rate, dr.applicable_date,
            tm.topup_method_name, tm.wallet_id
     FROM deposit_rates dr
     INNER JOIN topup_methods tm ON tm.id = dr.topup_method_id
     WHERE dr.payment_option_id = ?
       AND (dr.is_deleted = 0 OR dr.is_deleted IS NULL)
       AND tm.wallet_id IS NOT NULL
     ORDER BY dr.created_at DESC
     LIMIT 10`,
    [paymentOption.id],
  );

  const withdrawalRows = await query(
    `SELECT wr.id, wr.admin_id, wr.cashout_method_id, wr.rate, wr.applicable_date,
            cm.cashout_method_name, cm.wallet_id
     FROM withdrawal_rates wr
     INNER JOIN cashout_methods cm ON cm.id = wr.cashout_method_id
     WHERE wr.payment_option_id = ?
       AND (wr.is_deleted = 0 OR wr.is_deleted IS NULL)
       AND cm.wallet_id IS NOT NULL
     ORDER BY wr.created_at DESC
     LIMIT 10`,
    [paymentOption.id],
  );

  const pointRows = await query(
    `SELECT pwr.id, pwr.payment_option_id, pwr.rate, pwr.applicable_date,
            po.payment_option_name
     FROM point_withdrawal_rates pwr
     LEFT JOIN payment_options po ON po.id = pwr.payment_option_id
     WHERE pwr.payment_option_id = ?
     ORDER BY pwr.applicable_date DESC
     LIMIT 10`,
    [paymentOption.id],
  );

  const wallets = await listWalletsForRates(paymentOption.id);

  return {
    paymentOption,
    depositRates: depositRows.map(mapDepositRateRow),
    withdrawalRates: withdrawalRows.map(mapWithdrawalRateRow),
    pointWithdrawalRates: pointRows.map(mapPointWithdrawalRateRow),
    wallets,
  };
}

export async function createRates(adminId, payload) {
  const paymentOptionId = parsePositiveInt(payload.paymentOptionId, 'Payment option id');
  const walletId = parsePositiveInt(payload.walletId, 'Wallet');
  const depositRate = parseRate(payload.depositRate, 'Deposit rate');
  const withdrawalRate = parseRate(payload.withdrawalRate, 'Withdrawal rate');

  let { wallet, topupMethod, cashoutMethod } = await assertWalletForRates(walletId);

  if (!(await walletAllowsPaymentOption(walletId, paymentOptionId))) {
    throw validationError('Selected wallet does not allow this payment method.');
  }

  if (withdrawalRate && !cashoutMethod && topupMethod) {
    cashoutMethod = await cloneTopupMethodAsCashout(topupMethod, walletId);
  }

  if (depositRate && !topupMethod) {
    throw validationError(
      `No available top-up wallet named "${wallet.wallet_name}" to save the deposit rate.`,
    );
  }
  if (withdrawalRate && !cashoutMethod) {
    throw validationError(
      `No available cash-out wallet named "${wallet.wallet_name}" to save the withdrawal rate.`,
    );
  }

  let savedDeposit = null;
  let savedWithdrawal = null;

  if (topupMethod && depositRate) {
    await query(
      `INSERT INTO deposit_rates
        (admin_id, topup_method_id, payment_option_id, rate, applicable_date, is_deleted, created_at, updated_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [adminId, topupMethod.id, paymentOptionId, depositRate],
    );
    savedDeposit = depositRate;
  }

  if (cashoutMethod && withdrawalRate) {
    await query(
      `INSERT INTO withdrawal_rates
        (admin_id, cashout_method_id, payment_option_id, rate, applicable_date, is_deleted, created_at, updated_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [adminId, cashoutMethod.id, paymentOptionId, withdrawalRate],
    );
    savedWithdrawal = withdrawalRate;
  }

  await maybeNotifyRateChange({
    notifyUsersByEmail: payload.notifyUsersByEmail,
    paymentOptionId,
    wallet,
    depositRate: savedDeposit,
    withdrawalRate: savedWithdrawal,
    isUpdate: false,
  });

  return { ok: true };
}

export async function updateDepositRate(adminId, payload) {
  const depositRateId = parsePositiveInt(payload.depositRateId, 'Deposit rate id');
  const walletId = parsePositiveInt(payload.walletId, 'Wallet');
  const topupMethodId = parsePositiveInt(payload.topupMethodId, 'Topup method id');
  const paymentOptionId = parsePositiveInt(payload.paymentOptionId, 'Payment option id');
  const rate = parseRate(payload.rate, 'Deposit rate');

  const { wallet } = await assertWalletForRates(walletId);

  const rows = await query(
    `SELECT id
     FROM deposit_rates
     WHERE id = ?
       AND topup_method_id = ?
       AND (is_deleted = 0 OR is_deleted IS NULL)
     LIMIT 1`,
    [depositRateId, topupMethodId],
  );

  if (!rows[0]) {
    throw validationError('Deposit rate not found.', 404);
  }

  await query(
    `UPDATE deposit_rates
     SET rate = ?, admin_id = ?, applicable_date = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [rate, adminId, depositRateId],
  );

  await maybeNotifyRateChange({
    notifyUsersByEmail: payload.notifyUsersByEmail,
    paymentOptionId,
    wallet,
    depositRate: rate,
    withdrawalRate: null,
    isUpdate: true,
  });

  return { ok: true };
}

export async function updateWithdrawalRate(adminId, payload) {
  const withdrawalRateId = parsePositiveInt(payload.withdrawalRateId, 'Withdrawal rate id');
  const walletId = parsePositiveInt(payload.walletId, 'Wallet');
  const cashoutMethodId = parsePositiveInt(payload.cashoutMethodId, 'Cashout method id');
  const paymentOptionId = parsePositiveInt(payload.paymentOptionId, 'Payment option id');
  const rate = parseRate(payload.rate, 'Withdrawal rate');

  const { wallet } = await assertWalletForRates(walletId);

  const rows = await query(
    `SELECT id
     FROM withdrawal_rates
     WHERE id = ?
       AND cashout_method_id = ?
       AND (is_deleted = 0 OR is_deleted IS NULL)
     LIMIT 1`,
    [withdrawalRateId, cashoutMethodId],
  );

  if (!rows[0]) {
    throw validationError('Withdrawal rate not found.', 404);
  }

  await query(
    `UPDATE withdrawal_rates
     SET rate = ?, admin_id = ?, applicable_date = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [rate, adminId, withdrawalRateId],
  );

  await maybeNotifyRateChange({
    notifyUsersByEmail: payload.notifyUsersByEmail,
    paymentOptionId,
    wallet,
    depositRate: null,
    withdrawalRate: rate,
    isUpdate: true,
  });

  return { ok: true };
}

export async function deleteRate(adminId, payload) {
  const rateId = parsePositiveInt(payload.rateId, 'Rate id');
  const rateType = String(payload.rateType ?? '').trim().toLowerCase();

  if (!['deposit', 'withdrawal'].includes(rateType)) {
    throw validationError('Rate type must be deposit or withdrawal.');
  }

  const table = rateType === 'deposit' ? 'deposit_rates' : 'withdrawal_rates';
  const rows = await query(`SELECT id FROM ${table} WHERE id = ? LIMIT 1`, [rateId]);
  if (!rows[0]) {
    throw validationError('Rate not found.', 404);
  }

  await query(
    `UPDATE ${table}
     SET is_deleted = 1, admin_id = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [adminId, rateId],
  );

  return { ok: true, message: 'Successfully deleted the rate.' };
}

export async function addPointWithdrawalRate(payload) {
  const paymentOptionId = parsePositiveInt(payload.paymentOptionId, 'Payment option id');
  const rate = parseRate(payload.rate, 'Point withdrawal rate');
  const applicableDate = formatDateOnly(payload.applicableDate);
  if (!applicableDate) {
    throw validationError('Applicable date is required.');
  }

  await query(
    `INSERT INTO point_withdrawal_rates
      (payment_option_id, rate, applicable_date, created_at, updated_at)
     VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [paymentOptionId, rate, applicableDate],
  );

  return { ok: true };
}

export async function updatePointWithdrawalRate(payload) {
  const pointRateId = parsePositiveInt(payload.pointWithdrawalRateId, 'Point withdrawal rate id');
  const paymentOptionId = parsePositiveInt(payload.paymentOptionId, 'Payment option id');
  const rate = parseRate(payload.rate, 'Point withdrawal rate');
  const applicableDate = formatDateOnly(payload.applicableDate);
  if (!applicableDate) {
    throw validationError('Applicable date is required.');
  }

  const rows = await query(`SELECT id FROM point_withdrawal_rates WHERE id = ? LIMIT 1`, [
    pointRateId,
  ]);
  if (!rows[0]) {
    throw validationError('Point withdrawal rate not found.', 404);
  }

  await query(
    `UPDATE point_withdrawal_rates
     SET payment_option_id = ?, rate = ?, applicable_date = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [paymentOptionId, rate, applicableDate, pointRateId],
  );

  return { ok: true };
}

export async function deletePointWithdrawalRate(pointRateId) {
  const id = parsePositiveInt(pointRateId, 'Point withdrawal rate id');
  const rows = await query(`SELECT id FROM point_withdrawal_rates WHERE id = ? LIMIT 1`, [id]);
  if (!rows[0]) {
    throw validationError('Point withdrawal rate not found.', 404);
  }

  await query(`DELETE FROM point_withdrawal_rates WHERE id = ?`, [id]);
  return { ok: true };
}
