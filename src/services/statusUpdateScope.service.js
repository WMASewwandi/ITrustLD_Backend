import { getDbDriver, query } from '../config/database.js';

export const DEPOSIT_UPDATE_STATUSES = ['Pending', 'Completed', 'Rejected'];
export const WITHDRAWAL_UPDATE_STATUSES = [
  'Pending',
  'Pending Authorization',
  'Completed',
  'Rejected',
];

let statusScopeColumnsReady = false;

async function columnExists(table, column) {
  if (getDbDriver() === 'sqlite') {
    const rows = await query(`PRAGMA table_info(${table})`);
    return rows.some((row) => String(row.name).toLowerCase() === String(column).toLowerCase());
  }
  const rows = await query(`SHOW COLUMNS FROM ${table} LIKE ?`, [column]);
  return rows.length > 0;
}

export async function ensureStatusUpdateScopeColumns() {
  if (statusScopeColumnsReady) return;
  const columns = ['allowed_deposit_statuses', 'allowed_withdrawal_statuses'];
  for (const column of columns) {
    if (await columnExists('users', column)) continue;
    if (getDbDriver() === 'sqlite') {
      await query(`ALTER TABLE users ADD COLUMN ${column} TEXT NULL`);
      continue;
    }
    try {
      await query(`ALTER TABLE users ADD COLUMN ${column} TEXT NULL AFTER pending_show_count`);
    } catch {
      await query(`ALTER TABLE users ADD COLUMN ${column} TEXT NULL`);
    }
  }
  statusScopeColumnsReady = true;
}

function parseJsonList(raw) {
  if (raw == null || raw === '') return null;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

export function parseAllowedStatuses(raw, allowedAll) {
  const parsed = parseJsonList(raw);
  if (!parsed) return null;
  const allowed = [
    ...new Set(parsed.map((item) => String(item || '').trim()).filter((item) => allowedAll.includes(item))),
  ];
  return allowed;
}

export function serializeAllowedStatuses(list, allowedAll, { required = false } = {}) {
  const unique = [
    ...new Set((list || []).map((item) => String(item || '').trim()).filter((item) => allowedAll.includes(item))),
  ];
  if (required && unique.length === 0) {
    const error = new Error(
      allowedAll === WITHDRAWAL_UPDATE_STATUSES
        ? 'Select at least one withdrawal status this user can update.'
        : 'Select at least one deposit status this user can update.',
    );
    error.status = 422;
    throw error;
  }
  if (!unique.length || unique.length === allowedAll.length) return null;
  return JSON.stringify(unique);
}

export function canUpdateCurrentStatus(allowedList, currentStatus) {
  if (!allowedList) return true;
  return allowedList.includes(String(currentStatus || '').trim());
}

export async function getUserStatusUpdateScope(userId) {
  if (!userId) {
    return { allowed_deposit_statuses: null, allowed_withdrawal_statuses: null };
  }
  await ensureStatusUpdateScopeColumns();
  const rows = await query(
    `SELECT allowed_deposit_statuses, allowed_withdrawal_statuses FROM users WHERE id = ? LIMIT 1`,
    [userId],
  );
  const row = rows[0] || {};
  return {
    allowed_deposit_statuses: parseAllowedStatuses(row.allowed_deposit_statuses, DEPOSIT_UPDATE_STATUSES),
    allowed_withdrawal_statuses: parseAllowedStatuses(
      row.allowed_withdrawal_statuses,
      WITHDRAWAL_UPDATE_STATUSES,
    ),
  };
}

export async function assertCanUpdateRecordStatus(userId, kind, currentStatus) {
  const scope = await getUserStatusUpdateScope(userId);
  const allowed =
    kind === 'withdrawal' ? scope.allowed_withdrawal_statuses : scope.allowed_deposit_statuses;
  if (canUpdateCurrentStatus(allowed, currentStatus)) return;
  const label = kind === 'withdrawal' ? 'withdrawal' : 'deposit';
  const error = new Error(
    `You can only update ${label} records with status: ${(allowed || []).join(', ') || 'none'}.`,
  );
  error.status = 403;
  throw error;
}
