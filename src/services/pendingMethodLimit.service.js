import { query } from '../config/database.js';

export const MAX_PENDING_PER_METHOD = 5;
export const PENDING_METHOD_LIMIT_CODE = 'PENDING_METHOD_LIMIT';

function validationError(message, status = 422) {
  const error = new Error(message);
  error.status = status;
  error.code = PENDING_METHOD_LIMIT_CODE;
  return error;
}

export function pendingMethodLimitMessage(kind, methodName) {
  const label = kind === 'withdrawal' ? 'cash-out' : 'top-up';
  const method = methodName ? ` for ${methodName}` : ' for this method';
  return `You already have ${MAX_PENDING_PER_METHOD} pending ${label} requests${method}. Please wait until one is completed or rejected before submitting another.`;
}

export async function countOpenDepositsForMethod(userId, methodId) {
  const rows = await query(
    `SELECT COUNT(*) AS count
     FROM deposits
     WHERE user_id = ?
       AND topup_method_id = ?
       AND transaction_status = 'Pending'
       AND payment_proof IS NOT NULL`,
    [userId, methodId],
  );
  return Number(rows[0]?.count || 0);
}

export async function countOpenWithdrawalsForMethod(userId, methodId) {
  const rows = await query(
    `SELECT COUNT(*) AS count
     FROM withdrawals
     WHERE user_id = ?
       AND cashout_method_id = ?
       AND transaction_status IN ('Pending', 'Pending Authorization')
       AND cashout_payment_proof IS NOT NULL`,
    [userId, methodId],
  );
  return Number(rows[0]?.count || 0);
}

export async function getOpenDepositCountsByMethod(userId) {
  const rows = await query(
    `SELECT topup_method_id AS method_id, COUNT(*) AS count
     FROM deposits
     WHERE user_id = ?
       AND transaction_status = 'Pending'
       AND payment_proof IS NOT NULL
     GROUP BY topup_method_id`,
    [userId],
  );
  const map = {};
  for (const row of rows) {
    if (row.method_id == null) continue;
    map[String(row.method_id)] = Number(row.count) || 0;
  }
  return map;
}

export async function getOpenWithdrawalCountsByMethod(userId) {
  const rows = await query(
    `SELECT cashout_method_id AS method_id, COUNT(*) AS count
     FROM withdrawals
     WHERE user_id = ?
       AND transaction_status IN ('Pending', 'Pending Authorization')
       AND cashout_payment_proof IS NOT NULL
     GROUP BY cashout_method_id`,
    [userId],
  );
  const map = {};
  for (const row of rows) {
    if (row.method_id == null) continue;
    map[String(row.method_id)] = Number(row.count) || 0;
  }
  return map;
}

export async function assertDepositMethodPendingLimit(userId, methodId, methodName) {
  const count = await countOpenDepositsForMethod(userId, methodId);
  if (count >= MAX_PENDING_PER_METHOD) {
    throw validationError(pendingMethodLimitMessage('deposit', methodName));
  }
  return count;
}

export async function assertWithdrawalMethodPendingLimit(userId, methodId, methodName) {
  const count = await countOpenWithdrawalsForMethod(userId, methodId);
  if (count >= MAX_PENDING_PER_METHOD) {
    throw validationError(pendingMethodLimitMessage('withdrawal', methodName));
  }
  return count;
}

export function attachPendingCounts(methods, countsByMethod) {
  return (Array.isArray(methods) ? methods : []).map((method) => ({
    ...method,
    pendingCount: Number(countsByMethod[String(method.id)] || 0),
  }));
}
