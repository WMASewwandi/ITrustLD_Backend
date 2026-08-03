import { query } from '../config/database.js';

function validationError(message, status = 422) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function parsePaymentMethodId(id) {
  const paymentMethodId = Number(id);
  if (!Number.isInteger(paymentMethodId) || paymentMethodId <= 0) {
    throw validationError('Payment method id is required.');
  }
  return paymentMethodId;
}

function mapPaymentMethodRow(row) {
  return {
    id: row.id,
    name: row.payment_option_name,
    currency: row.payment_option_currency,
    minLimit: row.minimum_limit != null ? Number(row.minimum_limit) : 0,
    maxLimit: row.maximum_limit != null ? Number(row.maximum_limit) : 0,
    active: row.availability === 'AVAILABLE',
    priority: row.priority === 'YES',
  };
}

function validatePaymentMethodPayload(payload) {
  const name = String(payload.name ?? '').trim();
  const currency = String(payload.currency ?? '').trim();
  const minimumLimit = Number(payload.minLimit);
  const maximumLimit = Number(payload.maxLimit);

  if (!name) throw validationError('Payment method name is required.');
  if (!currency) throw validationError('Currency is required.');
  if (!Number.isFinite(minimumLimit)) throw validationError('Minimum limit is required.');
  if (!Number.isFinite(maximumLimit)) throw validationError('Maximum limit is required.');

  return {
    name,
    currency,
    minimumLimit,
    maximumLimit,
  };
}

async function getPaymentMethodRow(paymentMethodId) {
  const rows = await query(
    `SELECT id, payment_option_name, payment_option_currency, availability, priority,
            minimum_limit, maximum_limit
     FROM payment_options
     WHERE id = ?
       AND (is_deleted = 0 OR is_deleted IS NULL)
     LIMIT 1`,
    [paymentMethodId],
  );
  return rows[0] ?? null;
}

export async function getPaymentMethodFormMeta() {
  const currencyTypes = await query(
    `SELECT id, code, symbol
     FROM currency_types
     WHERE (is_deleted = 0 OR is_deleted IS NULL)
       AND UPPER(status) = 'ACTIVE'
     ORDER BY id`,
  );

  return {
    currencyTypes: currencyTypes.map((row) => ({
      id: row.id,
      code: row.code,
      symbol: row.symbol,
    })),
  };
}

export async function listPaymentMethods() {
  const rows = await query(
    `SELECT id, payment_option_name, payment_option_currency, availability, priority,
            minimum_limit, maximum_limit
     FROM payment_options
     WHERE is_deleted = 0 OR is_deleted IS NULL
     ORDER BY id ASC`,
  );

  return rows.map(mapPaymentMethodRow);
}

export async function createPaymentMethod(payload) {
  const { name, currency, minimumLimit, maximumLimit } = validatePaymentMethodPayload(payload);

  const result = await query(
    `INSERT INTO payment_options
      (payment_option_name, payment_option_currency, availability, priority,
       minimum_limit, maximum_limit, is_deleted)
     VALUES (?, ?, 'AVAILABLE', 'NO', ?, ?, 0)`,
    [name, currency, minimumLimit, maximumLimit],
  );

  const row = await getPaymentMethodRow(result.insertId);
  return mapPaymentMethodRow(row);
}

export async function updatePaymentMethod(paymentMethodId, payload) {
  const id = parsePaymentMethodId(paymentMethodId);
  const existing = await getPaymentMethodRow(id);
  if (!existing) throw validationError('Payment method not found.', 404);

  const { name, currency, minimumLimit, maximumLimit } = validatePaymentMethodPayload(payload);

  await query(
    `UPDATE payment_options
     SET payment_option_name = ?,
         payment_option_currency = ?,
         minimum_limit = ?,
         maximum_limit = ?
     WHERE id = ?
       AND (is_deleted = 0 OR is_deleted IS NULL)`,
    [name, currency, minimumLimit, maximumLimit, id],
  );

  const row = await getPaymentMethodRow(id);
  return mapPaymentMethodRow(row);
}

export async function deletePaymentMethod(paymentMethodId) {
  const id = parsePaymentMethodId(paymentMethodId);
  const existing = await getPaymentMethodRow(id);
  if (!existing) throw validationError('Payment method not found.', 404);

  await query(
    `UPDATE payment_options
     SET is_deleted = 1
     WHERE id = ?`,
    [id],
  );

  return { ok: true, message: 'Successfully deleted the payment method.' };
}

export async function togglePaymentMethodStatus(paymentMethodId, active) {
  const id = parsePaymentMethodId(paymentMethodId);
  const existing = await getPaymentMethodRow(id);
  if (!existing) throw validationError('Payment method not found.', 404);

  const availability = active ? 'AVAILABLE' : 'NOT_AVAILABLE';

  await query(
    `UPDATE payment_options
     SET availability = ?
     WHERE id = ?
       AND (is_deleted = 0 OR is_deleted IS NULL)`,
    [availability, id],
  );

  const row = await getPaymentMethodRow(id);
  return mapPaymentMethodRow(row);
}

export async function setPaymentMethodPriority(paymentMethodId) {
  const id = parsePaymentMethodId(paymentMethodId);
  const existing = await getPaymentMethodRow(id);
  if (!existing) throw validationError('Payment method not found.', 404);

  const allMethods = await query(
    `SELECT id
     FROM payment_options
     WHERE is_deleted = 0 OR is_deleted IS NULL`,
  );

  for (const method of allMethods) {
    if (Number(method.id) === id) {
      await query(
        `UPDATE payment_options
         SET priority = 'YES',
             availability = 'AVAILABLE'
         WHERE id = ?`,
        [id],
      );
    } else {
      await query(
        `UPDATE payment_options
         SET priority = 'NO'
         WHERE id = ?`,
        [method.id],
      );
    }
  }

  const rows = await listPaymentMethods();
  return rows;
}
