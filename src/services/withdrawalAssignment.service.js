import { query } from '../config/database.js';
import {
  findBestExecutive,
  findExecutiveAmongCandidates,
  getPendingCountForRole,
  touchExecutiveLastAssigned,
} from './shiftAssignment.service.js';
import { getUserPendingShowCount } from './systemUser.service.js';
import { getUserRoles } from './user.service.js';

export async function autoAssignWithdrawal(withdrawal) {
  if (!withdrawal?.id) return null;

  const platformId = String(withdrawal.cashout_account_id || '').trim();
  let executive = null;

  if (platformId) {
    const rows = await query(
      `SELECT DISTINCT assigned_to
       FROM withdrawals
       WHERE cashout_account_id = ?
         AND transaction_status = 'Pending'
         AND cashout_payment_proof IS NOT NULL
         AND assigned_to IS NOT NULL`,
      [platformId],
    );
    const preferredIds = rows.map((row) => row.assigned_to).filter(Boolean);
    executive = await findExecutiveAmongCandidates('withdrawal-executive', preferredIds);
  }

  if (!executive) {
    executive = await findBestExecutive('withdrawal-executive');
  }

  if (!executive) return null;

  await query(
    `UPDATE withdrawals
     SET assigned_to = ?, updated_at = NOW()
     WHERE id = ?`,
    [executive.id, withdrawal.id],
  );

  await touchExecutiveLastAssigned(executive.id);

  return executive.id;
}

/**
 * After approve/reject, top up an executive's assigned pending withdrawals
 * up to their optional pending_show_count (no-op if unset or already full).
 */
export async function refillWithdrawalPendingForExecutive(userId) {
  const executiveId = Number(userId);
  if (!executiveId) return 0;

  const showCount = await getUserPendingShowCount(executiveId);
  if (!showCount) return 0;

  const roles = await getUserRoles(executiveId);
  const current = await getPendingCountForRole(executiveId, roles, 'withdrawal-executive');
  const need = showCount - current;
  if (need <= 0) return 0;

  const rows = await query(
    `SELECT id
     FROM withdrawals
     WHERE transaction_status = 'Pending'
       AND cashout_payment_proof IS NOT NULL
       AND (assigned_to IS NULL OR assigned_to = 0)
     ORDER BY updated_at ASC
     LIMIT ${need}`,
  );
  if (!rows.length) return 0;

  const ids = rows.map((row) => row.id);
  const placeholders = ids.map(() => '?').join(', ');
  await query(
    `UPDATE withdrawals SET assigned_to = ?, updated_at = NOW() WHERE id IN (${placeholders})`,
    [executiveId, ...ids],
  );
  await touchExecutiveLastAssigned(executiveId);
  return ids.length;
}
