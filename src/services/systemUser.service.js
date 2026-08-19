import { getDbDriver, query } from '../config/database.js';
import { LARAVEL_USER_MODEL } from '../constants/adminRoles.js';
import { nowSqlDateTime } from '../utils/slTime.js';
import { formatRoleDisplayName, getRolePermissionsMap } from './role.service.js';
import { hashLaravelPassword } from '../utils/laravelPassword.js';
import {
  DEPOSIT_UPDATE_STATUSES,
  WITHDRAWAL_UPDATE_STATUSES,
  LOYALTY_ORDER_UPDATE_STATUSES,
  LOYALTY_BONUS_UPDATE_STATUSES,
  LOYALTY_VOUCHER_UPDATE_STATUSES,
  ensureStatusUpdateScopeColumns,
  parseAllowedStatuses,
  serializeAllowedStatuses,
} from './statusUpdateScope.service.js';

const GUARD_NAME = 'web';
const MAX_PENDING_SHOW_COUNT = 1000;

let pendingShowCountColumnReady = false;
let mobileNumberColumnReady = false;

async function columnExists(table, column) {
  if (getDbDriver() === 'sqlite') {
    const rows = await query(`PRAGMA table_info(${table})`);
    return rows.some((row) => String(row.name).toLowerCase() === String(column).toLowerCase());
  }
  const rows = await query(`SHOW COLUMNS FROM ${table} LIKE ?`, [column]);
  return rows.length > 0;
}

export async function ensurePendingShowCountColumn() {
  if (pendingShowCountColumnReady) return;
  if (!(await columnExists('users', 'pending_show_count'))) {
    if (getDbDriver() === 'sqlite') {
      await query(`ALTER TABLE users ADD COLUMN pending_show_count INTEGER NULL`);
    } else {
      try {
        await query(
          `ALTER TABLE users ADD COLUMN pending_show_count INT UNSIGNED NULL AFTER shift_end_time`,
        );
      } catch {
        await query(`ALTER TABLE users ADD COLUMN pending_show_count INT UNSIGNED NULL`);
      }
    }
  }
  pendingShowCountColumnReady = true;
}

export async function ensureMobileNumberColumn() {
  if (mobileNumberColumnReady) return;
  if (!(await columnExists('users', 'mobile_number'))) {
    if (getDbDriver() === 'sqlite') {
      await query(`ALTER TABLE users ADD COLUMN mobile_number TEXT NULL`);
    } else {
      try {
        await query(
          `ALTER TABLE users ADD COLUMN mobile_number VARCHAR(32) NULL AFTER email`,
        );
      } catch {
        await query(`ALTER TABLE users ADD COLUMN mobile_number VARCHAR(32) NULL`);
      }
    }
  }
  mobileNumberColumnReady = true;
}

export function parsePendingShowCount(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(MAX_PENDING_SHOW_COUNT, Math.floor(n));
}

export function parseOptionalMobileNumber(value) {
  const mobile = String(value ?? '').trim();
  return mobile || null;
}

/** Positive pending load cap for executives, or null = load all (normal pagination). */
export async function getUserPendingShowCount(userId) {
  if (!userId) return null;
  await ensurePendingShowCountColumn();
  const rows = await query(`SELECT pending_show_count FROM users WHERE id = ? LIMIT 1`, [userId]);
  return parsePendingShowCount(rows[0]?.pending_show_count);
}

function formatShift(shift) {
  if (!shift) return null;
  if (shift === 'A') return 'Shift A';
  if (shift === 'B') return 'Shift B';
  return shift;
}

function parseShiftToDb(shift) {
  if (!shift || shift === '-' || shift === '') return null;
  if (shift === 'Shift A' || shift === 'A') return 'A';
  if (shift === 'Shift B' || shift === 'B') return 'B';
  return null;
}

function toShiftTimes(shift) {
  if (shift === 'A' || shift === 'B') {
    return { shift_start_time: '00:10:00', shift_end_time: '00:10:00' };
  }
  return { shift_start_time: null, shift_end_time: null };
}

function mapSystemUser(user, roles) {
  const primaryRole = roles[0] ?? null;

  return {
    id: user.id,
    name: user.name,
    email: user.email,
    mobile_number: user.mobile_number || null,
    is_active: user.is_active === undefined ? true : Boolean(user.is_active),
    is_online: Boolean(user.is_online),
    shift: formatShift(user.shift),
    pending_show_count: parsePendingShowCount(user.pending_show_count),
    allowed_deposit_statuses: parseAllowedStatuses(
      user.allowed_deposit_statuses,
      DEPOSIT_UPDATE_STATUSES,
    ),
    allowed_withdrawal_statuses: parseAllowedStatuses(
      user.allowed_withdrawal_statuses,
      WITHDRAWAL_UPDATE_STATUSES,
    ),
    allowed_loyalty_order_statuses: parseAllowedStatuses(
      user.allowed_loyalty_order_statuses,
      LOYALTY_ORDER_UPDATE_STATUSES,
    ),
    allowed_loyalty_bonus_statuses: parseAllowedStatuses(
      user.allowed_loyalty_bonus_statuses,
      LOYALTY_BONUS_UPDATE_STATUSES,
    ),
    allowed_loyalty_voucher_statuses: parseAllowedStatuses(
      user.allowed_loyalty_voucher_statuses,
      LOYALTY_VOUCHER_UPDATE_STATUSES,
    ),
    created_at: user.created_at,
    roles,
    role: primaryRole,
    role_display_name: primaryRole ? formatRoleDisplayName(primaryRole) : '—',
  };
}

async function getRolesByUserIds() {
  const roleRows = await query(
    `SELECT mhr.model_id AS user_id, r.name AS role_name
     FROM model_has_roles mhr
     INNER JOIN roles r ON r.id = mhr.role_id
     WHERE mhr.model_type = ? AND r.name != ?
     ORDER BY r.name ASC`,
    [LARAVEL_USER_MODEL, 'customer'],
  );

  const rolesByUser = new Map();
  for (const row of roleRows) {
    if (!rolesByUser.has(row.user_id)) {
      rolesByUser.set(row.user_id, []);
    }
    rolesByUser.get(row.user_id).push(row.role_name);
  }
  return rolesByUser;
}

export async function getAssignableRoles() {
  const rows = await query(
    `SELECT id, name FROM roles WHERE guard_name = ? AND name != ? ORDER BY name ASC`,
    [GUARD_NAME, 'customer'],
  );
  const permissionsByRole = await getRolePermissionsMap();

  return rows.map((row) => ({
    name: row.name,
    display_name: formatRoleDisplayName(row.name),
    permissions: permissionsByRole.get(row.id) ?? [],
  }));
}

export async function getAllSystemUsers() {
  await ensurePendingShowCountColumn();
  await ensureMobileNumberColumn();
  await ensureStatusUpdateScopeColumns();
  const users = await query(
    `SELECT DISTINCT u.id, u.name, u.email, u.mobile_number, u.is_active, u.is_online, u.shift, u.pending_show_count,
            u.allowed_deposit_statuses,
            u.allowed_withdrawal_statuses,
            u.allowed_loyalty_order_statuses,
            u.allowed_loyalty_bonus_statuses,
            u.allowed_loyalty_voucher_statuses,
            u.created_at
     FROM users u
     INNER JOIN model_has_roles mhr ON mhr.model_id = u.id AND mhr.model_type = ?
     INNER JOIN roles r ON r.id = mhr.role_id
     WHERE r.name != ?
     ORDER BY u.name ASC`,
    [LARAVEL_USER_MODEL, 'customer'],
  );

  const rolesByUser = await getRolesByUserIds();

  return users.map((user) => mapSystemUser(user, rolesByUser.get(user.id) ?? []));
}

export async function findSystemUserById(userId) {
  await ensurePendingShowCountColumn();
  await ensureMobileNumberColumn();
  await ensureStatusUpdateScopeColumns();
  const rows = await query(
    `SELECT u.id, u.name, u.email, u.mobile_number, u.is_active, u.is_online, u.shift, u.pending_show_count,
            u.allowed_deposit_statuses,
            u.allowed_withdrawal_statuses,
            u.allowed_loyalty_order_statuses,
            u.allowed_loyalty_bonus_statuses,
            u.allowed_loyalty_voucher_statuses,
            u.created_at
     FROM users u
     WHERE u.id = ?
     LIMIT 1`,
    [userId],
  );
  const user = rows[0];
  if (!user) return null;

  const roles = await query(
    `SELECT r.name
     FROM roles r
     INNER JOIN model_has_roles mhr ON mhr.role_id = r.id
     WHERE mhr.model_id = ? AND mhr.model_type = ? AND r.name != ?
     ORDER BY r.name ASC`,
    [userId, LARAVEL_USER_MODEL, 'customer'],
  );

  if (roles.length === 0) return null;

  return mapSystemUser(user, roles.map((row) => row.name));
}

async function findRoleIdByName(roleName) {
  const rows = await query(
    `SELECT id FROM roles WHERE name = ? AND guard_name = ? LIMIT 1`,
    [roleName, GUARD_NAME],
  );
  return rows[0]?.id ?? null;
}

/** Email uniqueness is global on `users` (customers + system). System Users UI only lists non-customer roles. */
async function buildEmailInUseError(existingUserId) {
  const roles = await query(
    `SELECT r.name
     FROM roles r
     INNER JOIN model_has_roles mhr ON mhr.role_id = r.id
     WHERE mhr.model_id = ? AND mhr.model_type = ?
     ORDER BY r.name ASC`,
    [existingUserId, LARAVEL_USER_MODEL],
  );
  const roleNames = roles.map((row) => row.name);
  const isCustomerOnly =
    roleNames.length === 0 || (roleNames.length === 1 && roleNames[0] === 'customer');

  const error = new Error(
    isCustomerOnly
      ? 'Email is already in use by a customer account. It will not appear under System Users — pick a different email, or use that customer email only for the user portal.'
      : 'Email is already in use by another system user.',
  );
  error.status = 409;
  return error;
}

async function resolveStatusScopeForRole(roleName, payload = {}) {
  const roles = await getAssignableRoles();
  const role = roles.find((item) => item.name === roleName);
  const permissions = role?.permissions || [];
  const canUpdateDeposits = permissions.includes('status_update_deposit_data');
  const canUpdateWithdrawals =
    permissions.includes('status_update_withdrawal_data') ||
    permissions.includes('authorize_withdrawal_data');

  const canUpdateLoyaltyOrders = permissions.includes('status_update_loyalty_orders_data');
  const canUpdateLoyaltyBonus = permissions.includes('status_update_loyalty_bonus_claims_data');
  const canUpdateLoyaltyVouchers = permissions.includes('status_update_loyalty_voucher_claims_data');

  return {
    allowedDepositStatuses: canUpdateDeposits
      ? serializeAllowedStatuses(payload.allowed_deposit_statuses, DEPOSIT_UPDATE_STATUSES, {
          required: Array.isArray(payload.allowed_deposit_statuses),
        })
      : null,
    allowedWithdrawalStatuses: canUpdateWithdrawals
      ? serializeAllowedStatuses(payload.allowed_withdrawal_statuses, WITHDRAWAL_UPDATE_STATUSES, {
          required: Array.isArray(payload.allowed_withdrawal_statuses),
        })
      : null,
    allowedLoyaltyOrderStatuses: canUpdateLoyaltyOrders
      ? serializeAllowedStatuses(payload.allowed_loyalty_order_statuses, LOYALTY_ORDER_UPDATE_STATUSES, {
          required: Array.isArray(payload.allowed_loyalty_order_statuses),
        })
      : null,
    allowedLoyaltyBonusStatuses: canUpdateLoyaltyBonus
      ? serializeAllowedStatuses(payload.allowed_loyalty_bonus_statuses, LOYALTY_BONUS_UPDATE_STATUSES, {
          required: Array.isArray(payload.allowed_loyalty_bonus_statuses),
        })
      : null,
    allowedLoyaltyVoucherStatuses: canUpdateLoyaltyVouchers
      ? serializeAllowedStatuses(payload.allowed_loyalty_voucher_statuses, LOYALTY_VOUCHER_UPDATE_STATUSES, {
          required: Array.isArray(payload.allowed_loyalty_voucher_statuses),
        })
      : null,
  };
}

export async function updateSystemUser(userId, payload) {
  const existing = await findSystemUserById(userId);
  if (!existing) {
    const error = new Error('User not found.');
    error.status = 404;
    throw error;
  }

  const name = String(payload.name || '').trim();
  const email = String(payload.email || '').trim().toLowerCase();
  const mobileNumber = parseOptionalMobileNumber(
    payload.mobile_number ?? payload.mobileNumber ?? payload.mobile,
  );
  const role = String(payload.role || '').trim();
  const password = payload.password ? String(payload.password) : '';
  const isActive = payload.is_active !== false && payload.is_active !== 0 && payload.is_active !== '0';
  const shift = parseShiftToDb(payload.shift);
  const pendingShowCount = parsePendingShowCount(payload.pending_show_count);
  const statusScope = await resolveStatusScopeForRole(role, payload);

  if (!name || !email || !role) {
    const error = new Error('Name, email, and role are required.');
    error.status = 422;
    throw error;
  }

  if (role === 'customer') {
    const error = new Error('Customer role cannot be assigned to system users.');
    error.status = 422;
    throw error;
  }

  if (password && password.length < 6) {
    const error = new Error('Password must be at least 6 characters.');
    error.status = 422;
    throw error;
  }

  const roleId = await findRoleIdByName(role);
  if (!roleId) {
    const error = new Error('Invalid role selected.');
    error.status = 422;
    throw error;
  }

  const duplicateEmail = await query(
    `SELECT id FROM users WHERE LOWER(email) = ? AND id != ? LIMIT 1`,
    [email, userId],
  );
  if (duplicateEmail[0]) {
    throw await buildEmailInUseError(duplicateEmail[0].id);
  }

  await ensurePendingShowCountColumn();
  await ensureMobileNumberColumn();
  await ensureStatusUpdateScopeColumns();
  const shiftTimes = toShiftTimes(shift);
  const now = nowSqlDateTime();

  const updateFields = [
    'name = ?',
    'email = ?',
    'mobile_number = ?',
    'is_active = ?',
    'shift = ?',
    'shift_start_time = ?',
    'shift_end_time = ?',
    'pending_show_count = ?',
    'allowed_deposit_statuses = ?',
    'allowed_withdrawal_statuses = ?',
    'allowed_loyalty_order_statuses = ?',
    'allowed_loyalty_bonus_statuses = ?',
    'allowed_loyalty_voucher_statuses = ?',
    'updated_at = ?',
  ];
  const updateParams = [
    name,
    email,
    mobileNumber,
    isActive ? 1 : 0,
    shift,
    shiftTimes.shift_start_time,
    shiftTimes.shift_end_time,
    pendingShowCount,
    statusScope.allowedDepositStatuses,
    statusScope.allowedWithdrawalStatuses,
    statusScope.allowedLoyaltyOrderStatuses,
    statusScope.allowedLoyaltyBonusStatuses,
    statusScope.allowedLoyaltyVoucherStatuses,
    now,
  ];

  if (password) {
    updateFields.splice(2, 0, 'password = ?');
    updateParams.splice(2, 0, await hashLaravelPassword(password));
  }

  updateParams.push(userId);
  await query(`UPDATE users SET ${updateFields.join(', ')} WHERE id = ?`, updateParams);

  if (!isActive) {
    await query('UPDATE users SET is_online = 0 WHERE id = ?', [userId]);
  }

  await query(
    `DELETE FROM model_has_roles
     WHERE model_id = ? AND model_type = ?`,
    [userId, LARAVEL_USER_MODEL],
  );
  await query(
    `INSERT INTO model_has_roles (role_id, model_type, model_id)
     VALUES (?, ?, ?)`,
    [roleId, LARAVEL_USER_MODEL, userId],
  );

  return findSystemUserById(userId);
}

export async function createSystemUser(payload) {
  const name = String(payload.name || '').trim();
  const email = String(payload.email || '').trim().toLowerCase();
  const mobileNumber = parseOptionalMobileNumber(
    payload.mobile_number ?? payload.mobileNumber ?? payload.mobile,
  );
  const role = String(payload.role || '').trim();
  const password = String(payload.password || '');
  const isActive = payload.is_active !== false && payload.is_active !== 0 && payload.is_active !== '0';
  const shift = parseShiftToDb(payload.shift);
  const pendingShowCount = parsePendingShowCount(payload.pending_show_count);
  const statusScope = await resolveStatusScopeForRole(role, payload);

  if (!name || !email || !role || !password) {
    const error = new Error('Name, email, password, and role are required.');
    error.status = 422;
    throw error;
  }

  if (role === 'customer') {
    const error = new Error('Customer role cannot be assigned to system users.');
    error.status = 422;
    throw error;
  }

  if (password.length < 6) {
    const error = new Error('Password must be at least 6 characters.');
    error.status = 422;
    throw error;
  }

  const roleId = await findRoleIdByName(role);
  if (!roleId) {
    const error = new Error('Invalid role selected.');
    error.status = 422;
    throw error;
  }

  const duplicateEmail = await query(
    `SELECT id FROM users WHERE LOWER(email) = ? LIMIT 1`,
    [email],
  );
  if (duplicateEmail[0]) {
    throw await buildEmailInUseError(duplicateEmail[0].id);
  }

  await ensurePendingShowCountColumn();
  await ensureMobileNumberColumn();
  await ensureStatusUpdateScopeColumns();
  const shiftTimes = toShiftTimes(shift);
  const now = nowSqlDateTime();
  const hashedPassword = await hashLaravelPassword(password);

  const result = await query(
    `INSERT INTO users (
      name,
      email,
      mobile_number,
      password,
      is_active,
      is_online,
      shift,
      shift_start_time,
      shift_end_time,
      pending_show_count,
      allowed_deposit_statuses,
      allowed_withdrawal_statuses,
      allowed_loyalty_order_statuses,
      allowed_loyalty_bonus_statuses,
      allowed_loyalty_voucher_statuses,
      created_at,
      updated_at
    )
     VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      name,
      email,
      mobileNumber,
      hashedPassword,
      isActive ? 1 : 0,
      shift,
      shiftTimes.shift_start_time,
      shiftTimes.shift_end_time,
      pendingShowCount,
      statusScope.allowedDepositStatuses,
      statusScope.allowedWithdrawalStatuses,
      statusScope.allowedLoyaltyOrderStatuses,
      statusScope.allowedLoyaltyBonusStatuses,
      statusScope.allowedLoyaltyVoucherStatuses,
      now,
      now,
    ],
  );

  const userId = result.insertId ?? result.lastInsertRowid;

  await query(
    `INSERT INTO model_has_roles (role_id, model_type, model_id)
     VALUES (?, ?, ?)`,
    [roleId, LARAVEL_USER_MODEL, userId],
  );

  return findSystemUserById(userId);
}
