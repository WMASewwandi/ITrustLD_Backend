import { query } from '../config/database.js';
import {
  findBestExecutive,
  findExecutiveAmongCandidates,
  getPendingCountForRole,
  touchExecutiveLastAssigned,
} from './shiftAssignment.service.js';
import { notifyAssignedSystemUser } from './assignedUserNotify.service.js';
import { getUserPendingShowCount } from './systemUser.service.js';
import { getUserRoles } from './user.service.js';

export async function autoAssignDeposit(deposit) {
  if (!deposit?.id) return null;

  const platformId = String(deposit.topup_account_id || '').trim();
  let executive = null;

  if (platformId) {
    const rows = await query(
      `SELECT DISTINCT assigned_to
       FROM deposits
       WHERE topup_account_id = ?
         AND transaction_status = 'Pending'
         AND payment_proof IS NOT NULL
         AND assigned_to IS NOT NULL`,
      [platformId],
    );
    const preferredIds = rows.map((row) => row.assigned_to).filter(Boolean);
    executive = await findExecutiveAmongCandidates('deposit-executive', preferredIds);
  }

  if (!executive) {
    executive = await findBestExecutive('deposit-executive');
  }

  if (!executive) return null;

  await query(
    `UPDATE deposits
     SET assigned_to = ?, updated_at = NOW()
     WHERE id = ?`,
    [executive.id, deposit.id],
  );

  await touchExecutiveLastAssigned(executive.id);

  const transactionId = deposit.transaction_id || deposit.id;
  await notifyAssignedSystemUser({
    userId: executive.id,
    message: `Pending deposit request has been assigned to you: ${transactionId}. Please review. Thanks`,
    smsType: 'DEPOSIT_PENDING',
  }).catch((error) => {
    console.error('[deposit:assigned-sms]', error.message);
  });

  return executive.id;
}

/**
 * After approve/reject, top up an executive's assigned pending deposits
 * up to their optional pending_show_count (no-op if unset or already full).
 */
export async function refillDepositPendingForExecutive(userId) {
  const executiveId = Number(userId);
  if (!executiveId) return 0;

  const showCount = await getUserPendingShowCount(executiveId);
  if (!showCount) return 0;

  const roles = await getUserRoles(executiveId);
  const current = await getPendingCountForRole(executiveId, roles, 'deposit-executive');
  const need = showCount - current;
  if (need <= 0) return 0;

  const rows = await query(
    `SELECT id
     FROM deposits
     WHERE transaction_status = 'Pending'
       AND payment_proof IS NOT NULL
       AND (assigned_to IS NULL OR assigned_to = 0)
     ORDER BY updated_at ASC
     LIMIT ${need}`,
  );
  if (!rows.length) return 0;

  const ids = rows.map((row) => row.id);
  const placeholders = ids.map(() => '?').join(', ');
  await query(`UPDATE deposits SET assigned_to = ?, updated_at = NOW() WHERE id IN (${placeholders})`, [
    executiveId,
    ...ids,
  ]);
  await touchExecutiveLastAssigned(executiveId);

  await notifyAssignedSystemUser({
    userId: executiveId,
    message: `${ids.length} pending deposit request(s) have been assigned to you. Please review. Thanks`,
    smsType: 'DEPOSIT_PENDING',
  }).catch((error) => {
    console.error('[deposit:assigned-sms]', error.message);
  });

  return ids.length;
}
