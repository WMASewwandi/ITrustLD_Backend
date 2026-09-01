import { getDbDriver, query } from '../config/database.js';
import {
  BUILTIN_ROLE_PERMISSIONS,
  SYSTEM_ACTIVITIES,
  SYSTEM_ACTIVITY_CATEGORIES,
} from '../constants/systemActivityCatalog.js';
import { LOYALTY_ORDERS_READ, LOYALTY_ORDERS_UPDATE } from '../constants/loyaltyPermissions.js';
import { nowSqlDateTime } from '../utils/slTime.js';
import { syncRolePermissions, normalizeToActivityIdentifier } from './role.service.js';

const GUARD_NAME = 'web';
let syncReady = false;

async function upsertCategory(category) {
  const rows = await query(
    `SELECT id FROM system_activity_categories WHERE id = ? LIMIT 1`,
    [category.id],
  );

  if (rows[0]) {
    await query(
      `UPDATE system_activity_categories
       SET category_identifier = ?, categoy_name = ?
       WHERE id = ?`,
      [category.category_identifier, category.categoy_name, category.id],
    );
    return;
  }

  if (getDbDriver() === 'sqlite') {
    await query(
      `INSERT INTO system_activity_categories (id, category_identifier, categoy_name)
       VALUES (?, ?, ?)`,
      [category.id, category.category_identifier, category.categoy_name],
    );
    return;
  }

  await query(
    `INSERT INTO system_activity_categories (id, category_identifier, categoy_name)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE
       category_identifier = VALUES(category_identifier),
       categoy_name = VALUES(categoy_name)`,
    [category.id, category.category_identifier, category.categoy_name],
  );
}

async function upsertActivity(activity) {
  const rows = await query(
    `SELECT id FROM system_activities WHERE activity_identifier = ? LIMIT 1`,
    [activity.activity_identifier],
  );

  if (rows[0]) {
    await query(
      `UPDATE system_activities
       SET activity_name = ?, category_id = ?
       WHERE activity_identifier = ?`,
      [activity.activity_name, activity.category_id, activity.activity_identifier],
    );
    return;
  }

  await query(
    `INSERT INTO system_activities (activity_identifier, activity_name, category_id)
     VALUES (?, ?, ?)`,
    [activity.activity_identifier, activity.activity_name, activity.category_id],
  );
}

async function ensurePermissionRecord(activityIdentifier) {
  const rows = await query(
    `SELECT id FROM permissions WHERE name = ? AND guard_name = ? LIMIT 1`,
    [activityIdentifier, GUARD_NAME],
  );
  if (rows[0]) return;

  const now = nowSqlDateTime();
  await query(
    `INSERT INTO permissions (name, guard_name, created_at, updated_at)
     VALUES (?, ?, ?, ?)`,
    [activityIdentifier, GUARD_NAME, now, now],
  );
}

export async function ensureSystemActivitiesCatalog() {
  if (syncReady) return;

  for (const category of SYSTEM_ACTIVITY_CATEGORIES) {
    await upsertCategory(category);
  }

  for (const activity of SYSTEM_ACTIVITIES) {
    await upsertActivity(activity);
    await ensurePermissionRecord(activity.activity_identifier);
  }

  await ensureBuiltinRolePermissions();
  await grantAuthorizePermissionToExistingAuthorizerRole();
  await grantMobileVerificationPendingToExistingAccountReaders();
  await grantLoyaltyOrderAccessToWithdrawalExecutives();

  syncReady = true;
}

async function grantAuthorizePermissionToExistingAuthorizerRole() {
  const roleRows = await query(
    `SELECT id FROM roles WHERE name = 'withdrawal-authorizer' AND guard_name = ? LIMIT 1`,
    [GUARD_NAME],
  );
  if (!roleRows[0]) return;

  const currentRows = await query(
    `SELECT p.name
     FROM permissions p
     INNER JOIN role_has_permissions rhp ON rhp.permission_id = p.id
     WHERE rhp.role_id = ?`,
    [roleRows[0].id],
  );
  const current = currentRows.map((row) => normalizeToActivityIdentifier(row.name));
  if (current.includes('authorize_withdrawal_data')) return;

  await syncRolePermissions('withdrawal-authorizer', [...current, 'authorize_withdrawal_data']);
}

async function grantMobileVerificationPendingToExistingAccountReaders() {
  const roleRows = await query(
    `SELECT DISTINCT r.id, r.name
     FROM roles r
     INNER JOIN role_has_permissions rhp ON rhp.role_id = r.id
     INNER JOIN permissions p ON p.id = rhp.permission_id
     WHERE r.guard_name = ?
       AND p.name = ?
       AND r.name <> 'customer'`,
    [GUARD_NAME, 'read_customer_accounts_data'],
  );

  for (const role of roleRows) {
    const currentRows = await query(
      `SELECT p.name
       FROM permissions p
       INNER JOIN role_has_permissions rhp ON rhp.permission_id = p.id
       WHERE rhp.role_id = ?`,
      [role.id],
    );
    const current = currentRows.map((row) => normalizeToActivityIdentifier(row.name));
    if (current.includes('read_mobile_verification_pending')) continue;
    await syncRolePermissions(role.name, [...current, 'read_mobile_verification_pending']);
  }
}

async function grantLoyaltyOrderAccessToWithdrawalExecutives() {
  const roleRows = await query(
    `SELECT id FROM roles WHERE name = 'withdrawal-executive' AND guard_name = ? LIMIT 1`,
    [GUARD_NAME],
  );
  if (!roleRows[0]) return;

  const currentRows = await query(
    `SELECT p.name
     FROM permissions p
     INNER JOIN role_has_permissions rhp ON rhp.permission_id = p.id
     WHERE rhp.role_id = ?`,
    [roleRows[0].id],
  );
  const current = currentRows.map((row) => normalizeToActivityIdentifier(row.name));
  const missing = [LOYALTY_ORDERS_READ, LOYALTY_ORDERS_UPDATE].filter(
    (permission) => !current.includes(permission),
  );
  if (!missing.length) return;

  await syncRolePermissions('withdrawal-executive', [...current, ...missing]);
}

async function ensureBuiltinRolePermissions() {
  for (const [roleName, expectedPermissions] of Object.entries(BUILTIN_ROLE_PERMISSIONS)) {
    if (roleName === 'deposit-executive' || roleName === 'withdrawal-executive') {
      continue;
    }
    const roleRows = await query(
      `SELECT id FROM roles WHERE name = ? AND guard_name = ? LIMIT 1`,
      [roleName, GUARD_NAME],
    );
    if (!roleRows[0]) continue;

    if (roleName === 'customer') {
      await syncRolePermissions(roleName, expectedPermissions);
      continue;
    }

    const currentRows = await query(
      `SELECT p.name
       FROM permissions p
       INNER JOIN role_has_permissions rhp ON rhp.permission_id = p.id
       WHERE rhp.role_id = ?`,
      [roleRows[0].id],
    );
    const current = new Set(
      currentRows.map((row) => normalizeToActivityIdentifier(row.name)),
    );
    const missing = expectedPermissions.filter((permission) => !current.has(permission));
    if (!missing.length) continue;

    await syncRolePermissions(roleName, [...current, ...missing]);
  }
}
