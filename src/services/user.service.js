import { normalizeToActivityIdentifier } from './role.service.js';
import { query } from '../config/database.js';
import { LARAVEL_USER_MODEL } from '../constants/adminRoles.js';

export async function findUserByEmail(email) {
  const rows = await query(
    `SELECT id, name, email, password, is_active, is_online, shift, shift_start_time, shift_end_time, email_verified_at, created_at, updated_at
     FROM users
     WHERE LOWER(email) = ?
     LIMIT 1`,
    [email],
  );
  return rows[0] ?? null;
}

export async function findUserById(id) {
  const rows = await query(
    `SELECT id, name, email, is_active, is_online, shift, shift_start_time, shift_end_time, email_verified_at, created_at, updated_at
     FROM users
     WHERE id = ?
     LIMIT 1`,
    [id],
  );
  return rows[0] ?? null;
}

export function isUserActive(user) {
  if (!user) return false;
  if (user.is_active === undefined || user.is_active === null) return true;
  return Boolean(user.is_active);
}

export async function getUserRoles(userId) {
  const rows = await query(
    `SELECT r.name
     FROM roles r
     INNER JOIN model_has_roles mhr ON mhr.role_id = r.id
     WHERE mhr.model_id = ? AND mhr.model_type = ?
     ORDER BY r.name ASC`,
    [userId, LARAVEL_USER_MODEL],
  );
  return rows.map((row) => row.name);
}

export async function getUserPermissions(userId) {
  const viaRole = await query(
    `SELECT DISTINCT p.name
     FROM permissions p
     INNER JOIN role_has_permissions rhp ON rhp.permission_id = p.id
     INNER JOIN model_has_roles mhr ON mhr.role_id = rhp.role_id
     WHERE mhr.model_id = ? AND mhr.model_type = ?
     ORDER BY p.name ASC`,
    [userId, LARAVEL_USER_MODEL],
  );

  let viaDirect = [];
  try {
    viaDirect = await query(
      `SELECT DISTINCT p.name
       FROM permissions p
       INNER JOIN model_has_permissions mhp ON mhp.permission_id = p.id
       WHERE mhp.model_id = ? AND mhp.model_type = ?
       ORDER BY p.name ASC`,
      [userId, LARAVEL_USER_MODEL],
    );
  } catch {
    viaDirect = [];
  }

  return [
    ...new Set(
      [...viaRole, ...viaDirect].map((row) => normalizeToActivityIdentifier(row.name)),
    ),
  ];
}

export async function setUserOnline(userId, isOnline) {
  await query('UPDATE users SET is_online = ? WHERE id = ?', [isOnline ? 1 : 0, userId]);
}
