import { query } from '../config/database.js';
import { sendMail } from './mail.service.js';

const SMS_FOOTER = '\n\nFor more info, please contact us at +94 117 751 751';

export async function sendEmailAndSms({
  email,
  subject,
  html,
  text,
  smsMessage,
  msisdn = null,
  userId = null,
  smsType = 'GENERAL',
}) {
  const mailResult = await sendMail({ to: email, subject, html, text });

  if (smsMessage) {
    const body = `${String(smsMessage).trim()}${SMS_FOOTER}`;
    await sendSms({
      message: body,
      msisdn,
      userId,
      smsType,
    });
  }

  return mailResult;
}

export async function queueSmsMessage({ message, msisdn, userId, smsType }) {
  return sendSms({ message, msisdn, userId, smsType });
}

async function sendSms({ message, msisdn, userId, smsType }) {
  if (!msisdn) return;

  const digits = String(msisdn).replace(/\D/g, '');
  if (!digits) return;

  const number = digits.slice(-9);
  const countryCode = digits.slice(0, -9);

  if (!['0', '94', ''].includes(countryCode) && countryCode !== '94') {
    console.info('[sms:skip] International SMS not configured for', msisdn);
    return;
  }

  try {
    await query(
      `INSERT INTO sms_transactions (user_id, message, sms_type, created_at, updated_at)
       VALUES (?, ?, ?, NOW(), NOW())`,
      [userId, message, smsType],
    );
    console.info('[sms:queued]', { userId, smsType, to: number });
  } catch (error) {
    console.error('[sms:error]', error.message);
  }
}
