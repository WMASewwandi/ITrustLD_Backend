import { query } from '../config/database.js';
import { countCustomerAccounts } from './customerAccount.service.js';

function isDepositExecutive(roles) {
  return (
    roles.includes('deposit-executive') &&
    !roles.includes('super-admin') &&
    !roles.includes('sub-admin')
  );
}

function isWithdrawalExecutive(roles) {
  return (
    roles.includes('withdrawal-executive') &&
    !roles.includes('super-admin') &&
    !roles.includes('sub-admin')
  );
}

async function countPendingDeposits(userId, roles) {
  const conditions = ["transaction_status = 'Pending'", 'payment_proof IS NOT NULL'];
  const values = [];

  if (isDepositExecutive(roles) && userId) {
    conditions.push('assigned_to = ?');
    values.push(userId);
  }

  const rows = await query(
    `SELECT COUNT(*) AS total FROM deposits WHERE ${conditions.join(' AND ')}`,
    values,
  );
  return Number(rows[0]?.total ?? 0);
}

async function countPendingWithdrawals(userId, roles) {
  const conditions = ["transaction_status = 'Pending'", 'cashout_payment_proof IS NOT NULL'];
  const values = [];

  if (isWithdrawalExecutive(roles) && userId) {
    conditions.push('assigned_to = ?');
    values.push(userId);
  }

  const rows = await query(
    `SELECT COUNT(*) AS total FROM withdrawals WHERE ${conditions.join(' AND ')}`,
    values,
  );
  return Number(rows[0]?.total ?? 0);
}

async function countPendingLoyaltyOrders() {
  const rows = await query(
    `SELECT COUNT(*) AS total FROM point_withdrawals WHERE status = 'Pending'`,
    [],
  );
  return Number(rows[0]?.total ?? 0);
}

async function countPendingBonusClaims() {
  const rows = await query(
    `SELECT COUNT(*) AS total FROM loyalty_bonus_collects WHERE status = 'Pending'`,
    [],
  );
  return Number(rows[0]?.total ?? 0);
}

async function countPendingVoucherClaims() {
  const rows = await query(
    `SELECT COUNT(*) AS total
     FROM loyalty_client_bonus_vouchers
     WHERE is_claimed = 0 AND rejection_reason IS NULL`,
    [],
  );
  return Number(rows[0]?.total ?? 0);
}

export async function getAdminNavCounts(roles = [], userId = null) {
  const [
    usersPending,
    usersAddressPending,
    usersNicPending,
    depositsPending,
    withdrawalsPending,
    loyaltyOrdersPending,
    loyaltyBonusPending,
    loyaltyVouchersPending,
  ] = await Promise.all([
    countCustomerAccounts('pending'),
    countCustomerAccounts('address-pending'),
    countCustomerAccounts('nic-pending'),
    countPendingDeposits(userId, roles),
    countPendingWithdrawals(userId, roles),
    countPendingLoyaltyOrders(),
    countPendingBonusClaims(),
    countPendingVoucherClaims(),
  ]);

  return {
    users: {
      pending: usersPending,
      address_pending: usersAddressPending,
      nic_pending: usersNicPending,
    },
    deposits: { pending: depositsPending },
    withdrawals: { pending: withdrawalsPending },
    loyalty: {
      orders: loyaltyOrdersPending,
      bonus: loyaltyBonusPending,
      vouchers: loyaltyVouchersPending,
    },
  };
}
