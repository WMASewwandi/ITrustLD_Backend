import { requirePermission } from './requirePermission.js';

export const requireCustomerWithdrawalActivity = requirePermission(
  'customer_withdrawal_activity',
  'cusomer_withdrawal_activity',
);
