import { getDbDriver, query } from '../config/database.js';
import { createTableIfMissing } from '../db/helpers.js';
import {
  isRejectReasonCategory,
  REJECT_REASON_CATEGORIES,
} from '../constants/rejectReasons.js';
import { nowSqlDateTime } from '../utils/slTime.js';

let schemaReady = false;

function validationError(message, status = 422) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function isDuplicateReasonError(error) {
  const code = error?.code || error?.errno;
  if (code === 'ER_DUP_ENTRY' || code === 1062) return true;
  const message = String(error?.message || '').toLowerCase();
  return message.includes('unique') || message.includes('duplicate');
}

async function ensureRejectReasonsSchema() {
  if (schemaReady) return;
  await createTableIfMissing('reject_reasons', {
    mysql: `
      CREATE TABLE reject_reasons (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        category VARCHAR(50) NOT NULL,
        message VARCHAR(500) NOT NULL,
        sort_order INT NOT NULL DEFAULT 0,
        created_by BIGINT UNSIGNED NULL,
        created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY reject_reasons_category_message_unique (category, message),
        KEY reject_reasons_category_sort_index (category, sort_order)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `,
    sqlite: `
      CREATE TABLE reject_reasons (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL,
        message TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_by INTEGER,
        created_at TEXT,
        updated_at TEXT,
        UNIQUE (category, message)
      )
    `,
  });
  schemaReady = true;
}

function parseId(id) {
  const value = Number(id);
  if (!Number.isInteger(value) || value <= 0) {
    throw validationError('Reject reason id is required.');
  }
  return value;
}

function normalizeCategory(value) {
  const category = String(value || '').trim();
  if (!isRejectReasonCategory(category)) {
    throw validationError('Select a valid reject-reason category.');
  }
  return category;
}

function normalizeMessage(value) {
  const message = String(value || '').trim().replace(/\s+/g, ' ');
  if (!message) throw validationError('Reason is required.');
  if (message.length > 500) throw validationError('Reason must be 500 characters or fewer.');
  return message;
}

function mapRow(row) {
  return {
    id: row.id,
    category: row.category,
    message: row.message,
    sortOrder: Number(row.sort_order) || 0,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

async function getRow(id) {
  const rows = await query(
    `SELECT id, category, message, sort_order, created_at, updated_at
     FROM reject_reasons
     WHERE id = ?
     LIMIT 1`,
    [id],
  );
  return rows[0] ?? null;
}

async function nextSortOrder(category) {
  const rows = await query(
    `SELECT MAX(sort_order) AS max_sort FROM reject_reasons WHERE category = ?`,
    [category],
  );
  return (Number(rows[0]?.max_sort) || 0) + 1;
}

export async function listRejectReasons(category) {
  await ensureRejectReasonsSchema();
  const params = [];
  let where = '';
  if (category) {
    where = 'WHERE category = ?';
    params.push(normalizeCategory(category));
  }
  const rows = await query(
    `SELECT id, category, message, sort_order, created_at, updated_at
     FROM reject_reasons
     ${where}
     ORDER BY category ASC, sort_order ASC, id ASC`,
    params,
  );
  return {
    categories: REJECT_REASON_CATEGORIES,
    reasons: rows.map(mapRow),
  };
}

export async function createRejectReason(userId, payload) {
  await ensureRejectReasonsSchema();
  const category = normalizeCategory(payload?.category);
  const message = normalizeMessage(payload?.message);
  const sortOrder = await nextSortOrder(category);
  const now = nowSqlDateTime();

  try {
    const result = await query(
      `INSERT INTO reject_reasons (category, message, sort_order, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [category, message, sortOrder, userId || null, now, now],
    );
    const id = result.insertId ?? result.lastInsertRowid;
    const row = await getRow(id);
    return mapRow(row);
  } catch (error) {
    if (isDuplicateReasonError(error)) {
      throw validationError('This reason already exists in the selected category.');
    }
    throw error;
  }
}

export async function updateRejectReason(id, payload) {
  await ensureRejectReasonsSchema();
  const reasonId = parseId(id);
  const existing = await getRow(reasonId);
  if (!existing) throw validationError('Reject reason not found.', 404);

  const message = normalizeMessage(payload?.message ?? existing.message);
  const now = nowSqlDateTime();

  try {
    await query(
      `UPDATE reject_reasons
       SET message = ?, updated_at = ?
       WHERE id = ?`,
      [message, now, reasonId],
    );
  } catch (error) {
    if (isDuplicateReasonError(error)) {
      throw validationError('This reason already exists in the selected category.');
    }
    throw error;
  }

  const row = await getRow(reasonId);
  return mapRow(row);
}

export async function deleteRejectReason(id) {
  await ensureRejectReasonsSchema();
  const reasonId = parseId(id);
  const existing = await getRow(reasonId);
  if (!existing) throw validationError('Reject reason not found.', 404);
  await query(`DELETE FROM reject_reasons WHERE id = ?`, [reasonId]);
  return { ok: true };
}

export async function moveRejectReason(id, direction) {
  await ensureRejectReasonsSchema();
  const reasonId = parseId(id);
  const current = await getRow(reasonId);
  if (!current) throw validationError('Reject reason not found.', 404);

  const dir = String(direction || '').toLowerCase();
  if (dir !== 'up' && dir !== 'down') {
    throw validationError('Move direction must be up or down.');
  }

  const neighbors = await query(
    `SELECT id, category, message, sort_order, created_at, updated_at
     FROM reject_reasons
     WHERE category = ?
     ORDER BY sort_order ASC, id ASC`,
    [current.category],
  );
  const index = neighbors.findIndex((row) => Number(row.id) === reasonId);
  const swapIndex = dir === 'up' ? index - 1 : index + 1;
  if (index < 0 || swapIndex < 0 || swapIndex >= neighbors.length) {
    return mapRow(current);
  }

  const other = neighbors[swapIndex];
  const now = nowSqlDateTime();
  const currentSort = Number(current.sort_order) || 0;
  const otherSort = Number(other.sort_order) || 0;

  if (getDbDriver() === 'sqlite') {
    await query(`UPDATE reject_reasons SET sort_order = ?, updated_at = ? WHERE id = ?`, [
      otherSort,
      now,
      reasonId,
    ]);
    await query(`UPDATE reject_reasons SET sort_order = ?, updated_at = ? WHERE id = ?`, [
      currentSort,
      now,
      other.id,
    ]);
  } else {
    await query(
      `UPDATE reject_reasons
       SET sort_order = CASE id WHEN ? THEN ? WHEN ? THEN ? END,
           updated_at = ?
       WHERE id IN (?, ?)`,
      [reasonId, otherSort, other.id, currentSort, now, reasonId, other.id],
    );
  }

  const row = await getRow(reasonId);
  return mapRow(row);
}
