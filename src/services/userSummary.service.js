import { query } from '../config/database.js';
import { getLevelDisplayName, getUserPointLevel } from './pointEarning.service.js';

async function getPointTotals(userId) {
  const rows = await query(
    `SELECT
        COALESCE(SUM(point_earning_amount), 0) AS total,
        COALESCE(SUM(
          CASE
            WHEN created_at >= DATE_SUB(NOW(), INTERVAL 1 YEAR) THEN point_earning_amount
            ELSE 0
          END
        ), 0) AS year_total
     FROM point_earnings
     WHERE user_id = ?`,
    [userId],
  );
  return {
    trustPoints: Number(rows[0]?.total || 0),
    earnedForYear: Number(rows[0]?.year_total || 0),
  };
}

export async function getTrustPoints(userId) {
  const totals = await getPointTotals(userId);
  return totals.trustPoints;
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

const PENDING_ID_LIMIT = 5;

export async function getPendingDepositIds(userId) {
  const rows = await query(
    `SELECT COALESCE(transaction_id, CAST(id AS CHAR)) AS transaction_id
     FROM deposits
     WHERE user_id = ?
       AND transaction_status = 'Pending'
       AND payment_proof IS NOT NULL
     ORDER BY created_at DESC
     LIMIT ${PENDING_ID_LIMIT}`,
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
     ORDER BY created_at DESC
     LIMIT ${PENDING_ID_LIMIT}`,
    [userId],
  );
  return rows.map((row) => String(row.transaction_id));
}

export function resolveUserType(accountHolder) {
  return accountHolder?.is_patner === 'YES' ? 'partner' : 'normal';
}

export async function getUserAccountSummary(userId) {
  const [
    pointTotals,
    savedBanksCount,
    pendingDepositsCount,
    pendingWithdrawalsCount,
    pendingDepositIds,
    pendingWithdrawalIds,
    pointLevel,
  ] = await Promise.all([
    getPointTotals(userId),
    getSavedBanksCount(userId),
    getPendingDepositsCount(userId),
    getPendingWithdrawalsCount(userId),
    getPendingDepositIds(userId),
    getPendingWithdrawalIds(userId),
    getUserPointLevel(userId),
  ]);

  const level = Number(pointLevel?.point_level_id) || 1;

  return {
    trust_points: pointTotals.trustPoints,
    saved_banks_count: savedBanksCount,
    pending_deposits_count: pendingDepositsCount,
    pending_withdrawals_count: pendingWithdrawalsCount,
    pending_deposit_ids: pendingDepositIds,
    pending_withdrawal_ids: pendingWithdrawalIds,
    current_tier: getLevelDisplayName(level),
    earned_for_year: pointTotals.earnedForYear,
  };
}
