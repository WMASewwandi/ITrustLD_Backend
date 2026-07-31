import { query } from '../config/database.js';

const GUARD_NAME = 'web';

/** DB drift: system_activities use legacy typo; some permission rows were corrected. */
const ACTIVITY_PERMISSION_ALIASES = {
  cusomer_deposit_activity: 'customer_deposit_activity',
  cusomer_withdrawal_activity: 'customer_withdrawal_activity',
};

function normalizeToActivityIdentifier(permissionName) {
  for (const [activityId, alias] of Object.entries(ACTIVITY_PERMISSION_ALIASES)) {
    if (permissionName === alias || permissionName === activityId) {
      return activityId;
    }
  }
  return permissionName;
}

function permissionNameCandidates(activityIdentifier) {
  const names = [activityIdentifier];
  const alias = ACTIVITY_PERMISSION_ALIASES[activityIdentifier];
  if (alias) names.push(alias);
  return names;
}

async function getValidActivityIdentifiers() {
  const rows = await query('SELECT activity_identifier FROM system_activities');
  return new Set(rows.map((row) => row.activity_identifier));
}

async function loadPermissionMap() {
  const allPermissions = await query(
    `SELECT id, name FROM permissions WHERE guard_name = ?`,
    [GUARD_NAME],
  );
  return new Map(allPermissions.map((p) => [p.name, p.id]));
}

async function resolvePermissionId(activityIdentifier, permissionMap) {
  for (const name of permissionNameCandidates(activityIdentifier)) {
    const id = permissionMap.get(name);
    if (id) return id;
  }

  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const result = await query(
    `INSERT INTO permissions (name, guard_name, created_at, updated_at)
     VALUES (?, ?, ?, ?)`,
    [activityIdentifier, GUARD_NAME, now, now],
  );
  const id = result.insertId ?? result.lastInsertRowid;
  permissionMap.set(activityIdentifier, id);
  return id;
}

const ROLE_DISPLAY_NAMES = {
  customer: 'Customer',
  'sub-admin': 'Sub Admin',
  'super-admin': 'Super Admin',
  'deposit-executive': 'Deposit Executive',
  'withdrawal-executive': 'Withdrawal Executive',
};

export function formatRoleDisplayName(roleName) {
  if (ROLE_DISPLAY_NAMES[roleName]) {
    return ROLE_DISPLAY_NAMES[roleName];
  }
  return roleName
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function toPublicRole(role, permissions = []) {
  return {
    id: role.id,
    name: role.name,
    display_name: formatRoleDisplayName(role.name),
    created_at: role.created_at,
    permissions,
  };
}

export async function getAllRoles() {
  const roles = await query(
    `SELECT id, name, guard_name, created_at, updated_at
     FROM roles
     WHERE guard_name = ?
     ORDER BY name ASC`,
    [GUARD_NAME],
  );

  const permissionsByRole = await getRolePermissionsMap();

  return roles.map((role) =>
    toPublicRole(role, permissionsByRole.get(role.id) ?? []),
  );
}

async function getRolePermissionsMap() {
  const rows = await query(
    `SELECT rhp.role_id, p.name AS permission_name
     FROM role_has_permissions rhp
     INNER JOIN permissions p ON p.id = rhp.permission_id
     INNER JOIN roles r ON r.id = rhp.role_id
     WHERE r.guard_name = ?
     ORDER BY p.name ASC`,
    [GUARD_NAME],
  );

  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.role_id)) {
      map.set(row.role_id, []);
    }
    map.get(row.role_id).push(normalizeToActivityIdentifier(row.permission_name));
  }
  return map;
}

export async function findRoleByName(roleName) {
  const rows = await query(
    `SELECT id, name, guard_name, created_at, updated_at
     FROM roles
     WHERE name = ? AND guard_name = ?
     LIMIT 1`,
    [roleName, GUARD_NAME],
  );
  return rows[0] ?? null;
}

export async function getRoleWithPermissions(roleName) {
  const role = await findRoleByName(roleName);
  if (!role) return null;

  const permissions = await query(
    `SELECT p.name
     FROM permissions p
     INNER JOIN role_has_permissions rhp ON rhp.permission_id = p.id
     WHERE rhp.role_id = ?
     ORDER BY p.name ASC`,
    [role.id],
  );

  return toPublicRole(
    role,
    permissions.map((p) => normalizeToActivityIdentifier(p.name)),
  );
}

export async function getAllActivitiesGrouped() {
  const categories = await query(
    `SELECT id, category_identifier, categoy_name AS category_name
     FROM system_activity_categories
     ORDER BY id ASC`,
  );

  const activities = await query(
    `SELECT id, activity_identifier, activity_name, category_id
     FROM system_activities
     ORDER BY category_id ASC, activity_name ASC`,
  );

  return categories.map((category) => ({
    id: category.id,
    identifier: category.category_identifier,
    name: category.category_name,
    activities: activities
      .filter((a) => a.category_id === category.id)
      .map((a) => ({
        id: a.id,
        identifier: a.activity_identifier,
        name: a.activity_name,
      })),
  }));
}

export async function createRole({ name }) {
  const slug = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-');

  if (!slug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    const error = new Error('Role name must be a lowercase slug (e.g. withdrawal-authorizer).');
    error.status = 422;
    throw error;
  }

  const existing = await findRoleByName(slug);
  if (existing) {
    const error = new Error('A role with this name already exists.');
    error.status = 409;
    throw error;
  }

  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const result = await query(
    `INSERT INTO roles (name, guard_name, created_at, updated_at)
     VALUES (?, ?, ?, ?)`,
    [slug, GUARD_NAME, now, now],
  );

  const roleId = result.insertId ?? result.lastInsertRowid;
  const created = await findRoleByName(slug);
  return toPublicRole(created ?? { id: roleId, name: slug, created_at: now }, []);
}

export async function syncRolePermissions(roleName, permissionNames) {
  const role = await findRoleByName(roleName);
  if (!role) {
    const error = new Error('Role not found.');
    error.status = 404;
    throw error;
  }

  const requested = Array.isArray(permissionNames) ? permissionNames : [];
  const uniqueNames = [...new Set(requested.map((p) => String(p).trim()).filter(Boolean))];

  const validActivities = await getValidActivityIdentifiers();
  const invalid = uniqueNames.filter((name) => !validActivities.has(name));
  if (invalid.length > 0) {
    const error = new Error(`Unknown permissions: ${invalid.join(', ')}`);
    error.status = 422;
    throw error;
  }

  const permissionMap = await loadPermissionMap();

  await query('DELETE FROM role_has_permissions WHERE role_id = ?', [role.id]);

  for (const activityIdentifier of uniqueNames) {
    const permissionId = await resolvePermissionId(activityIdentifier, permissionMap);
    await query(
      'INSERT INTO role_has_permissions (permission_id, role_id) VALUES (?, ?)',
      [permissionId, role.id],
    );
  }

  return getRoleWithPermissions(roleName);
}
