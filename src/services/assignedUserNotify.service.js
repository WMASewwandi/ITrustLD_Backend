import { query } from '../config/database.js';
import { columnExists } from '../db/helpers.js';
import { queueSmsMessage } from './notification.service.js';

async function getSystemUserMobile(userId) {
  const id = Number(userId);
  if (!id) return null;
  if (!(await columnExists('users', 'mobile_number'))) return null;

  const rows = await query(`SELECT mobile_number FROM users WHERE id = ? LIMIT 1`, [id]);
  const mobile = String(rows[0]?.mobile_number || '').trim();
  return mobile || null;
}

/**
 * SMS the assigned system user using users.mobile_number (not hardcoded staff lists).
 * Skips silently if the user has no mobile number on file.
 */
export async function notifyAssignedSystemUser({
  userId,
  message,
  smsType = 'ASSIGNMENT',
}) {
  const mobile = await getSystemUserMobile(userId);
  if (!mobile) {
    console.info('[sms:skip] Assigned system user has no mobile_number', { userId });
    return false;
  }

  await queueSmsMessage({
    message,
    msisdn: mobile,
    userId,
    smsType,
  });
  return true;
}
