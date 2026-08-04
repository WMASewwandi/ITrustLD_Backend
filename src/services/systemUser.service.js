import { query } from '../config/database.js';
import { LARAVEL_USER_MODEL } from '../constants/adminRoles.js';
import { nowSqlDateTime } from '../utils/slTime.js';
import { formatRoleDisplayName } from './role.service.js';
import { hashLaravelPassword } from '../utils/laravelPassword.js';

const GUARD_NAME = 'web';

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
    is_active: user.is_active === undefined ? true : Boolean(user.is_active),
    is_online: Boolean(user.is_online),
    shift: formatShift(user.shift),
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
    `SELECT name FROM roles WHERE guard_name = ? AND name != ? ORDER BY name ASC`,
    [GUARD_NAME, 'customer'],
  );

  return rows.map((row) => ({
    name: row.name,
    display_name: formatRoleDisplayName(row.name),
  }));
}

export async function getAllSystemUsers() {
  const users = await query(
    `SELECT DISTINCT u.id, u.name, u.email, u.is_active, u.is_online, u.shift, u.created_at
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
  const rows = await query(
    `SELECT u.id, u.name, u.email, u.is_active, u.is_online, u.shift, u.created_at
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

export async function updateSystemUser(userId, payload) {
  const existing = await findSystemUserById(userId);
  if (!existing) {
    const error = new Error('User not found.');
    error.status = 404;
    throw error;
  }

  const name = String(payload.name || '').trim();
  const email = String(payload.email || '').trim().toLowerCase();
  const role = String(payload.role || '').trim();
  const password = payload.password ? String(payload.password) : '';
  const isActive = payload.is_active !== false && payload.is_active !== 0 && payload.is_active !== '0';
  const shift = parseShiftToDb(payload.shift);

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
    const error = new Error('Email is already in use.');
    error.status = 409;
    throw error;
  }

  const shiftTimes = toShiftTimes(shift);
  const now = nowSqlDateTime();

  const updateFields = [
    'name = ?',
    'email = ?',
    'is_active = ?',
    'shift = ?',
    'shift_start_time = ?',
    'shift_end_time = ?',
    'updated_at = ?',
  ];
  const updateParams = [
    name,
    email,
    isActive ? 1 : 0,
    shift,
    shiftTimes.shift_start_time,
    shiftTimes.shift_end_time,
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
  const role = String(payload.role || '').trim();
  const password = String(payload.password || '');
  const isActive = payload.is_active !== false && payload.is_active !== 0 && payload.is_active !== '0';
  const shift = parseShiftToDb(payload.shift);

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
    const error = new Error('Email is already in use.');
    error.status = 409;
    throw error;
  }

  const shiftTimes = toShiftTimes(shift);
  const now = nowSqlDateTime();
  const hashedPassword = await hashLaravelPassword(password);

  const result = await query(
    `INSERT INTO users (name, email, password, is_active, is_online, shift, shift_start_time, shift_end_time, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
    [
      name,
      email,
      hashedPassword,
      isActive ? 1 : 0,
      shift,
      shiftTimes.shift_start_time,
      shiftTimes.shift_end_time,
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
