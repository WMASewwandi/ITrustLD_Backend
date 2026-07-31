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
  ADDRESS_PENDING: 30,
  ADDRESS_APPROVE: 31,
  ADDRESS_REJECT: 32,
  IDENTITY_PENDING: 33,
  IDENTITY_APPROVE: 34,
  IDENTITY_REJECT: 35,
};
