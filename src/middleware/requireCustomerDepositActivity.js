import { requirePermission } from './requirePermission.js';

export const requireCustomerDepositActivity = requirePermission(
  'customer_deposit_activity',
  'cusomer_deposit_activity',
);
