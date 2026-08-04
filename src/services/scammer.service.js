import { query } from '../config/database.js';

function validationError(message, status = 422) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function formatTimestamp(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function mapScammerRow(row) {
  return {
    id: row.id,
    platformId: row.platform_id || '—',
    name: row.customer_name || '—',
    userId: row.user_id != null ? String(row.user_id) : '—',
    notes: row.notes || '—',
    added: formatTimestamp(row.created_at),
  };
}

/**
 * Batch-check scammer flags by platform ID and/or user ID.
 * Accepts either a list of platform ID strings (legacy) or
 * `{ platformIds, userIds }`.
 *
 * Returns `{ byPlatform, byUser }` maps used with `isScammerMatch`.
 */
export async function batchScammerCheck(platformIdsOrOptions = []) {
  const options = Array.isArray(platformIdsOrOptions)
    ? { platformIds: platformIdsOrOptions, userIds: [] }
    : platformIdsOrOptions || {};

  const platformIds = [
    ...new Set((options.platformIds || []).map((id) => String(id || '').trim()).filter(Boolean)),
  ];
  const userIds = [
    ...new Set(
      (options.userIds || [])
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id) && id > 0),
    ),
  ];

  const byPlatform = {};
  const byUser = {};

  if (!platformIds.length && !userIds.length) {
    return { byPlatform, byUser };
  }

  const conditions = [];
  const values = [];

  if (platformIds.length) {
    conditions.push(`platform_id IN (${platformIds.map(() => '?').join(', ')})`);
    values.push(...platformIds);
  }
  if (userIds.length) {
    conditions.push(`user_id IN (${userIds.map(() => '?').join(', ')})`);
    values.push(...userIds);
  }

  const rows = await query(
    `SELECT platform_id, user_id
     FROM scammer_transactions
     WHERE ${conditions.join(' OR ')}`,
    values,
  );

  for (const row of rows) {
    if (row.platform_id) byPlatform[String(row.platform_id)] = true;
    if (row.user_id != null && Number(row.user_id) > 0) {
      byUser[String(row.user_id)] = true;
    }
  }

  return { byPlatform, byUser };
}

/** True if this transaction's platform ID or user ID is flagged as a scammer. */
export function isScammerMatch(flags, { platformId, userId } = {}) {
  if (!flags) return false;
  const platformKey = String(platformId || '').trim();
  if (platformKey && flags.byPlatform?.[platformKey]) return true;
  const userKey = userId != null && String(userId).trim() !== '' ? String(userId) : '';
  if (userKey && flags.byUser?.[userKey]) return true;
  return false;
}

export async function listScammers(params = {}) {
  const page = Math.max(1, Number(params.page) || 1);
  const perPage = Math.min(100, Math.max(1, Number(params.per_page) || 50));
  const offset = (page - 1) * perPage;

  const conditions = [];
  const values = [];

  const platformId = String(params.platform_id ?? params.platformId ?? '').trim();
  const customerName = String(params.customer_name ?? params.customerName ?? '').trim();

  if (platformId) {
    conditions.push('st.platform_id LIKE ? ESCAPE \'\\\\\'');
    values.push(`%${escapeLike(platformId)}%`);
  }
  if (customerName) {
    conditions.push('st.customer_name LIKE ? ESCAPE \'\\\\\'');
    values.push(`%${escapeLike(customerName)}%`);
  }

  const whereSql = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const countRows = await query(
    `SELECT COUNT(*) AS total FROM scammer_transactions st ${whereSql}`,
    values,
  );
  const total = Number(countRows[0]?.total) || 0;

  const rows = await query(
    `SELECT st.*
     FROM scammer_transactions st
     ${whereSql}
     ORDER BY st.created_at DESC
     LIMIT ? OFFSET ?`,
    [...values, perPage, offset],
  );

  return {
    scammers: rows.map(mapScammerRow),
    pagination: {
      page,
      per_page: perPage,
      total,
      total_pages: Math.max(1, Math.ceil(total / perPage)),
    },
  };
}

export async function searchScammerUserByPlatformId(platformIdRaw) {
  const platformId = String(platformIdRaw || '').trim();
  if (!platformId) {
    throw validationError('Platform ID is required.');
  }

  const withdrawalRows = await query(
    `SELECT w.user_id, ah.first_name, ah.last_name, ah.account_number, ah.email, ah.mobile_number
     FROM withdrawals w
     INNER JOIN account_holders ah ON ah.user_id = w.user_id
     WHERE w.cashout_account_id = ?
     LIMIT 1`,
    [platformId],
  );

  let accountHolder = withdrawalRows[0] || null;
  let foundVia = 'withdrawal';

  if (!accountHolder) {
    const depositRows = await query(
      `SELECT d.user_id, ah.first_name, ah.last_name, ah.account_number, ah.email, ah.mobile_number
       FROM deposits d
       INNER JOIN account_holders ah ON ah.user_id = d.user_id
       WHERE d.topup_account_id = ?
       LIMIT 1`,
      [platformId],
    );
    accountHolder = depositRows[0] || null;
    foundVia = 'deposit';
  }

  if (!accountHolder) {
    return {
      success: false,
      message: `No user found with Platform ID: ${platformId}`,
    };
  }

  const fullName = [accountHolder.first_name, accountHolder.last_name].filter(Boolean).join(' ').trim();

  return {
    success: true,
    user: {
      user_id: accountHolder.user_id,
      account_number: accountHolder.account_number,
      first_name: accountHolder.first_name || '',
      last_name: accountHolder.last_name || '',
      email: accountHolder.email || '',
      mobile_number: accountHolder.mobile_number || '',
      full_name: fullName,
      platform_id: platformId,
      found_via: foundVia,
    },
  };
}

export async function addScammer(payload = {}) {
  const platformId = String(payload.platform_id ?? payload.platformId ?? '').trim();
  const customerName = String(payload.customer_name ?? payload.customerName ?? '').trim() || null;
  const notes = String(payload.notes ?? '').trim() || null;
  const userIdRaw = payload.user_id ?? payload.userId;
  const userId =
    userIdRaw != null && String(userIdRaw).trim() !== '' ? Number(userIdRaw) : null;

  if (!platformId) {
    throw validationError('Platform ID is required.');
  }
  if (userId != null && (!Number.isInteger(userId) || userId <= 0)) {
    throw validationError('User ID must be a valid integer.');
  }

  const existing = await query(
    `SELECT id FROM scammer_transactions WHERE platform_id = ? LIMIT 1`,
    [platformId],
  );
  if (existing[0]) {
    throw validationError('This Platform ID is already flagged as a scammer');
  }

  const result = await query(
    `INSERT INTO scammer_transactions
      (platform_id, user_id, customer_name, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, NOW(), NOW())`,
    [platformId, userId, customerName, notes],
  );

  const rows = await query(`SELECT * FROM scammer_transactions WHERE id = ? LIMIT 1`, [
    result.insertId,
  ]);

  return {
    success: true,
    message: 'Scammer added successfully',
    scammer: mapScammerRow(rows[0]),
  };
}

export async function deleteScammer(id) {
  const scammerId = Number(id);
  if (!Number.isInteger(scammerId) || scammerId <= 0) {
    throw validationError('Scammer id is required.');
  }

  const rows = await query(`SELECT id FROM scammer_transactions WHERE id = ? LIMIT 1`, [scammerId]);
  if (!rows[0]) {
    throw validationError('Scammer not found.', 404);
  }

  await query(`DELETE FROM scammer_transactions WHERE id = ?`, [scammerId]);

  return {
    success: true,
    message: 'Scammer removed successfully',
  };
}
