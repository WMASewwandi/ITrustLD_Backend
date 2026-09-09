import { query } from '../config/database.js';
import { countPendingGiftClaims } from './adminLoyaltyGifts.service.js';
import { countCustomerAccounts } from './customerAccount.service.js';
import { countHelpTickets, countUnreadHelpTickets } from './helpTicket.service.js';
import { AUTHORIZE_WITHDRAWAL_PERMISSION } from '../constants/adminRoles.js';
import {
  ALL_LOYALTY_READ_PERMISSIONS,
  AUTHORIZE_LOYALTY_ORDERS,
  LOYALTY_BONUS_READ,
  LOYALTY_GIFTS_READ,
  LOYALTY_ORDERS_READ,
  LOYALTY_VOUCHER_READ,
  userHasPermission,
} from '../constants/loyaltyPermissions.js';
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
  if (isAuthorizerOnly) return 0;

  const conditions = ["transaction_status = 'Pending'", 'cashout_payment_proof IS NOT NULL'];
  const values = [];

  if (isExec && userId) {
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

function canReadLoyaltySection(permissions = [], required, roles = []) {
  if (isSystemAdminRole(roles)) return true;
  const list = Array.isArray(permissions) ? permissions : [];
  if (required === AUTHORIZE_LOYALTY_ORDERS) return list.includes(AUTHORIZE_LOYALTY_ORDERS);
  if (list.includes(required)) return true;
  const hasSectionWise = ALL_LOYALTY_READ_PERMISSIONS.some((permission) => list.includes(permission));
  if (hasSectionWise) return false;
  return userHasPermission(list, required);
}

async function countPendingLoyaltyOrders(userId, roles, permissions = []) {
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

async function countPendingAuthorizationLoyaltyOrders(userId, roles, permissions = []) {
  const conditions = ["status = 'Pending Authorization'"];
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

async function countPendingVoucherClaims(_userId, _roles) {
  try {
    const rows = await query(
      `SELECT COUNT(*) AS total
       FROM loyalty_client_bonus_vouchers
       WHERE is_claimed = 0
         AND (rejection_reason IS NULL OR rejection_reason = '')`,
    );
    return Number(rows[0]?.total ?? 0);
  } catch {
    return 0;
  }
}

export async function getAdminNavCounts(roles = [], userId = null) {
  const permissions = userId ? await getUserPermissions(userId) : [];
  const withdrawalScope = await getWithdrawalQueueScope(userId, roles, permissions);
  const canOrders =
    canReadLoyaltySection(permissions, LOYALTY_ORDERS_READ, roles) ||
    canReadLoyaltySection(permissions, AUTHORIZE_LOYALTY_ORDERS, roles);
  const canBonus = canReadLoyaltySection(permissions, LOYALTY_BONUS_READ, roles);
  const canVouchers = canReadLoyaltySection(permissions, LOYALTY_VOUCHER_READ, roles);
  const canGifts = canReadLoyaltySection(permissions, LOYALTY_GIFTS_READ, roles);

  const [
    usersPending,
    usersAddressPending,
    usersNicPending,
    depositsPending,
    withdrawalsPending,
    withdrawalsPendingAuthorization,
    loyaltyOrdersPending,
    loyaltyOrdersPendingAuthorization,
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
    canOrders ? countPendingLoyaltyOrders(userId, roles) : 0,
    canOrders ? countPendingAuthorizationLoyaltyOrders(userId, roles) : 0,
    canBonus ? countPendingBonusClaims(userId, roles) : 0,
    canVouchers ? countPendingVoucherClaims(userId, roles) : 0,
    canGifts ? countPendingGiftClaims() : 0,
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
      orders_pending_authorization: loyaltyOrdersPendingAuthorization,
      bonus: loyaltyBonusPending,
      vouchers: loyaltyVouchersPending,
      gifts: loyaltyGiftsPending,
    },
    help_tickets: { total: helpTicketsTotal, unread: helpTicketsUnread },
  };
}
