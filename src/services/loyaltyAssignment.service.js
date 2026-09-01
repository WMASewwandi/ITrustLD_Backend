import { query } from '../config/database.js';
import { addColumnIfMissing } from '../db/helpers.js';
import {
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
import { getUserRoles } from './user.service.js';

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

/** Non-admins only see their own pending assignments, same as deposit/withdrawal executives. */
export function loyaltyAssignedToUserId(auth, status) {
  const roles = auth?.roles || [];
  const userId = Number(auth?.userId) || null;
  if (!userId || isSystemAdmin(roles)) return null;
  const normalized = String(status || 'Pending');
  if (normalized !== 'Pending') return null;
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

export async function listLoyaltyAssignees(kind) {
  const queue = QUEUES[kind];
  if (!queue) {
    throw validationError('Invalid loyalty queue.');
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
  const pendingSql = `id IN (${placeholders}) AND status = 'Pending'`;
  const pendingRows = await query(
    `SELECT id${kind === 'order' ? ', payment_option' : ''} FROM ${queue.table} WHERE ${pendingSql}`,
    recordIds,
  );
  const pendingIds = pendingRows.map((row) => Number(row.id)).filter(Boolean);
  if (!pendingIds.length) {
    throw validationError(`Only pending ${queue.label}s can be assigned.`);
  }

  if (kind === 'order' && execId != null) {
    const isWithdrawalExec = execRoles.includes('withdrawal-executive');
    const bankTransferIds = pendingRows.filter((row) => isLoyaltyBankTransfer(row.payment_option));
    const otherIds = pendingRows.filter((row) => !isLoyaltyBankTransfer(row.payment_option));
    if (isWithdrawalExec && otherIds.length) {
      throw validationError('Withdrawal executives can only be assigned Bank Transfer loyalty orders.');
    }
    if (!isWithdrawalExec && bankTransferIds.length) {
      throw validationError('Bank Transfer loyalty orders must be assigned to a withdrawal executive.');
    }
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
