import { getDbDriver, query } from '../config/database.js';
import { addColumnIfMissing, createTableIfMissing } from '../db/helpers.js';

const FIELD_TYPES = new Set(['text', 'email', 'number']);

export const BUILTIN_PAY_ACCOUNT_TYPES = ['bank', 'skrill', 'neteller', 'binance', 'pm', 'xm'];

export const DEFAULT_BUILTIN_DISPLAY_NAMES = {
  bank: 'Bank Account',
  skrill: 'Skrill Wallet',
  neteller: 'Neteller Wallet',
  binance: 'Crypto Wallet (Binance)',
  pm: 'Perfect Money Account',
  xm: 'XM Local Deposit Account',
};

const RESERVED_EXTRA_FIELD_KEYS = {
  bank: new Set([
    'accountnumber',
    'account_number',
    'name',
    'bank',
    'branch',
    'beneficiaryname',
    'beneficiary_name',
  ]),
  skrill: new Set(['email', 'skrill_email', 'skrillemail']),
  neteller: new Set(['email', 'neteller_email', 'netelleremail']),
  binance: new Set([
    'trc20walletaddress',
    'trc20_wallet_address',
    'binanceemail',
    'binance_email',
    'email',
  ]),
  pm: new Set(['accountid', 'account_id', 'pmaccountid', 'pm_account_id']),
  xm: new Set(['accountid', 'account_id', 'xmaccountid', 'xm_account_id']),
};

const PANEL_TYPE_TO_BUILTIN = {
  bank_transfer: 'bank',
  skrill: 'skrill',
  neteller: 'neteller',
  binance: 'binance',
  xm: 'xm',
  perfect_money: 'pm',
};

let schemaReady = false;

function validationError(message, status = 422) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function slugify(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function parseId(value, label = 'Id') {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw validationError(`${label} is required.`);
  }
  return id;
}

function parseFieldType(value) {
  const type = String(value || 'text').trim().toLowerCase();
  if (!FIELD_TYPES.has(type)) {
    throw validationError('Field type must be text, email, or number.');
  }
  return type;
}

function parseBooleanFlag(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function parseJsonObject(raw) {
  if (!raw) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function insertedId(result) {
  const id = Number(result?.insertId ?? result?.lastInsertRowid ?? 0);
  return Number.isInteger(id) && id > 0 ? id : 0;
}

function normalizeKeyLookup(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

export function parseBuiltinAccountType(accountType) {
  const type = String(accountType || '').trim().toLowerCase();
  if (!BUILTIN_PAY_ACCOUNT_TYPES.includes(type)) {
    throw validationError('Invalid account type.', 400);
  }
  return type;
}

export async function ensureBuiltinPayAccountMetaSchema() {
  if (schemaReady) return;
  await createTableIfMissing('pay_account_builtin_meta', {
    mysql: `
      CREATE TABLE pay_account_builtin_meta (
        account_type VARCHAR(32) NOT NULL PRIMARY KEY,
        display_name VARCHAR(120) NOT NULL,
        created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `,
    sqlite: `
      CREATE TABLE pay_account_builtin_meta (
        account_type TEXT NOT NULL PRIMARY KEY,
        display_name TEXT NOT NULL,
        created_at TEXT,
        updated_at TEXT
      )
    `,
  });
  await addColumnIfMissing('pay_account_builtin_meta', 'is_active', {
    mysql: 'is_active TINYINT(1) NOT NULL DEFAULT 1',
    sqlite: 'is_active INTEGER NOT NULL DEFAULT 1',
  });
  await createTableIfMissing('pay_account_builtin_fields', {
    mysql: `
      CREATE TABLE pay_account_builtin_fields (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        account_type VARCHAR(32) NOT NULL,
        label VARCHAR(120) NOT NULL,
        field_key VARCHAR(80) NOT NULL,
        field_type VARCHAR(20) NOT NULL DEFAULT 'text',
        is_required TINYINT(1) NOT NULL DEFAULT 0,
        sort_order INT NOT NULL DEFAULT 0,
        is_deleted TINYINT(1) NOT NULL DEFAULT 0,
        created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        KEY pay_account_builtin_fields_type_index (account_type, is_deleted, sort_order)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `,
    sqlite: `
      CREATE TABLE pay_account_builtin_fields (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_type TEXT NOT NULL,
        label TEXT NOT NULL,
        field_key TEXT NOT NULL,
        field_type TEXT NOT NULL DEFAULT 'text',
        is_required INTEGER NOT NULL DEFAULT 0,
        sort_order INTEGER NOT NULL DEFAULT 0,
        is_deleted INTEGER NOT NULL DEFAULT 0,
        created_at TEXT,
        updated_at TEXT
      )
    `,
  });
  await createTableIfMissing('pay_account_builtin_values', {
    mysql: `
      CREATE TABLE pay_account_builtin_values (
        account_type VARCHAR(32) NOT NULL,
        account_id BIGINT UNSIGNED NOT NULL,
        field_values TEXT NULL,
        created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (account_type, account_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `,
    sqlite: `
      CREATE TABLE pay_account_builtin_values (
        account_type TEXT NOT NULL,
        account_id INTEGER NOT NULL,
        field_values TEXT,
        created_at TEXT,
        updated_at TEXT,
        PRIMARY KEY (account_type, account_id)
      )
    `,
  });
  schemaReady = true;
}

function mapField(row) {
  return {
    id: row.id,
    accountType: row.account_type,
    label: row.label,
    key: row.field_key,
    type: row.field_type,
    required: Boolean(Number(row.is_required)),
    sortOrder: Number(row.sort_order || 0),
  };
}

async function loadFields(accountType) {
  const rows = await query(
    `SELECT *
     FROM pay_account_builtin_fields
     WHERE account_type = ?
       AND is_deleted = 0
     ORDER BY sort_order ASC, id ASC`,
    [accountType],
  );
  return rows.map(mapField);
}

async function loadAllFieldsByType() {
  const rows = await query(
    `SELECT *
     FROM pay_account_builtin_fields
     WHERE is_deleted = 0
     ORDER BY account_type ASC, sort_order ASC, id ASC`,
  );
  const byType = {};
  for (const type of BUILTIN_PAY_ACCOUNT_TYPES) byType[type] = [];
  for (const row of rows) {
    const type = String(row.account_type || '').trim().toLowerCase();
    if (!byType[type]) byType[type] = [];
    byType[type].push(mapField(row));
  }
  return byType;
}

async function assertUniqueFieldKey(accountType, fieldKey, excludeId = null) {
  const params = [accountType, fieldKey];
  let sql = `
    SELECT id
    FROM pay_account_builtin_fields
    WHERE account_type = ?
      AND field_key = ?
      AND is_deleted = 0
  `;
  if (excludeId) {
    sql += ' AND id <> ?';
    params.push(excludeId);
  }
  sql += ' LIMIT 1';
  const rows = await query(sql, params);
  if (rows[0]) {
    throw validationError('A field with this name already exists for this account type.');
  }
}

function assertNotReservedKey(accountType, fieldKey) {
  const reserved = RESERVED_EXTRA_FIELD_KEYS[accountType] || new Set();
  if (reserved.has(normalizeKeyLookup(fieldKey))) {
    throw validationError('That field name is reserved for the original account details.');
  }
}

export async function getBuiltinPayAccountMetaMap() {
  await ensureBuiltinPayAccountMetaSchema();
  const [metaRows, fieldsByType] = await Promise.all([
    query(`SELECT account_type, display_name, is_active FROM pay_account_builtin_meta`),
    loadAllFieldsByType(),
  ]);
  const displayByType = {};
  const activeByType = {};
  for (const row of metaRows) {
    const type = String(row.account_type || '').trim().toLowerCase();
    const name = String(row.display_name || '').trim();
    if (type && name) displayByType[type] = name;
    if (type) {
      activeByType[type] =
        row.is_active === undefined || row.is_active === null ? true : Number(row.is_active) !== 0;
    }
  }

  const meta = {};
  for (const type of BUILTIN_PAY_ACCOUNT_TYPES) {
    meta[type] = {
      accountType: type,
      displayName: displayByType[type] || DEFAULT_BUILTIN_DISPLAY_NAMES[type] || type,
      isActive: activeByType[type] !== false,
      fields: fieldsByType[type] || [],
    };
  }
  return meta;
}

function normalizeCategoryName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

async function assertBuiltinDisplayNameAvailable(displayName, excludeType) {
  const needle = normalizeCategoryName(displayName);
  if (!needle) return;
  const meta = await getBuiltinPayAccountMetaMap();
  for (const type of BUILTIN_PAY_ACCOUNT_TYPES) {
    if (type === excludeType) continue;
    if (normalizeCategoryName(meta[type]?.displayName) === needle) {
      throw validationError('A category with this name already exists.');
    }
  }
  try {
    const rows = await query(
      `SELECT name
       FROM pay_account_categories
       WHERE is_deleted = 0`,
    );
    if (rows.some((row) => normalizeCategoryName(row.name) === needle)) {
      throw validationError('A category with this name already exists.');
    }
  } catch (error) {
    if (error?.status) throw error;
  }
}

export async function renameBuiltinPayAccountDisplayName(accountType, payload) {
  await ensureBuiltinPayAccountMetaSchema();
  const type = parseBuiltinAccountType(accountType);
  const displayName = String(payload?.displayName ?? payload?.name ?? '').trim();
  if (!displayName) throw validationError('Display name is required.');
  if (displayName.length > 120) throw validationError('Display name is too long.');
  await assertBuiltinDisplayNameAvailable(displayName, type);

  if (getDbDriver() === 'sqlite') {
    await query(
      `INSERT INTO pay_account_builtin_meta (account_type, display_name, created_at, updated_at)
       VALUES (?, ?, datetime('now'), datetime('now'))
       ON CONFLICT(account_type) DO UPDATE SET
         display_name = excluded.display_name,
         updated_at = datetime('now')`,
      [type, displayName],
    );
  } else {
    await query(
      `INSERT INTO pay_account_builtin_meta (account_type, display_name, created_at, updated_at)
       VALUES (?, ?, NOW(), NOW())
       ON DUPLICATE KEY UPDATE display_name = VALUES(display_name), updated_at = NOW()`,
      [type, displayName],
    );
  }

  const meta = await getBuiltinPayAccountMetaMap();
  return meta[type];
}

export async function setBuiltinPayAccountActive(accountType, active) {
  await ensureBuiltinPayAccountMetaSchema();
  const type = parseBuiltinAccountType(accountType);
  const nextActive = parseBooleanFlag(active, false) ? 1 : 0;
  const meta = await getBuiltinPayAccountMetaMap();
  const displayName = meta[type]?.displayName || DEFAULT_BUILTIN_DISPLAY_NAMES[type] || type;

  if (getDbDriver() === 'sqlite') {
    await query(
      `INSERT INTO pay_account_builtin_meta (account_type, display_name, is_active, created_at, updated_at)
       VALUES (?, ?, ?, datetime('now'), datetime('now'))
       ON CONFLICT(account_type) DO UPDATE SET
         is_active = excluded.is_active,
         updated_at = datetime('now')`,
      [type, displayName, nextActive],
    );
  } else {
    await query(
      `INSERT INTO pay_account_builtin_meta (account_type, display_name, is_active, created_at, updated_at)
       VALUES (?, ?, ?, NOW(), NOW())
       ON DUPLICATE KEY UPDATE is_active = VALUES(is_active), updated_at = NOW()`,
      [type, displayName, nextActive],
    );
  }

  const nextMeta = await getBuiltinPayAccountMetaMap();
  return nextMeta[type];
}

export async function createBuiltinPayAccountField(accountType, payload) {
  await ensureBuiltinPayAccountMetaSchema();
  const type = parseBuiltinAccountType(accountType);
  const label = String(payload?.label ?? '').trim();
  if (!label) throw validationError('Field name is required.');
  const fieldKey = slugify(payload?.key || label).replace(/-/g, '_');
  if (!fieldKey) throw validationError('Field name is invalid.');
  assertNotReservedKey(type, fieldKey);
  await assertUniqueFieldKey(type, fieldKey);

  const fieldType = parseFieldType(payload?.type ?? payload?.fieldType);
  const required = parseBooleanFlag(payload?.required ?? payload?.is_required, false);
  const maxOrderRows = await query(
    `SELECT MAX(sort_order) AS max_order
     FROM pay_account_builtin_fields
     WHERE account_type = ?
       AND is_deleted = 0`,
    [type],
  );
  const sortOrder = Number(maxOrderRows[0]?.max_order || 0) + 1;

  const result = await query(
    `INSERT INTO pay_account_builtin_fields
      (account_type, label, field_key, field_type, is_required, sort_order, is_deleted, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, NOW(), NOW())`,
    [type, label, fieldKey, fieldType, required ? 1 : 0, sortOrder],
  );

  return {
    id: insertedId(result),
    accountType: type,
    label,
    key: fieldKey,
    type: fieldType,
    required,
    sortOrder,
  };
}

export async function updateBuiltinPayAccountField(fieldId, payload) {
  await ensureBuiltinPayAccountMetaSchema();
  const id = parseId(fieldId, 'Field id');
  const rows = await query(
    `SELECT * FROM pay_account_builtin_fields WHERE id = ? AND is_deleted = 0 LIMIT 1`,
    [id],
  );
  const existing = rows[0];
  if (!existing) throw validationError('Field not found.', 404);

  const label = String(payload?.label ?? existing.label).trim();
  if (!label) throw validationError('Field name is required.');
  const fieldKey = payload?.key
    ? slugify(payload.key).replace(/-/g, '_')
    : existing.field_key;
  if (!fieldKey) throw validationError('Field name is invalid.');
  assertNotReservedKey(existing.account_type, fieldKey);
  await assertUniqueFieldKey(existing.account_type, fieldKey, id);
  const fieldType = parseFieldType(payload?.type ?? payload?.fieldType ?? existing.field_type);
  const required = parseBooleanFlag(
    payload?.required ?? payload?.is_required,
    Boolean(Number(existing.is_required)),
  );

  await query(
    `UPDATE pay_account_builtin_fields
     SET label = ?, field_key = ?, field_type = ?, is_required = ?, updated_at = NOW()
     WHERE id = ?`,
    [label, fieldKey, fieldType, required ? 1 : 0, id],
  );

  return mapField({
    ...existing,
    label,
    field_key: fieldKey,
    field_type: fieldType,
    is_required: required ? 1 : 0,
  });
}

export async function deleteBuiltinPayAccountField(fieldId) {
  await ensureBuiltinPayAccountMetaSchema();
  const id = parseId(fieldId, 'Field id');
  const rows = await query(
    `SELECT * FROM pay_account_builtin_fields WHERE id = ? AND is_deleted = 0 LIMIT 1`,
    [id],
  );
  if (!rows[0]) throw validationError('Field not found.', 404);
  await query(
    `UPDATE pay_account_builtin_fields SET is_deleted = 1, updated_at = NOW() WHERE id = ?`,
    [id],
  );
  return { ok: true };
}

function normalizeIncomingExtraValues(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {};
  if (payload.extraValues && typeof payload.extraValues === 'object') return payload.extraValues;
  if (payload.extra_values && typeof payload.extra_values === 'object') return payload.extra_values;
  return {};
}

function payloadHasExtraValues(payload) {
  if (!payload || typeof payload !== 'object') return false;
  return payload.extraValues !== undefined || payload.extra_values !== undefined;
}

function validateExtraValues(fields, incoming) {
  const values = {};
  for (const field of fields) {
    const raw = incoming[field.key] ?? incoming[field.id] ?? '';
    const value = String(raw ?? '').trim();
    if (field.required && !value) {
      throw validationError(`${field.label} is required.`);
    }
    if (value && field.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      throw validationError(`${field.label} must be a valid email.`);
    }
    if (value && field.type === 'number' && Number.isNaN(Number(value))) {
      throw validationError(`${field.label} must be a number.`);
    }
    values[field.key] = value;
  }
  return values;
}

export async function validateBuiltinExtraPayload(accountType, payload) {
  if (!payloadHasExtraValues(payload)) return;
  await ensureBuiltinPayAccountMetaSchema();
  const type = parseBuiltinAccountType(accountType);
  const fields = await loadFields(type);
  validateExtraValues(fields, normalizeIncomingExtraValues(payload));
}

export async function saveBuiltinExtraValues(accountType, accountId, payload) {
  if (!payloadHasExtraValues(payload)) return;
  await ensureBuiltinPayAccountMetaSchema();
  const type = parseBuiltinAccountType(accountType);
  const id = parseId(accountId, 'Account id');
  const fields = await loadFields(type);
  const values = validateExtraValues(fields, normalizeIncomingExtraValues(payload));

  const encoded = JSON.stringify(values);
  if (getDbDriver() === 'sqlite') {
    await query(
      `INSERT INTO pay_account_builtin_values (account_type, account_id, field_values, created_at, updated_at)
       VALUES (?, ?, ?, datetime('now'), datetime('now'))
       ON CONFLICT(account_type, account_id) DO UPDATE SET
         field_values = excluded.field_values,
         updated_at = datetime('now')`,
      [type, id, encoded],
    );
  } else {
    await query(
      `INSERT INTO pay_account_builtin_values (account_type, account_id, field_values, created_at, updated_at)
       VALUES (?, ?, ?, NOW(), NOW())
       ON DUPLICATE KEY UPDATE field_values = VALUES(field_values), updated_at = NOW()`,
      [type, id, encoded],
    );
  }
}

export async function attachExtraFieldsToAccounts(accountType, accounts) {
  const rows = Array.isArray(accounts) ? accounts : [];
  if (!rows.length) return rows;
  try {
    await ensureBuiltinPayAccountMetaSchema();
    const type = parseBuiltinAccountType(accountType);
    const fields = await loadFields(type);
    const ids = rows.map((row) => Number(row.id)).filter((id) => Number.isInteger(id) && id > 0);
    const valuesById = {};
    if (ids.length) {
      const placeholders = ids.map(() => '?').join(', ');
      const valueRows = await query(
        `SELECT account_id, field_values
         FROM pay_account_builtin_values
         WHERE account_type = ?
           AND account_id IN (${placeholders})`,
        [type, ...ids],
      );
      for (const row of valueRows) {
        valuesById[Number(row.account_id)] = parseJsonObject(row.field_values);
      }
    }

    return rows.map((account) => {
      const extraValues = valuesById[Number(account.id)] || {};
      const extraFields = fields.map((field) => ({
        key: field.key,
        label: field.label,
        value: extraValues[field.key] != null ? String(extraValues[field.key]) : '',
      }));
      return {
        ...account,
        extraValues,
        extraFields,
      };
    });
  } catch (error) {
    console.error('[pay-accounts] extra fields attach skipped', error);
    return rows;
  }
}

export async function withBuiltinExtraFields(builtinType, payload) {
  if (!payload || typeof payload !== 'object') return payload;
  if (!builtinType && payload.type) {
    builtinType = PANEL_TYPE_TO_BUILTIN[payload.type];
  }
  if (!builtinType || !BUILTIN_PAY_ACCOUNT_TYPES.includes(builtinType)) {
    return payload;
  }
  const accounts = await attachExtraFieldsToAccounts(builtinType, payload.accounts || []);
  return { ...payload, accounts };
}

export async function withPanelPaymentAccountExtras(payload) {
  const builtinType = PANEL_TYPE_TO_BUILTIN[payload?.type];
  if (!builtinType) return payload;
  return withBuiltinExtraFields(builtinType, payload);
}
