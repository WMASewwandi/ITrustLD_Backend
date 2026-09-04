import { query } from '../config/database.js';
import { addColumnIfMissing, createTableIfMissing } from '../db/helpers.js';

const FIELD_TYPES = new Set(['text', 'email', 'number']);
const RESERVED_SLUGS = new Set([
  'bank',
  'bank-transfer',
  'bank_transfer',
  'skrill',
  'neteller',
  'binance',
  'pm',
  'xm',
  'crypto',
  'perfect-money',
  'perfect_money',
  'perfectmoney',
  'card-payment',
  'card_payment',
  'cardpayment',
  'custom',
]);

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

export async function ensureCustomPayAccountSchema() {
  if (schemaReady) return;
  await createTableIfMissing('pay_account_categories', {
    mysql: `
      CREATE TABLE pay_account_categories (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(120) NOT NULL,
        slug VARCHAR(140) NOT NULL,
        is_deleted TINYINT(1) NOT NULL DEFAULT 0,
        created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY pay_account_categories_slug_unique (slug)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `,
    sqlite: `
      CREATE TABLE pay_account_categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        is_deleted INTEGER NOT NULL DEFAULT 0,
        created_at TEXT,
        updated_at TEXT
      )
    `,
  });
  await createTableIfMissing('pay_account_fields', {
    mysql: `
      CREATE TABLE pay_account_fields (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        category_id BIGINT UNSIGNED NOT NULL,
        label VARCHAR(120) NOT NULL,
        field_key VARCHAR(80) NOT NULL,
        field_type VARCHAR(20) NOT NULL DEFAULT 'text',
        is_required TINYINT(1) NOT NULL DEFAULT 1,
        sort_order INT NOT NULL DEFAULT 0,
        is_deleted TINYINT(1) NOT NULL DEFAULT 0,
        created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        KEY pay_account_fields_category_index (category_id, is_deleted, sort_order)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `,
    sqlite: `
      CREATE TABLE pay_account_fields (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category_id INTEGER NOT NULL,
        label TEXT NOT NULL,
        field_key TEXT NOT NULL,
        field_type TEXT NOT NULL DEFAULT 'text',
        is_required INTEGER NOT NULL DEFAULT 1,
        sort_order INTEGER NOT NULL DEFAULT 0,
        is_deleted INTEGER NOT NULL DEFAULT 0,
        created_at TEXT,
        updated_at TEXT
      )
    `,
  });
  await createTableIfMissing('pay_account_records', {
    mysql: `
      CREATE TABLE pay_account_records (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        category_id BIGINT UNSIGNED NOT NULL,
        field_values TEXT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'AVAILABLE',
        is_deleted TINYINT(1) NOT NULL DEFAULT 0,
        created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        KEY pay_account_records_category_index (category_id, is_deleted, status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `,
    sqlite: `
      CREATE TABLE pay_account_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category_id INTEGER NOT NULL,
        field_values TEXT,
        status TEXT NOT NULL DEFAULT 'AVAILABLE',
        is_deleted INTEGER NOT NULL DEFAULT 0,
        created_at TEXT,
        updated_at TEXT
      )
    `,
  });
  await addColumnIfMissing('pay_account_categories', 'payment_option_id', {
    mysql: 'payment_option_id BIGINT UNSIGNED NULL',
    sqlite: 'payment_option_id INTEGER',
  });
  schemaReady = true;
}

function mapField(row) {
  return {
    id: row.id,
    categoryId: row.category_id,
    label: row.label,
    key: row.field_key,
    type: row.field_type,
    required: Boolean(Number(row.is_required)),
    sortOrder: Number(row.sort_order || 0),
  };
}

function mapRecord(row, fields) {
  const values = parseJsonObject(row.field_values);
  const displayFields = (fields || []).map((field) => ({
    key: field.key,
    label: field.label,
    value: values[field.key] != null ? String(values[field.key]) : '',
  }));
  const summary = displayFields
    .map((field) => field.value)
    .filter(Boolean)
    .slice(0, 3)
    .join(' · ');

  return {
    id: row.id,
    categoryId: row.category_id,
    active: String(row.status || '').toUpperCase() === 'AVAILABLE',
    values,
    fields: displayFields,
    summary,
  };
}

async function getCategoryRow(categoryId, { includeDeleted = false } = {}) {
  const params = [categoryId];
  let sql = `SELECT * FROM pay_account_categories WHERE id = ?`;
  if (!includeDeleted) sql += ' AND is_deleted = 0';
  sql += ' LIMIT 1';
  const rows = await query(sql, params);
  return rows[0] || null;
}

async function loadFields(categoryId) {
  const rows = await query(
    `SELECT *
     FROM pay_account_fields
     WHERE category_id = ?
       AND is_deleted = 0
     ORDER BY sort_order ASC, id ASC`,
    [categoryId],
  );
  return rows.map(mapField);
}

async function loadRecords(categoryId, fields, { activeOnly = false } = {}) {
  let sql = `
    SELECT *
    FROM pay_account_records
    WHERE category_id = ?
      AND is_deleted = 0
  `;
  if (activeOnly) sql += ` AND UPPER(status) = 'AVAILABLE'`;
  sql += ' ORDER BY id ASC';
  const rows = await query(sql, [categoryId]);
  return rows.map((row) => mapRecord(row, fields));
}

async function defaultPaymentOptionCurrency() {
  try {
    const rows = await query(
      `SELECT code
       FROM currency_types
       WHERE (is_deleted = 0 OR is_deleted IS NULL)
         AND UPPER(status) = 'ACTIVE'
       ORDER BY CASE WHEN UPPER(code) = 'USD' THEN 0 ELSE 1 END, id ASC
       LIMIT 1`,
    );
    return String(rows[0]?.code || 'USD').trim() || 'USD';
  } catch {
    return 'USD';
  }
}

async function findPaymentOptionByName(name) {
  const rows = await query(
    `SELECT id, payment_option_name
     FROM payment_options
     WHERE LOWER(TRIM(payment_option_name)) = LOWER(?)
     ORDER BY CASE WHEN is_deleted = 0 OR is_deleted IS NULL THEN 0 ELSE 1 END, id ASC
     LIMIT 1`,
    [name],
  );
  return rows[0] || null;
}

async function ensurePaymentOptionForCategory(category) {
  const name = String(category?.name || '').trim();
  const categoryId = Number(category?.id);
  if (!name || !Number.isInteger(categoryId) || categoryId <= 0) return null;

  let optionId = Number(category.payment_option_id) || 0;
  if (optionId) {
    const linked = await query(`SELECT id FROM payment_options WHERE id = ? LIMIT 1`, [optionId]);
    if (linked[0]) {
      await query(
        `UPDATE payment_options
         SET payment_option_name = ?, availability = 'AVAILABLE', is_deleted = 0, updated_at = NOW()
         WHERE id = ?`,
        [name, optionId],
      );
      return optionId;
    }
  }

  const byName = await findPaymentOptionByName(name);
  if (byName) {
    optionId = Number(byName.id);
    await query(
      `UPDATE payment_options
       SET payment_option_name = ?, availability = 'AVAILABLE', is_deleted = 0, updated_at = NOW()
       WHERE id = ?`,
      [name, optionId],
    );
  } else {
    const currency = await defaultPaymentOptionCurrency();
    const result = await query(
      `INSERT INTO payment_options
        (payment_option_name, payment_option_currency, availability, priority,
         minimum_limit, maximum_limit, is_deleted, created_at, updated_at)
       VALUES (?, ?, 'AVAILABLE', 'NO', 1, 1000000, 0, NOW(), NOW())`,
      [name, currency],
    );
    optionId = insertedId(result);
  }

  if (optionId && Number(category.payment_option_id) !== optionId) {
    await query(
      `UPDATE pay_account_categories
       SET payment_option_id = ?, updated_at = NOW()
       WHERE id = ?`,
      [optionId, categoryId],
    );
  }
  return optionId || null;
}

export async function syncCustomPayAccountCategoryPaymentOptions() {
  await ensureCustomPayAccountSchema();
  const categories = await query(
    `SELECT id, name, payment_option_id
     FROM pay_account_categories
     WHERE is_deleted = 0
     ORDER BY id ASC`,
  );
  for (const category of categories) {
    await ensurePaymentOptionForCategory(category);
  }
}

export async function listCustomPayAccountCategoryNames() {
  await syncCustomPayAccountCategoryPaymentOptions();
  const rows = await query(
    `SELECT name
     FROM pay_account_categories
     WHERE is_deleted = 0
     ORDER BY id ASC`,
  );
  return rows.map((row) => String(row.name || '').trim()).filter(Boolean);
}

async function assertUniqueSlug(slug, excludeId = null) {
  const params = [slug];
  let sql = `
    SELECT id
    FROM pay_account_categories
    WHERE slug = ?
      AND is_deleted = 0
  `;
  if (excludeId) {
    sql += ' AND id <> ?';
    params.push(excludeId);
  }
  sql += ' LIMIT 1';
  const rows = await query(sql, params);
  if (rows[0]) {
    throw validationError('A category with this name already exists.');
  }
}

async function assertUniqueFieldKey(categoryId, fieldKey, excludeId = null) {
  const params = [categoryId, fieldKey];
  let sql = `
    SELECT id
    FROM pay_account_fields
    WHERE category_id = ?
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
    throw validationError('A field with this name already exists in this category.');
  }
}

export async function listCustomPayAccountCategories() {
  await ensureCustomPayAccountSchema();
  const categories = await query(
    `SELECT *
     FROM pay_account_categories
     WHERE is_deleted = 0
     ORDER BY id ASC`,
  );
  const result = [];
  for (const category of categories) {
    const fields = await loadFields(category.id);
    const accounts = await loadRecords(category.id, fields);
    result.push({
      id: category.id,
      name: category.name,
      slug: category.slug,
      fields,
      accounts,
    });
  }
  return result;
}

export async function createCustomPayAccountCategory(payload) {
  await ensureCustomPayAccountSchema();
  const name = String(payload.name ?? '').trim();
  if (!name) throw validationError('Category name is required.');
  const slug = slugify(name);
  if (!slug) throw validationError('Category name is invalid.');
  if (RESERVED_SLUGS.has(slug)) {
    throw validationError('That category name is reserved.');
  }
  await assertUniqueSlug(slug);

  const result = await query(
    `INSERT INTO pay_account_categories (name, slug, is_deleted, created_at, updated_at)
     VALUES (?, ?, 0, NOW(), NOW())`,
    [name, slug],
  );
  const newId = insertedId(result);
  await ensurePaymentOptionForCategory({ id: newId, name, payment_option_id: null });
  const categories = await listCustomPayAccountCategories();
  return categories.find((item) => Number(item.id) === newId) || {
    id: newId,
    name,
    slug,
    fields: [],
    accounts: [],
  };
}

export async function updateCustomPayAccountCategory(categoryId, payload) {
  await ensureCustomPayAccountSchema();
  const id = parseId(categoryId, 'Category id');
  const existing = await getCategoryRow(id);
  if (!existing) throw validationError('Category not found.', 404);

  const name = String(payload.name ?? '').trim();
  if (!name) throw validationError('Category name is required.');
  const slug = slugify(name);
  if (!slug) throw validationError('Category name is invalid.');
  if (RESERVED_SLUGS.has(slug)) {
    throw validationError('That category name is reserved.');
  }
  await assertUniqueSlug(slug, id);

  await query(
    `UPDATE pay_account_categories
     SET name = ?, slug = ?, updated_at = NOW()
     WHERE id = ? AND is_deleted = 0`,
    [name, slug, id],
  );
  await ensurePaymentOptionForCategory({
    id,
    name,
    payment_option_id: existing.payment_option_id,
  });
  const categories = await listCustomPayAccountCategories();
  return categories.find((item) => Number(item.id) === id);
}

export async function deleteCustomPayAccountCategory(categoryId) {
  await ensureCustomPayAccountSchema();
  const id = parseId(categoryId, 'Category id');
  const existing = await getCategoryRow(id);
  if (!existing) throw validationError('Category not found.', 404);

  const freedSlug = `${String(existing.slug || 'category').slice(0, 100)}-deleted-${id}`;
  await query(
    `UPDATE pay_account_categories
     SET is_deleted = 1, slug = ?, updated_at = NOW()
     WHERE id = ?`,
    [freedSlug, id],
  );
  await query(`UPDATE pay_account_fields SET is_deleted = 1, updated_at = NOW() WHERE category_id = ?`, [id]);
  await query(`UPDATE pay_account_records SET is_deleted = 1, updated_at = NOW() WHERE category_id = ?`, [id]);
  return { ok: true };
}

export async function createCustomPayAccountField(categoryId, payload) {
  await ensureCustomPayAccountSchema();
  const id = parseId(categoryId, 'Category id');
  const existing = await getCategoryRow(id);
  if (!existing) throw validationError('Category not found.', 404);

  const label = String(payload.label ?? '').trim();
  if (!label) throw validationError('Field name is required.');
  const fieldKey = slugify(payload.key || label).replace(/-/g, '_');
  if (!fieldKey) throw validationError('Field name is invalid.');
  await assertUniqueFieldKey(id, fieldKey);

  const fieldType = parseFieldType(payload.type ?? payload.fieldType);
  const required = parseBooleanFlag(payload.required ?? payload.is_required, true);
  const maxOrderRows = await query(
    `SELECT MAX(sort_order) AS max_order FROM pay_account_fields WHERE category_id = ? AND is_deleted = 0`,
    [id],
  );
  const sortOrder = Number(maxOrderRows[0]?.max_order || 0) + 1;

  const result = await query(
    `INSERT INTO pay_account_fields
      (category_id, label, field_key, field_type, is_required, sort_order, is_deleted, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, NOW(), NOW())`,
    [id, label, fieldKey, fieldType, required ? 1 : 0, sortOrder],
  );

  return {
    id: insertedId(result),
    categoryId: id,
    label,
    key: fieldKey,
    type: fieldType,
    required,
    sortOrder,
  };
}

export async function updateCustomPayAccountField(fieldId, payload) {
  await ensureCustomPayAccountSchema();
  const id = parseId(fieldId, 'Field id');
  const rows = await query(
    `SELECT * FROM pay_account_fields WHERE id = ? AND is_deleted = 0 LIMIT 1`,
    [id],
  );
  const existing = rows[0];
  if (!existing) throw validationError('Field not found.', 404);

  const label = String(payload.label ?? existing.label).trim();
  if (!label) throw validationError('Field name is required.');
  const fieldKey = payload.key
    ? slugify(payload.key).replace(/-/g, '_')
    : existing.field_key;
  if (!fieldKey) throw validationError('Field name is invalid.');
  await assertUniqueFieldKey(existing.category_id, fieldKey, id);
  const fieldType = parseFieldType(payload.type ?? payload.fieldType ?? existing.field_type);
  const required = parseBooleanFlag(payload.required ?? payload.is_required, Boolean(Number(existing.is_required)));

  await query(
    `UPDATE pay_account_fields
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

export async function deleteCustomPayAccountField(fieldId) {
  await ensureCustomPayAccountSchema();
  const id = parseId(fieldId, 'Field id');
  const rows = await query(
    `SELECT * FROM pay_account_fields WHERE id = ? AND is_deleted = 0 LIMIT 1`,
    [id],
  );
  if (!rows[0]) throw validationError('Field not found.', 404);
  await query(`UPDATE pay_account_fields SET is_deleted = 1, updated_at = NOW() WHERE id = ?`, [id]);
  return { ok: true };
}

function validateRecordValues(fields, payloadValues) {
  const incoming = payloadValues && typeof payloadValues === 'object' ? payloadValues : {};
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

export async function createCustomPayAccountRecord(categoryId, payload) {
  await ensureCustomPayAccountSchema();
  const id = parseId(categoryId, 'Category id');
  const existing = await getCategoryRow(id);
  if (!existing) throw validationError('Category not found.', 404);
  const fields = await loadFields(id);
  if (!fields.length) {
    throw validationError('Add at least one field before creating an account.');
  }
  const values = validateRecordValues(fields, payload.values || payload);
  const result = await query(
    `INSERT INTO pay_account_records
      (category_id, field_values, status, is_deleted, created_at, updated_at)
     VALUES (?, ?, 'AVAILABLE', 0, NOW(), NOW())`,
    [id, JSON.stringify(values)],
  );
  return mapRecord(
    {
      id: insertedId(result),
      category_id: id,
      field_values: JSON.stringify(values),
      status: 'AVAILABLE',
    },
    fields,
  );
}

export async function updateCustomPayAccountRecord(recordId, payload) {
  await ensureCustomPayAccountSchema();
  const id = parseId(recordId, 'Account id');
  const rows = await query(
    `SELECT * FROM pay_account_records WHERE id = ? AND is_deleted = 0 LIMIT 1`,
    [id],
  );
  const existing = rows[0];
  if (!existing) throw validationError('Account not found.', 404);
  const fields = await loadFields(existing.category_id);
  const values = validateRecordValues(fields, payload.values || payload);
  await query(
    `UPDATE pay_account_records
     SET field_values = ?, updated_at = NOW()
     WHERE id = ?`,
    [JSON.stringify(values), id],
  );
  return mapRecord({ ...existing, field_values: JSON.stringify(values) }, fields);
}

export async function deleteCustomPayAccountRecord(recordId) {
  await ensureCustomPayAccountSchema();
  const id = parseId(recordId, 'Account id');
  const rows = await query(
    `SELECT id FROM pay_account_records WHERE id = ? AND is_deleted = 0 LIMIT 1`,
    [id],
  );
  if (!rows[0]) throw validationError('Account not found.', 404);
  await query(`UPDATE pay_account_records SET is_deleted = 1, updated_at = NOW() WHERE id = ?`, [id]);
  return { ok: true, message: 'Successfully deleted the admin pay account.' };
}

export async function toggleCustomPayAccountRecord(recordId, active) {
  await ensureCustomPayAccountSchema();
  const id = parseId(recordId, 'Account id');
  const rows = await query(
    `SELECT * FROM pay_account_records WHERE id = ? AND is_deleted = 0 LIMIT 1`,
    [id],
  );
  const existing = rows[0];
  if (!existing) throw validationError('Account not found.', 404);
  const status = active ? 'AVAILABLE' : 'NOT_AVAILABLE';
  await query(
    `UPDATE pay_account_records SET status = ?, updated_at = NOW() WHERE id = ?`,
    [status, id],
  );
  const fields = await loadFields(existing.category_id);
  return mapRecord({ ...existing, status }, fields);
}

export async function customPayAccountExists(recordId) {
  await ensureCustomPayAccountSchema();
  const id = Number(recordId);
  if (!Number.isInteger(id) || id <= 0) return false;
  const rows = await query(
    `SELECT id FROM pay_account_records WHERE id = ? AND is_deleted = 0 LIMIT 1`,
    [id],
  );
  return Boolean(rows[0]);
}

export async function loadCustomPayAccountByRecordId(recordId, { activeOnly = true } = {}) {
  await ensureCustomPayAccountSchema();
  const id = Number(recordId);
  if (!Number.isInteger(id) || id <= 0) return { type: null, accounts: [] };
  let sql = `
    SELECT r.*, c.name AS category_name
    FROM pay_account_records r
    INNER JOIN pay_account_categories c ON c.id = r.category_id
    WHERE r.id = ?
      AND r.is_deleted = 0
      AND c.is_deleted = 0
  `;
  if (activeOnly) sql += ` AND UPPER(r.status) = 'AVAILABLE'`;
  sql += ' LIMIT 1';
  const rows = await query(sql, [id]);
  if (!rows[0]) return { type: 'custom', accounts: [] };
  const fields = await loadFields(rows[0].category_id);
  const account = mapRecord(rows[0], fields);
  return {
    type: 'custom',
    accounts: [{ ...account, categoryName: rows[0].category_name }],
  };
}

export async function loadCustomPayAccountsByCategoryName(name) {
  await ensureCustomPayAccountSchema();
  const needle = String(name || '').trim().toLowerCase();
  if (!needle) return { type: null, accounts: [] };
  const categories = await query(
    `SELECT *
     FROM pay_account_categories
     WHERE is_deleted = 0
       AND (LOWER(TRIM(name)) = ? OR LOWER(TRIM(slug)) = ? OR LOWER(REPLACE(slug, '-', ' ')) = ?)
     LIMIT 1`,
    [needle, needle.replace(/\s+/g, '-'), needle],
  );
  if (!categories[0]) return { type: null, accounts: [] };
  const fields = await loadFields(categories[0].id);
  const accounts = await loadRecords(categories[0].id, fields, { activeOnly: true });
  return {
    type: 'custom',
    accounts: accounts.map((account) => ({ ...account, categoryName: categories[0].name })),
  };
}
