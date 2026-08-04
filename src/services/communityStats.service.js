import { query } from '../config/database.js';
import { getUserCountDisplay } from './userCountDisplay.service.js';

async function countCompletedDeposits() {
  const rows = await query(
    `SELECT COUNT(*) AS total
     FROM deposits
     WHERE transaction_status = 'Completed'`,
  );
  return Number(rows[0]?.total) || 0;
}

async function countCompletedWithdrawals() {
  const rows = await query(
    `SELECT COUNT(*) AS total
     FROM withdrawals
     WHERE transaction_status = 'Completed'`,
  );
  return Number(rows[0]?.total) || 0;
}

async function countAvailablePaymentMethods() {
  try {
    const rows = await query(
      `SELECT COUNT(*) AS total
       FROM payment_options
       WHERE UPPER(availability) = 'AVAILABLE'
         AND (is_deleted = 0 OR is_deleted IS NULL OR is_deleted = FALSE)`,
    );
    return Number(rows[0]?.total) || 0;
  } catch {
    return 0;
  }
}

export async function getPublicCommunityStats() {
  const [userCount, completedDeposits, completedWithdrawals, paymentMethods] = await Promise.all([
    getUserCountDisplay(),
    countCompletedDeposits(),
    countCompletedWithdrawals(),
    countAvailablePaymentMethods(),
  ]);

  return {
    members: {
      baseCount: userCount.baseCount,
      liveCount: userCount.liveCount,
      displayedCount: userCount.displayedCount,
    },
    transactions: {
      completedDeposits,
      completedWithdrawals,
    },
    paymentMethods,
  };
}
