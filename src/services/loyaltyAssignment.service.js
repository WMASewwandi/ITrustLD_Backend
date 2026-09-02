import { getDbDriver, query } from '../config/database.js';
import { addColumnIfMissing } from '../db/helpers.js';
import {
  AUTHORIZE_LOYALTY_ORDERS,
  LEGACY_LOYALTY_UPDATE,
  LOYALTY_BONUS_UPDATE,
  LOYALTY_ORDERS_UPDATE,
} from '../constants/loyaltyPermissions.js';
import { nowSqlDateTime } from '../utils/slTime.js';
import { notifyAssignedSystemUser } from './assignedUserNotify.service.js';
import {
  buildExecutivesForAssignment,
  buildUsersForAssignmentByPermissions,
  findBestExecutive,
  findBestUserWithPermissions,
  getPendingCountForRole,
  touchExecutiveLastAssigned,
} from './shiftAssignment.service.js';
import { getUserPendingShowCount } from './systemUser.service.js';
import { getUserPermissions, getUserRoles } from './user.service.js';

const ASSIGNED_TO_DDL = {
  mysql: 'assigned_to INT NULL',
  sqlite: 'assigned_to INTEGER',
};

const BANK_TRANSFER = 'BANK TRANSFER';
const BANK_TRANSFER_SQL = `UPPER(TRIM(payment_option)) = 'BANK TRANSFER'`;
const NON_BANK_TRANSFER_SQL = `UPPER(TRIM(COALESCE(payment_option, ''))) <> 'BANK TRANSFER'`;

const QUEUES = {
  order: {
    kind: 'loyalty-order',
    permissions: [LOYALTY_ORDERS_UPDATE, LEGACY_LOYALTY_UPDATE],
    table: 'point_withdrawals',
    pendingSql: `status = 'Pending' AND (assigned_to IS NULL OR assigned_to = 0) AND ${NON_BANK_TRANSFER_SQL}`,
    smsType: 'LOYALTY_ORDER_PENDING',
    label: 'loyalty order',
  },
  bonus: {
    kind: 'loyalty-bonus',
    permissions: [LOYALTY_BONUS_UPDATE, LEGACY_LOYALTY_UPDATE],
    table: 'loyalty_bonus_collects',
    pendingSql: `status = 'Pending' AND (assigned_to IS NULL OR assigned_to = 0)`,
    smsType: 'LOYALTY_BONUS_PENDING',
    label: 'loyalty bonus claim',
  },
};

const BANK_TRANSFER_ORDER_QUEUE = {
  ...QUEUES.order,
  pendingSql: `status = 'Pending' AND (assigned_to IS NULL OR assigned_to = 0) AND ${BANK_TRANSFER_SQL}`,
};

export async function ensureLoyaltyAssignedToColumn(table) {
  await addColumnIfMissing(table, 'assigned_to', ASSIGNED_TO_DDL);
}

export function isLoyaltySystemAdmin(roles = []) {
  return roles.includes('super-admin') || roles.includes('sub-admin');
}

export function canAuthorizeLoyaltyOrders(permissions = []) {
  return (permissions || []).includes(AUTHORIZE_LOYALTY_ORDERS);
}

export function isLoyaltyOrderExecutive(roles = [], permissions = []) {
  return (
    !isLoyaltySystemAdmin(roles) &&
    (permissions || []).includes(LOYALTY_ORDERS_UPDATE)
  );
}

export function isLoyaltyOrderAuthorizerOnly(roles = [], permissions = []) {
  return (
    canAuthorizeLoyaltyOrders(permissions) &&
    !isLoyaltySystemAdmin(roles) &&
    !(permissions || []).includes(LOYALTY_ORDERS_UPDATE)
  );
}

let loyaltyOrderStatusEnumReady = false;
let loyaltyAuthorizerCache = { value: null, expiresAt: 0 };

export async function ensureLoyaltyOrderAuthorizationSchema() {
  if (loyaltyOrderStatusEnumReady) return;
  if (getDbDriver() === 'sqlite') {
    loyaltyOrderStatusEnumReady = true;
    return;
  }
  try {
    await query(
      `ALTER TABLE point_withdrawals
       MODIFY status ENUM('Pending', 'Pending Authorization', 'Approved', 'Rejected') NOT NULL DEFAULT 'Pending'`,
    );
  } catch (error) {
    console.warn('[loyalty-orders:status-enum]', error.message);
  }
  loyaltyOrderStatusEnumReady = true;
}

export async function hasActiveLoyaltyOrderAuthorizers() {
  if (loyaltyAuthorizerCache.value != null && Date.now() < loyaltyAuthorizerCache.expiresAt) {
    return loyaltyAuthorizerCache.value;
  }
  const value = await loadActiveLoyaltyOrderAuthorizers();
  loyaltyAuthorizerCache = { value, expiresAt: Date.now() + 60_000 };
  return value;
}

async function loadActiveLoyaltyOrderAuthorizers() {
  const permissionRows = await query('SELECT id, name FROM permissions');
  const ids = permissionRows
    .filter((row) => String(row.name || '').trim() === AUTHORIZE_LOYALTY_ORDERS)
    .map((row) => row.id);
  if (!ids.length) return false;

  const placeholders = ids.map(() => '?').join(', ');
  const viaRole = await query(
    `SELECT COUNT(*) AS cnt
     FROM model_has_roles mhr
     INNER JOIN role_has_permissions rhp ON rhp.role_id = mhr.role_id
     INNER JOIN users u ON u.id = mhr.model_id
     WHERE rhp.permission_id IN (${placeholders})
       AND mhr.model_type LIKE '%User'
       AND (u.is_active IS NULL OR u.is_active = 1)
       AND NOT EXISTS (
         SELECT 1
         FROM model_has_roles mhr2
         INNER JOIN roles r2 ON r2.id = mhr2.role_id
         WHERE mhr2.model_id = u.id
           AND mhr2.model_type LIKE '%User'
           AND r2.name IN ('super-admin', 'sub-admin')
       )`,
    ids,
  );
  if (Number(viaRole[0]?.cnt) > 0) return true;

  try {
    const viaDirect = await query(
      `SELECT COUNT(*) AS cnt
       FROM model_has_permissions mhp
       INNER JOIN users u ON u.id = mhp.model_id
       WHERE mhp.permission_id IN (${placeholders})
         AND mhp.model_type LIKE '%User'
         AND (u.is_active IS NULL OR u.is_active = 1)
         AND NOT EXISTS (
           SELECT 1
           FROM model_has_roles mhr2
           INNER JOIN roles r2 ON r2.id = mhr2.role_id
           WHERE mhr2.model_id = u.id
             AND mhr2.model_type LIKE '%User'
             AND r2.name IN ('super-admin', 'sub-admin')
         )`,
      ids,
    );
    if (Number(viaDirect[0]?.cnt) > 0) return true;
  } catch {
    // model_has_permissions may be absent
  }
  return false;
}

export function isLoyaltyBankTransfer(paymentOption) {
  return String(paymentOption || '').trim().toUpperCase() === BANK_TRANSFER;
}

function isSystemAdmin(roles = []) {
  return isLoyaltySystemAdmin(roles);
}

function validationError(message, status = 422) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function assertAdminCanAssign(auth) {
  if (!isSystemAdmin(auth?.roles || [])) {
    throw validationError('Only admins can assign loyalty requests.', 403);
  }
}

/** Non-admins only see their own pending / pending-authorization assignments. */
export function loyaltyAssignedToUserId(auth, status) {
  const roles = auth?.roles || [];
  const userId = Number(auth?.userId) || null;
  if (!userId || isSystemAdmin(roles)) return null;
  const normalized = String(status || 'Pending');
  if (normalized !== 'Pending' && normalized !== 'Pending Authorization') return null;
  return userId;
}

async function assignRow(queue, rowId, displayId, executive) {
  if (!executive) return null;
  await ensureLoyaltyAssignedToColumn(queue.table);

  await query(
    `UPDATE ${queue.table}
     SET assigned_to = ?, updated_at = ?
     WHERE id = ?`,
    [executive.id, nowSqlDateTime(), rowId],
  );
  await touchExecutiveLastAssigned(executive.id);
  await notifyAssignedSystemUser({
    userId: executive.id,
    message: `Pending ${queue.label} has been assigned to you: ${displayId}. Please review. Thanks`,
    smsType: queue.smsType,
  }).catch((error) => {
    console.error(`[${queue.kind}:assigned-sms]`, error.message);
  });
  return executive.id;
}

async function refillQueue(queue, userId, pendingKind = queue.kind) {
  const executiveId = Number(userId);
  if (!executiveId) return 0;

  await ensureLoyaltyAssignedToColumn(queue.table);

  const showCount = await getUserPendingShowCount(executiveId);
  if (!showCount) return 0;

  const roles = await getUserRoles(executiveId);
  const current = await getPendingCountForRole(executiveId, roles, pendingKind);
  const need = showCount - current;
  if (need <= 0) return 0;

  const rows = await query(
    `SELECT id FROM ${queue.table}
     WHERE ${queue.pendingSql}
     ORDER BY updated_at ASC
     LIMIT ${need}`,
  );
  if (!rows.length) return 0;

  const ids = rows.map((row) => row.id);
  const placeholders = ids.map(() => '?').join(', ');
  await query(
    `UPDATE ${queue.table} SET assigned_to = ?, updated_at = ? WHERE id IN (${placeholders})`,
    [executiveId, nowSqlDateTime(), ...ids],
  );
  await touchExecutiveLastAssigned(executiveId);
  await notifyAssignedSystemUser({
    userId: executiveId,
    message: `${ids.length} pending ${queue.label}(s) have been assigned to you. Please review. Thanks`,
    smsType: queue.smsType,
  }).catch((error) => {
    console.error(`[${queue.kind}:assigned-sms]`, error.message);
  });
  return ids.length;
}

async function loadOrderPaymentOption(orderId) {
  const rows = await query(
    `SELECT payment_option FROM point_withdrawals WHERE id = ? LIMIT 1`,
    [orderId],
  );
  return rows[0]?.payment_option || '';
}

export async function autoAssignLoyaltyOrder(row) {
  if (!row?.id) return null;
  const paymentOption = row.payment_option ?? row.paymentOption ?? (await loadOrderPaymentOption(row.id));
  const displayId = row.transaction_id || row.id;
  if (isLoyaltyBankTransfer(paymentOption)) {
    const executive = await findBestExecutive('withdrawal-executive');
    return assignRow(QUEUES.order, row.id, displayId, executive);
  }
  const executive = await findBestUserWithPermissions(QUEUES.order.permissions, QUEUES.order.kind);
  return assignRow(QUEUES.order, row.id, displayId, executive);
}

export async function autoAssignLoyaltyBonus(row) {
  if (!row?.id) return null;
  const executive = await findBestUserWithPermissions(QUEUES.bonus.permissions, QUEUES.bonus.kind);
  return assignRow(QUEUES.bonus, row.id, row.transaction_id || row.id, executive);
}

export async function refillLoyaltyOrderPending(userId) {
  const executiveId = Number(userId);
  if (!executiveId) return 0;
  const roles = await getUserRoles(executiveId);
  if (isSystemAdmin(roles)) return 0;
  if (roles.includes('withdrawal-executive')) {
    return refillQueue(BANK_TRANSFER_ORDER_QUEUE, executiveId, 'withdrawal-executive');
  }
  return refillQueue(QUEUES.order, executiveId);
}

export async function autoAssignLoyaltyOrderAuthorizer(row) {
  if (!row?.id) return null;
  const authorizer = await findBestUserWithPermissions(
    [AUTHORIZE_LOYALTY_ORDERS],
    'loyalty-order-authorizer',
  );
  return assignRow(
    {
      ...QUEUES.order,
      label: 'loyalty order authorization',
      smsType: 'LOYALTY_ORDER_PENDING',
    },
    row.id,
    row.transaction_id || row.id,
    authorizer,
  );
}

export async function refillLoyaltyOrderAuthorization(userId) {
  const executiveId = Number(userId);
  if (!executiveId) return 0;
  const roles = await getUserRoles(executiveId);
  if (isSystemAdmin(roles)) return 0;
  return refillQueue(
    {
      ...QUEUES.order,
      pendingSql: `status = 'Pending Authorization' AND (assigned_to IS NULL OR assigned_to = 0)`,
      label: 'loyalty order authorization',
    },
    executiveId,
    'loyalty-order-authorizer',
  );
}

export async function refillLoyaltyBonusPending(userId) {
  return refillQueue(QUEUES.bonus, userId);
}

function mergeAssigneeLists(primary = {}, extra = {}) {
  const byId = new Map();
  for (const executive of [...(primary.executives || []), ...(extra.executives || [])]) {
    if (!byId.has(Number(executive.id))) {
      byId.set(Number(executive.id), executive);
    }
  }
  return {
    active_shift: primary.active_shift || extra.active_shift || null,
    executives: [...byId.values()],
  };
}

export async function listLoyaltyAssignees(kind, { authorizers = false } = {}) {
  const queue = QUEUES[kind];
  if (!queue) {
    throw validationError('Invalid loyalty queue.');
  }
  if (kind === 'order' && authorizers) {
    return buildUsersForAssignmentByPermissions(
      [AUTHORIZE_LOYALTY_ORDERS],
      'loyalty-order-authorizer',
    );
  }
  const loyaltyUsers = await buildUsersForAssignmentByPermissions(queue.permissions, queue.kind);
  if (kind !== 'order') {
    return loyaltyUsers;
  }
  const withdrawalExecs = await buildExecutivesForAssignment('withdrawal-executive', {
    includeSubAdmin: false,
  });
  return mergeAssigneeLists(withdrawalExecs, loyaltyUsers);
}

export async function assignLoyaltyRecords(auth, kind, { ids, executiveId }) {
  assertAdminCanAssign(auth);
  const queue = QUEUES[kind];
  if (!queue) {
    throw validationError('Invalid loyalty queue.');
  }

  await ensureLoyaltyAssignedToColumn(queue.table);

  const recordIds = [...new Set((ids || []).map((id) => Number(id)).filter(Boolean))];
  if (!recordIds.length) {
    throw validationError(`At least one ${queue.label} is required.`);
  }

  const execId =
    executiveId == null || executiveId === '' ? null : Number(executiveId);

  let execRoles = [];
  if (execId != null) {
    const execRows = await query(`SELECT id FROM users WHERE id = ? LIMIT 1`, [execId]);
    if (!execRows[0]) {
      throw validationError('User not found.');
    }
    execRoles = await getUserRoles(execId);
    if (isSystemAdmin(execRoles)) {
      throw validationError('Cannot assign to an admin. Select a user with update permission.');
    }
  }

  const placeholders = recordIds.map(() => '?').join(', ');
  const selectedRows = await query(
    `SELECT id, status${kind === 'order' ? ', payment_option' : ''} FROM ${queue.table} WHERE id IN (${placeholders})`,
    recordIds,
  );
  if (!selectedRows.length) {
    throw validationError(`${queue.label.charAt(0).toUpperCase()}${queue.label.slice(1)} not found.`, 404);
  }
  const statuses = [...new Set(selectedRows.map((row) => String(row.status || '').trim()))];
  if (statuses.length !== 1) {
    throw validationError(`Select ${queue.label}s with the same status to assign.`);
  }
  const queueStatus = statuses[0];
  const canAssignPendingAuth = kind === 'order' && queueStatus === 'Pending Authorization';
  if (queueStatus !== 'Pending' && !canAssignPendingAuth) {
    throw validationError(`Only pending ${queue.label}s can be assigned.`);
  }

  if (canAssignPendingAuth && execId != null) {
    const permissions = await getUserPermissions(execId);
    if (!canAuthorizeLoyaltyOrders(permissions)) {
      throw validationError('Pending authorization orders must be assigned to a user with authorize permission.');
    }
  }

  if (kind === 'order' && execId != null && queueStatus === 'Pending') {
    const isWithdrawalExec = execRoles.includes('withdrawal-executive');
    const bankTransferIds = selectedRows.filter((row) => isLoyaltyBankTransfer(row.payment_option));
    const otherIds = selectedRows.filter((row) => !isLoyaltyBankTransfer(row.payment_option));
    if (isWithdrawalExec && otherIds.length) {
      throw validationError('Withdrawal executives can only be assigned Bank Transfer loyalty orders.');
    }
    if (!isWithdrawalExec && bankTransferIds.length) {
      throw validationError('Bank Transfer loyalty orders must be assigned to a withdrawal executive.');
    }
  }

  const assignableIds = selectedRows.map((row) => Number(row.id)).filter(Boolean);
  const pendingPlaceholders = assignableIds.map(() => '?').join(', ');
  await query(`UPDATE ${queue.table} SET assigned_to = ? WHERE id IN (${pendingPlaceholders})`, [
    execId,
    ...assignableIds,
  ]);

  if (execId) {
    await notifyAssignedSystemUser({
      userId: execId,
      message: `${assignableIds.length} ${
        canAssignPendingAuth ? 'pending authorization' : 'pending'
      } ${queue.label}(s) have been assigned to you. Please review. Thanks`,
      smsType: queue.smsType,
    }).catch((error) => {
      console.error(`[${queue.kind}:assigned-sms]`, error.message);
    });
  }

  return {
    error: false,
    message: execId
      ? `${queue.label.charAt(0).toUpperCase()}${queue.label.slice(1)}s assigned successfully`
      : `${queue.label.charAt(0).toUpperCase()}${queue.label.slice(1)}s unassigned successfully`,
    assigned_count: assignableIds.length,
  };
}
