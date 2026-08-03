import { query } from '../config/database.js';
import {
  findBestExecutive,
  findExecutiveAmongCandidates,
  touchExecutiveLastAssigned,
} from './shiftAssignment.service.js';

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
