import { getDbDriver, query } from '../config/database.js';

export const DEPOSIT_UPDATE_STATUSES = ['Pending', 'Completed', 'Rejected'];
export const WITHDRAWAL_UPDATE_STATUSES = [
  'Pending',
  'Pending Authorization',
  'Completed',
  'Rejected',
];

export const LOYALTY_ORDER_UPDATE_STATUSES = ['Pending', 'Completed', 'Rejected'];
export const LOYALTY_BONUS_UPDATE_STATUSES = ['Pending', 'Claimed', 'Rejected'];
export const LOYALTY_VOUCHER_UPDATE_STATUSES = ['Pending', 'Claimed', 'Rejected'];

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
  const columns = [
    'allowed_deposit_statuses',
    'allowed_withdrawal_statuses',
    'allowed_loyalty_order_statuses',
    'allowed_loyalty_bonus_statuses',
    'allowed_loyalty_voucher_statuses',
  ];
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
    let label = 'deposit';
    if (allowedAll === WITHDRAWAL_UPDATE_STATUSES) label = 'withdrawal';
    if (allowedAll === LOYALTY_ORDER_UPDATE_STATUSES) label = 'loyalty order';
    if (allowedAll === LOYALTY_BONUS_UPDATE_STATUSES) label = 'loyalty bonus claim';
    if (allowedAll === LOYALTY_VOUCHER_UPDATE_STATUSES) label = 'loyalty voucher claim';

    const error = new Error(`Select at least one ${label} status this user can update.`);
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
    return {
      allowed_deposit_statuses: null,
      allowed_withdrawal_statuses: null,
      allowed_loyalty_order_statuses: null,
      allowed_loyalty_bonus_statuses: null,
      allowed_loyalty_voucher_statuses: null,
    };
  }
  await ensureStatusUpdateScopeColumns();
  const rows = await query(
    `SELECT
      allowed_deposit_statuses,
      allowed_withdrawal_statuses,
      allowed_loyalty_order_statuses,
      allowed_loyalty_bonus_statuses,
      allowed_loyalty_voucher_statuses
     FROM users WHERE id = ? LIMIT 1`,
    [userId],
  );
  const row = rows[0] || {};
  return {
    allowed_deposit_statuses: parseAllowedStatuses(row.allowed_deposit_statuses, DEPOSIT_UPDATE_STATUSES),
    allowed_withdrawal_statuses: parseAllowedStatuses(
      row.allowed_withdrawal_statuses,
      WITHDRAWAL_UPDATE_STATUSES,
    ),
    allowed_loyalty_order_statuses: parseAllowedStatuses(
      row.allowed_loyalty_order_statuses,
      LOYALTY_ORDER_UPDATE_STATUSES,
    ),
    allowed_loyalty_bonus_statuses: parseAllowedStatuses(
      row.allowed_loyalty_bonus_statuses,
      LOYALTY_BONUS_UPDATE_STATUSES,
    ),
    allowed_loyalty_voucher_statuses: parseAllowedStatuses(
      row.allowed_loyalty_voucher_statuses,
      LOYALTY_VOUCHER_UPDATE_STATUSES,
    ),
  };
}

export async function assertCanUpdateRecordStatus(userId, kind, currentStatus) {
  const scope = await getUserStatusUpdateScope(userId);

  let allowed = null;
  let label = 'deposit';

  if (kind === 'withdrawal') {
    allowed = scope.allowed_withdrawal_statuses;
    label = 'withdrawal';
  } else if (kind === 'loyalty_order') {
    allowed = scope.allowed_loyalty_order_statuses;
    label = 'loyalty order';
  } else if (kind === 'loyalty_bonus') {
    allowed = scope.allowed_loyalty_bonus_statuses;
    label = 'loyalty bonus claim';
  } else if (kind === 'loyalty_voucher') {
    allowed = scope.allowed_loyalty_voucher_statuses;
    label = 'loyalty voucher claim';
  } else {
    allowed = scope.allowed_deposit_statuses;
  }

  if (canUpdateCurrentStatus(allowed, currentStatus)) return;
  const error = new Error(
    `You can only update ${label} records with status: ${(allowed || []).join(', ') || 'none'}.`,
  );
  error.status = 403;
  throw error;
}
