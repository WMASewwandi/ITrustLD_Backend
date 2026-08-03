import { query } from '../config/database.js';

function validationError(message, status = 422) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function parseCurrencyTypeId(id) {
  const currencyTypeId = Number(id);
  if (!Number.isInteger(currencyTypeId) || currencyTypeId <= 0) {
    throw validationError('Currency type id is required.');
  }
  return currencyTypeId;
}

function mapCurrencyTypeRow(row) {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    symbol: row.symbol,
    description: row.description,
    active: row.status === 'ACTIVE',
  };
}

function validateCurrencyTypePayload(payload) {
  const name = String(payload.name ?? '').trim();
  const code = String(payload.code ?? '').trim();
  const symbol = String(payload.symbol ?? '').trim();
  const description = String(payload.description ?? '').trim();

  if (!name) throw validationError('Name is required.');
  if (!code) throw validationError('Code is required.');
  if (!symbol) throw validationError('Symbol is required.');
  if (!description) throw validationError('Description is required.');

  return { name, code, symbol, description };
}

async function getCurrencyTypeRow(currencyTypeId) {
  const rows = await query(
    `SELECT id, name, code, symbol, description, status
     FROM currency_types
     WHERE id = ?
       AND (is_deleted = 0 OR is_deleted IS NULL)
     LIMIT 1`,
    [currencyTypeId],
  );
  return rows[0] ?? null;
}

export async function listCurrencyTypes() {
  const rows = await query(
    `SELECT id, name, code, symbol, description, status
     FROM currency_types
     WHERE is_deleted = 0 OR is_deleted IS NULL
     ORDER BY id ASC`,
  );

  return rows.map(mapCurrencyTypeRow);
}

export async function createCurrencyType(userId, payload) {
  const { name, code, symbol, description } = validateCurrencyTypePayload(payload);

  const result = await query(
    `INSERT INTO currency_types
      (user_id, name, code, symbol, description, status, is_deleted)
     VALUES (?, ?, ?, ?, ?, 'ACTIVE', 0)`,
    [userId, name, code, symbol, description],
  );

  const row = await getCurrencyTypeRow(result.insertId);
  return mapCurrencyTypeRow(row);
}

export async function updateCurrencyType(currencyTypeId, userId, payload) {
  const id = parseCurrencyTypeId(currencyTypeId);
  const existing = await getCurrencyTypeRow(id);
  if (!existing) throw validationError('Currency type not found.', 404);

  const { name, code, symbol, description } = validateCurrencyTypePayload(payload);

  await query(
    `UPDATE currency_types
     SET user_id = ?,
         name = ?,
         code = ?,
         symbol = ?,
         description = ?
     WHERE id = ?
       AND (is_deleted = 0 OR is_deleted IS NULL)`,
    [userId, name, code, symbol, description, id],
  );

  const row = await getCurrencyTypeRow(id);
  return mapCurrencyTypeRow(row);
}

export async function deleteCurrencyType(currencyTypeId) {
  const id = parseCurrencyTypeId(currencyTypeId);
  const existing = await getCurrencyTypeRow(id);
  if (!existing) throw validationError('Currency type not found.', 404);

  await query(
    `UPDATE currency_types
     SET is_deleted = 1
     WHERE id = ?`,
    [id],
  );

  return { ok: true, message: 'Successfully deleted the currency type.' };
}

export async function toggleCurrencyTypeStatus(currencyTypeId, active) {
  const id = parseCurrencyTypeId(currencyTypeId);
  const existing = await getCurrencyTypeRow(id);
  if (!existing) throw validationError('Currency type not found.', 404);

  const status = active ? 'ACTIVE' : 'DEACTIVATED';

  await query(
    `UPDATE currency_types
     SET status = ?
     WHERE id = ?
       AND (is_deleted = 0 OR is_deleted IS NULL)`,
    [status, id],
  );

  const row = await getCurrencyTypeRow(id);
  return mapCurrencyTypeRow(row);
}
