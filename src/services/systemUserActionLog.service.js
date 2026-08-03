import { query } from '../config/database.js';

export async function logSystemUserAction(adminUserId, systemUserActionId) {
  if (!adminUserId || !systemUserActionId) return;
  await query(
    `INSERT INTO system_user_action_logs (system_user_action_id, admin_user_id, created_at, updated_at)
     VALUES (?, ?, NOW(), NOW())`,
    [systemUserActionId, adminUserId],
  );
}

export const SYSTEM_USER_ACTIONS = {
  DEPOSIT_PENDING: 10,
  DEPOSIT_APPROVE: 11,
  DEPOSIT_REJECT: 12,
  WITHDRAWAL_PENDING: 20,
  WITHDRAWAL_APPROVE: 21,
  WITHDRAWAL_REJECT: 22,
  LOYALTY_ORDER_PENDING: 40,
  LOYALTY_ORDER_APPROVE: 41,
  LOYALTY_ORDER_REJECT: 42,
  LOYALTY_BONUS_PENDING: 43,
  LOYALTY_BONUS_APPROVE: 44,
  LOYALTY_BONUS_REJECT: 45,
  VOUCHER_CLAIM_APPROVE: 47,
  VOUCHER_CLAIM_REJECT: 48,
  ADDRESS_PENDING: 30,
  ADDRESS_APPROVE: 31,
  ADDRESS_REJECT: 32,
  IDENTITY_PENDING: 33,
  IDENTITY_APPROVE: 34,
  IDENTITY_REJECT: 35,
};
