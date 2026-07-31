import { query } from '../config/database.js';

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
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatDateOnly(value) {
  if (!value) return '';
  const raw = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return raw.slice(0, 10);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
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

export async function listWalletsForRates() {
  const rows = await query(
    `SELECT w.id, w.wallet_name
     FROM wallets w
     WHERE EXISTS (
       SELECT 1
       FROM topup_methods t
       WHERE t.wallet_id = w.id
         AND (t.is_deleted = 0 OR t.is_deleted IS NULL)
         AND UPPER(t.availability) = 'AVAILABLE'
     )
     OR EXISTS (
       SELECT 1
       FROM cashout_methods c
       WHERE c.wallet_id = w.id
         AND (c.is_deleted = 0 OR c.is_deleted IS NULL)
         AND UPPER(c.availability) = 'AVAILABLE'
     )
     ORDER BY w.wallet_name ASC, w.id ASC`,
  );

  return rows.map((row) => ({
    id: row.id,
    name: row.wallet_name,
  }));
}

async function getLatestTopupMethodForWallet(walletId) {
  const rows = await query(
    `SELECT id, topup_method_name, wallet_id
     FROM topup_methods
     WHERE wallet_id = ?
       AND (is_deleted = 0 OR is_deleted IS NULL)
       AND UPPER(availability) = 'AVAILABLE'
     ORDER BY id DESC
     LIMIT 1`,
    [walletId],
  );
  return rows[0] ?? null;
}

async function getLatestCashoutMethodForWallet(walletId) {
  const rows = await query(
    `SELECT id, cashout_method_name, wallet_id
     FROM cashout_methods
     WHERE wallet_id = ?
       AND (is_deleted = 0 OR is_deleted IS NULL)
       AND UPPER(availability) = 'AVAILABLE'
     ORDER BY id DESC
     LIMIT 1`,
    [walletId],
  );
  return rows[0] ?? null;
}

async function assertWalletForRates(walletId) {
  const walletRows = await query(`SELECT id, wallet_name FROM wallets WHERE id = ? LIMIT 1`, [
    walletId,
  ]);
  const wallet = walletRows[0];
  if (!wallet) {
    throw validationError('No wallet for this id is available.');
  }

  const topupMethod = await getLatestTopupMethodForWallet(walletId);
  const cashoutMethod = await getLatestCashoutMethodForWallet(walletId);
  if (!topupMethod && !cashoutMethod) {
    throw validationError('Selected wallet has no available topup or cashout methods.');
  }

  return { wallet, topupMethod, cashoutMethod };
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
     LIMIT 5`,
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
     LIMIT 5`,
    [paymentOption.id],
  );

  const pointRows = await query(
    `SELECT pwr.id, pwr.payment_option_id, pwr.rate, pwr.applicable_date,
            po.payment_option_name
     FROM point_withdrawal_rates pwr
     LEFT JOIN payment_options po ON po.id = pwr.payment_option_id
     WHERE pwr.payment_option_id = ?
     ORDER BY pwr.applicable_date DESC`,
    [paymentOption.id],
  );

  const wallets = await listWalletsForRates();

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

  const { topupMethod, cashoutMethod } = await assertWalletForRates(walletId);

  if (topupMethod && depositRate) {
    await query(
      `INSERT INTO deposit_rates
        (admin_id, topup_method_id, payment_option_id, rate, applicable_date, is_deleted, created_at, updated_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [adminId, topupMethod.id, paymentOptionId, depositRate],
    );
  }

  if (cashoutMethod && withdrawalRate) {
    await query(
      `INSERT INTO withdrawal_rates
        (admin_id, cashout_method_id, payment_option_id, rate, applicable_date, is_deleted, created_at, updated_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [adminId, cashoutMethod.id, paymentOptionId, withdrawalRate],
    );
  }

  return { ok: true };
}

export async function updateDepositRate(adminId, payload) {
  const depositRateId = parsePositiveInt(payload.depositRateId, 'Deposit rate id');
  const walletId = parsePositiveInt(payload.walletId, 'Wallet');
  const topupMethodId = parsePositiveInt(payload.topupMethodId, 'Topup method id');
  parsePositiveInt(payload.paymentOptionId, 'Payment option id');
  const rate = parseRate(payload.rate, 'Deposit rate');

  await assertWalletForRates(walletId);

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

  return { ok: true };
}

export async function updateWithdrawalRate(adminId, payload) {
  const withdrawalRateId = parsePositiveInt(payload.withdrawalRateId, 'Withdrawal rate id');
  const walletId = parsePositiveInt(payload.walletId, 'Wallet');
  const cashoutMethodId = parsePositiveInt(payload.cashoutMethodId, 'Cashout method id');
  parsePositiveInt(payload.paymentOptionId, 'Payment option id');
  const rate = parseRate(payload.rate, 'Withdrawal rate');

  await assertWalletForRates(walletId);

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
