import { backfillTransactionAdmins } from '../src/services/backfillTransactionAdmins.service.js';

export const id = '2026_08_31_091200_backfill_completed_rejected_admin_ids';
export const description =
  'Backfill missing approved_by_admin / rejected_by_admin from assigned_to or pendings_by_admin';

export async function up({ logger = console } = {}) {
  const summary = await backfillTransactionAdmins();
  logger.info?.(`[migrate] backfilled transaction admin ids: ${JSON.stringify(summary)}`);
}
