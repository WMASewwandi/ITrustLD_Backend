import { query } from '../config/database.js';
import {
  findBestExecutive,
  findExecutiveAmongCandidates,
  touchExecutiveLastAssigned,
} from './shiftAssignment.service.js';

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

  return executive.id;
}
