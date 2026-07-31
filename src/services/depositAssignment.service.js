import { query } from '../config/database.js';
import { getExecutivesForAssignment } from './deposit-actions.service.js';

export async function autoAssignDeposit(deposit) {
  if (!deposit?.id) return null;

  const platformId = String(deposit.topup_account_id || '').trim();
  let executiveId = null;

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
    const preferredIds = new Set(rows.map((row) => row.assigned_to).filter(Boolean));
    if (preferredIds.size > 0) {
      const { executives } = await getExecutivesForAssignment();
      const match = executives.find((exec) => preferredIds.has(exec.id));
      if (match) executiveId = match.id;
    }
  }

  if (!executiveId) {
    const { executives } = await getExecutivesForAssignment();
    executiveId = executives[0]?.id ?? null;
  }

  if (!executiveId) return null;

  await query(
    `UPDATE deposits
     SET assigned_to = ?, updated_at = NOW()
     WHERE id = ?`,
    [executiveId, deposit.id],
  );

  await query(`UPDATE users SET last_assigned_at = NOW(), updated_at = NOW() WHERE id = ?`, [
    executiveId,
  ]);

  return executiveId;
}
