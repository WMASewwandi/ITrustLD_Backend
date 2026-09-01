import { query } from '../config/database.js';
import { countPendingGiftClaims } from './adminLoyaltyGifts.service.js';
import { countCustomerAccounts } from './customerAccount.service.js';
import { countHelpTickets, countUnreadHelpTickets } from './helpTicket.service.js';
import { AUTHORIZE_WITHDRAWAL_PERMISSION } from '../constants/adminRoles.js';
import { getUserPermissions } from './user.service.js';

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

async function getWithdrawalQueueScope(userId, roles = [], permissions = []) {
  const isAdminUser = roles.includes('super-admin') || roles.includes('sub-admin');
  const isExec = isWithdrawalExecutive(roles);
  let perms = Array.isArray(permissions) ? permissions : [];
  if (!isAdminUser && !isExec && userId && !perms.includes(AUTHORIZE_WITHDRAWAL_PERMISSION)) {
    perms = await getUserPermissions(userId);
  }
  const isAuthorizerOnly =
    (perms.includes(AUTHORIZE_WITHDRAWAL_PERMISSION) ||
      roles.some((role) =>
        ['withdrawal-authorizer', 'withdrawal-authorization'].includes(
          String(role || '')
            .trim()
            .toLowerCase()
            .replace(/[_ ]+/g, '-'),
        ),
      )) &&
    !isAdminUser &&
    !isExec;
  return { isExec, isAuthorizerOnly, isAdmin: isAdminUser };
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

async function countPendingWithdrawals(userId, { isExec, isAuthorizerOnly } = {}) {
  const conditions = ["transaction_status = 'Pending'", 'cashout_payment_proof IS NOT NULL'];
  const values = [];

  if ((isExec || isAuthorizerOnly) && userId) {
    conditions.push('assigned_to = ?');
    values.push(userId);
  }

  const rows = await query(
    `SELECT COUNT(*) AS total FROM withdrawals WHERE ${conditions.join(' AND ')}`,
    values,
  );
  return Number(rows[0]?.total ?? 0);
}

async function countPendingAuthorizationWithdrawals(userId, { isAdmin } = {}) {
  const conditions = [
    "transaction_status = 'Pending Authorization'",
    'cashout_payment_proof IS NOT NULL',
  ];
  const values = [];

  if (!isAdmin && userId) {
    conditions.push('assigned_to = ?');
    values.push(userId);
  }

  const rows = await query(
    `SELECT COUNT(*) AS total FROM withdrawals WHERE ${conditions.join(' AND ')}`,
    values,
  );
  return Number(rows[0]?.total ?? 0);
}

function isSystemAdminRole(roles = []) {
  return roles.includes('super-admin') || roles.includes('sub-admin');
}

async function countPendingLoyaltyOrders(userId, roles) {
  const conditions = ["status = 'Pending'"];
  const values = [];
  if (!isSystemAdminRole(roles) && userId) {
    conditions.push('assigned_to = ?');
    values.push(userId);
  }
  try {
    const rows = await query(
      `SELECT COUNT(*) AS total FROM point_withdrawals WHERE ${conditions.join(' AND ')}`,
      values,
    );
    return Number(rows[0]?.total ?? 0);
  } catch {
    return 0;
  }
}

async function countPendingBonusClaims(userId, roles) {
  const conditions = ["status = 'Pending'"];
  const values = [];
  if (!isSystemAdminRole(roles) && userId) {
    conditions.push('assigned_to = ?');
    values.push(userId);
  }
  try {
    const rows = await query(
      `SELECT COUNT(*) AS total FROM loyalty_bonus_collects WHERE ${conditions.join(' AND ')}`,
      values,
    );
    return Number(rows[0]?.total ?? 0);
  } catch {
    return 0;
  }
}

async function countPendingVoucherClaims(userId, roles) {
  const conditions = ['is_claimed = 0', 'rejection_reason IS NULL'];
  const values = [];
  if (!isSystemAdminRole(roles) && userId) {
    conditions.push('assigned_to = ?');
    values.push(userId);
  }
  try {
    const rows = await query(
      `SELECT COUNT(*) AS total
       FROM loyalty_client_bonus_vouchers
       WHERE ${conditions.join(' AND ')}`,
      values,
    );
    return Number(rows[0]?.total ?? 0);
  } catch {
    return 0;
  }
}

export async function getAdminNavCounts(roles = [], userId = null) {
  const withdrawalScope = await getWithdrawalQueueScope(userId, roles);
  const [
    usersPending,
    usersAddressPending,
    usersNicPending,
    depositsPending,
    withdrawalsPending,
    withdrawalsPendingAuthorization,
    loyaltyOrdersPending,
    loyaltyBonusPending,
    loyaltyVouchersPending,
    loyaltyGiftsPending,
    helpTicketsTotal,
    helpTicketsUnread,
  ] = await Promise.all([
    countCustomerAccounts('pending'),
    countCustomerAccounts('address-pending'),
    countCustomerAccounts('nic-pending'),
    countPendingDeposits(userId, roles),
    countPendingWithdrawals(userId, withdrawalScope),
    countPendingAuthorizationWithdrawals(userId, withdrawalScope),
    countPendingLoyaltyOrders(userId, roles),
    countPendingBonusClaims(userId, roles),
    countPendingVoucherClaims(userId, roles),
    countPendingGiftClaims(),
    countHelpTickets(),
    countUnreadHelpTickets(),
  ]);

  return {
    users: {
      pending: usersPending,
      address_pending: usersAddressPending,
      nic_pending: usersNicPending,
    },
    deposits: { pending: depositsPending },
    withdrawals: {
      pending: withdrawalsPending,
      pending_authorization: withdrawalsPendingAuthorization,
    },
    loyalty: {
      orders: loyaltyOrdersPending,
      bonus: loyaltyBonusPending,
      vouchers: loyaltyVouchersPending,
      gifts: loyaltyGiftsPending,
    },
    help_tickets: { total: helpTicketsTotal, unread: helpTicketsUnread },
  };
}
