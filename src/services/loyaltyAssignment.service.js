import { query } from '../config/database.js';
import { addColumnIfMissing } from '../db/helpers.js';
import {
  LEGACY_LOYALTY_UPDATE,
  LOYALTY_BONUS_UPDATE,
  LOYALTY_ORDERS_UPDATE,
  LOYALTY_VOUCHER_UPDATE,
} from '../constants/loyaltyPermissions.js';
import { nowSqlDateTime } from '../utils/slTime.js';
import { notifyAssignedSystemUser } from './assignedUserNotify.service.js';
import {
  buildUsersForAssignmentByPermissions,
  findBestUserWithPermissions,
  getPendingCountForRole,
  touchExecutiveLastAssigned,
} from './shiftAssignment.service.js';
import { getUserPendingShowCount } from './systemUser.service.js';
import { getUserRoles } from './user.service.js';

const ASSIGNED_TO_DDL = {
  mysql: 'assigned_to INT NULL',
  sqlite: 'assigned_to INTEGER',
};

const QUEUES = {
  order: {
    kind: 'loyalty-order',
    permissions: [LOYALTY_ORDERS_UPDATE, LEGACY_LOYALTY_UPDATE],
    table: 'point_withdrawals',
    pendingSql: `status = 'Pending' AND (assigned_to IS NULL OR assigned_to = 0)`,
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
  voucher: {
    kind: 'loyalty-voucher',
    permissions: [LOYALTY_VOUCHER_UPDATE, LEGACY_LOYALTY_UPDATE],
    table: 'loyalty_client_bonus_vouchers',
    pendingSql: `is_claimed = 0 AND (rejection_reason IS NULL OR rejection_reason = '') AND (assigned_to IS NULL OR assigned_to = 0)`,
    smsType: 'LOYALTY_VOUCHER_PENDING',
    label: 'loyalty voucher claim',
  },
};

export async function ensureLoyaltyAssignedToColumn(table) {
  await addColumnIfMissing(table, 'assigned_to', ASSIGNED_TO_DDL);
}

export function isLoyaltySystemAdmin(roles = []) {
  return roles.includes('super-admin') || roles.includes('sub-admin');
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

/** Non-admins only see their own pending assignments, same as deposit/withdrawal executives. */
export function loyaltyAssignedToUserId(auth, status) {
  const roles = auth?.roles || [];
  const userId = Number(auth?.userId) || null;
  if (!userId || isSystemAdmin(roles)) return null;
  const normalized = String(status || 'Pending');
  if (normalized !== 'Pending') return null;
  return userId;
}

async function assignRow(queue, rowId, displayId) {
  await ensureLoyaltyAssignedToColumn(queue.table);
  const executive = await findBestUserWithPermissions(queue.permissions, queue.kind);
  if (!executive) return null;

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

async function refillQueue(queue, userId) {
  const executiveId = Number(userId);
  if (!executiveId) return 0;

  await ensureLoyaltyAssignedToColumn(queue.table);

  const showCount = await getUserPendingShowCount(executiveId);
  if (!showCount) return 0;

  const roles = await getUserRoles(executiveId);
  const current = await getPendingCountForRole(executiveId, roles, queue.kind);
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

export async function autoAssignLoyaltyOrder(row) {
  if (!row?.id) return null;
  return assignRow(QUEUES.order, row.id, row.transaction_id || row.id);
}

export async function autoAssignLoyaltyBonus(row) {
  if (!row?.id) return null;
  return assignRow(QUEUES.bonus, row.id, row.transaction_id || row.id);
}

export async function autoAssignLoyaltyVoucher(row) {
  if (!row?.id) return null;
  return assignRow(QUEUES.voucher, row.id, row.voucher_token || row.id);
}

export async function refillLoyaltyOrderPending(userId) {
  return refillQueue(QUEUES.order, userId);
}

export async function refillLoyaltyBonusPending(userId) {
  return refillQueue(QUEUES.bonus, userId);
}

export async function refillLoyaltyVoucherPending(userId) {
  return refillQueue(QUEUES.voucher, userId);
}

export async function listLoyaltyAssignees(kind) {
  const queue = QUEUES[kind];
  if (!queue) {
    throw validationError('Invalid loyalty queue.');
  }
  return buildUsersForAssignmentByPermissions(queue.permissions, queue.kind);
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

  if (execId != null) {
    const execRows = await query(`SELECT id FROM users WHERE id = ? LIMIT 1`, [execId]);
    if (!execRows[0]) {
      throw validationError('User not found.');
    }
    const roles = await getUserRoles(execId);
    if (isSystemAdmin(roles)) {
      throw validationError('Cannot assign to an admin. Select a user with update permission.');
    }
  }

  const placeholders = recordIds.map(() => '?').join(', ');
  const pendingSql =
    kind === 'voucher'
      ? `id IN (${placeholders}) AND is_claimed = 0 AND (rejection_reason IS NULL OR rejection_reason = '')`
      : `id IN (${placeholders}) AND status = 'Pending'`;
  const pendingRows = await query(
    `SELECT id FROM ${queue.table} WHERE ${pendingSql}`,
    recordIds,
  );
  const pendingIds = pendingRows.map((row) => Number(row.id)).filter(Boolean);
  if (!pendingIds.length) {
    throw validationError(`Only pending ${queue.label}s can be assigned.`);
  }

  const pendingPlaceholders = pendingIds.map(() => '?').join(', ');
  await query(`UPDATE ${queue.table} SET assigned_to = ? WHERE id IN (${pendingPlaceholders})`, [
    execId,
    ...pendingIds,
  ]);

  if (execId) {
    await notifyAssignedSystemUser({
      userId: execId,
      message: `${pendingIds.length} pending ${queue.label}(s) have been assigned to you. Please review. Thanks`,
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
    assigned_count: pendingIds.length,
  };
}
