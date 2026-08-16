import { query } from '../config/database.js';

export async function getTrustPoints(userId) {
  const rows = await query(
    `SELECT COALESCE(SUM(point_earning_amount), 0) AS total
     FROM point_earnings
     WHERE user_id = ?`,
    [userId],
  );
  return Number(rows[0]?.total || 0);
}

export async function getSavedBanksCount(userId) {
  const rows = await query(
    `SELECT COUNT(*) AS count
     FROM user_bank_accounts
     WHERE user_id = ? AND (is_deleted = 0 OR is_deleted IS NULL)`,
    [userId],
  );
  return Number(rows[0]?.count || 0);
}

export async function getPendingDepositsCount(userId) {
  const rows = await query(
    `SELECT COUNT(*) AS count
     FROM deposits
     WHERE user_id = ?
       AND transaction_status = 'Pending'
       AND payment_proof IS NOT NULL`,
    [userId],
  );
  return Number(rows[0]?.count || 0);
}

export async function getPendingWithdrawalsCount(userId) {
  const rows = await query(
    `SELECT COUNT(*) AS count
     FROM withdrawals
     WHERE user_id = ?
       AND transaction_status = 'Pending'
       AND cashout_payment_proof IS NOT NULL`,
    [userId],
  );
  return Number(rows[0]?.count || 0);
}

export async function getPendingDepositIds(userId) {
  const rows = await query(
    `SELECT COALESCE(transaction_id, CAST(id AS CHAR)) AS transaction_id
     FROM deposits
     WHERE user_id = ?
       AND transaction_status = 'Pending'
       AND payment_proof IS NOT NULL
     ORDER BY created_at DESC`,
    [userId],
  );
  return rows.map((row) => String(row.transaction_id));
}

export async function getPendingWithdrawalIds(userId) {
  const rows = await query(
    `SELECT COALESCE(transaction_id, CAST(id AS CHAR)) AS transaction_id
     FROM withdrawals
     WHERE user_id = ?
       AND transaction_status = 'Pending'
       AND cashout_payment_proof IS NOT NULL
     ORDER BY created_at DESC`,
    [userId],
  );
  return rows.map((row) => String(row.transaction_id));
}

export function resolveUserType(accountHolder) {
  return accountHolder?.is_patner === 'YES' ? 'partner' : 'normal';
}

export async function getUserAccountSummary(userId) {
  const [
    trustPoints,
    savedBanksCount,
    pendingDepositIds,
    pendingWithdrawalIds,
  ] = await Promise.all([
    getTrustPoints(userId),
    getSavedBanksCount(userId),
    getPendingDepositIds(userId),
    getPendingWithdrawalIds(userId),
  ]);

  return {
    trust_points: trustPoints,
    saved_banks_count: savedBanksCount,
    pending_deposits_count: pendingDepositIds.length,
    pending_withdrawals_count: pendingWithdrawalIds.length,
    pending_deposit_ids: pendingDepositIds,
    pending_withdrawal_ids: pendingWithdrawalIds,
  };
}
