import { query } from '../config/database.js';
import { env } from '../config/env.js';

export function parseLkMobileNumber(msisdn) {
  const digits = String(msisdn || '').replace(/\D/g, '');
  if (!digits) return null;

  const number = digits.slice(-9);
  const countryCode = digits.slice(0, -9);

  if (!['0', '94', ''].includes(countryCode) && countryCode !== '94') {
    return null;
  }

  if (number.length !== 9) return null;
  return number;
}

/** Dialog eSMS v2 expects 94 + 9-digit local number, e.g. 94771234567. */
function toEsmsMsisdn(msisdn) {
  const local = parseLkMobileNumber(msisdn);
  return local ? `94${local}` : null;
}

function persistUserId(userId) {
  const id = Number(userId);
  return Number.isFinite(id) && id > 0 ? id : 0;
}

function dialogApiMessage(data, fallback) {
  return data?.comment || data?.message || fallback;
}

/** Dialog requires a unique transaction_id per request (DB ids collide with old Laravel sends). */
function uniqueDialogTransactionId(smsTransactionId) {
  return Date.now() * 1000 + (Number(smsTransactionId) % 1000);
}

async function loadLatestToken() {
  const rows = await query(
    `SELECT token, token_expires_at
     FROM tokens
     ORDER BY created_at DESC
     LIMIT 1`,
  );
  return rows[0] || null;
}

async function storeDialogToken({ token, refreshToken, expirationSec, refreshExpirationSec }) {
  const tokenExpiresAt = new Date(Date.now() + Math.max(60, Number(expirationSec) || 3600) * 1000);
  const refreshExpiresAt = new Date(
    Date.now() + Math.max(60, Number(refreshExpirationSec) || Number(expirationSec) || 3600) * 1000,
  );

  await query(
    `INSERT INTO tokens (token, refresh_token, token_expires_at, refresh_token_expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, NOW(), NOW())`,
    [token, refreshToken || '', tokenExpiresAt, refreshExpiresAt],
  );
}

async function fetchDialogToken() {
  const username = env.sms.username;
  const password = env.sms.password;

  if (!username || !password) {
    throw new Error('Dialog SMS credentials are not configured.');
  }

  const response = await fetch(env.sms.loginUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });

  const data = await response.json().catch(() => ({}));
  const token = data?.token;
  if (String(data?.status || '').toLowerCase() !== 'success' || !token) {
    throw new Error(dialogApiMessage(data, 'Unable to retrieve Dialog SMS token.'));
  }

  try {
    await storeDialogToken({
      token,
      refreshToken: data.refreshToken || data.refresh_token,
      expirationSec: data.expiration,
      refreshExpirationSec: data.refreshExpiration || data.refresh_expiration,
    });
  } catch (error) {
    console.error('[sms:token-store]', error.message);
  }

  return token;
}

async function getDialogToken() {
  try {
    const existing = await loadLatestToken();
    if (existing?.token && existing?.token_expires_at) {
      const expiresAt = new Date(existing.token_expires_at);
      if (!Number.isNaN(expiresAt.getTime()) && expiresAt > new Date()) {
        return existing.token;
      }
    }
  } catch (error) {
    console.error('[sms:token-load]', error.message);
  }

  return fetchDialogToken();
}

async function persistSmsResponse(smsTransactionId, responseData) {
  try {
    await query(`UPDATE sms_transactions SET response = ? WHERE id = ?`, [
      JSON.stringify(responseData),
      smsTransactionId,
    ]);
  } catch {
    // response column may be unavailable in some environments
  }
}

/**
 * Send SMS via Dialog eSMS v2 (https://esms.dialog.lk).
 * Always records sms_transactions; dispatches to Dialog when credentials are configured.
 */
export async function sendDialogSms({
  message,
  msisdn,
  userId = null,
  smsType = 'GENERAL',
  paymentMethod = '0',
}) {
  const mobile = toEsmsMsisdn(msisdn);
  if (!mobile) {
    throw new Error(`Invalid mobile number: ${msisdn || ''}`);
  }

  const insertResult = await query(
    `INSERT INTO sms_transactions (user_id, message, sms_type, created_at, updated_at)
     VALUES (?, ?, ?, NOW(), NOW())`,
    [persistUserId(userId), message, smsType],
  );
  const smsTransactionId = insertResult.insertId;

  if (!env.sms.enabled) {
    console.info('[sms:log-only]', { userId: persistUserId(userId), smsType, to: mobile });
    return { logged: true, id: smsTransactionId };
  }

  try {
    const token = await getDialogToken();
    const response = await fetch(env.sms.sendUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        sourceAddress: env.sms.sourceAddress,
        message,
        transaction_id: uniqueDialogTransactionId(smsTransactionId),
        payment_method: Number(paymentMethod ?? env.sms.paymentMethod) || 0,
        msisdn: [{ mobile }],
      }),
    });

    const responseData = await response.json().catch(() => ({}));
    await persistSmsResponse(smsTransactionId, responseData);
    if (String(responseData?.status || '').toLowerCase() !== 'success') {
      throw new Error(dialogApiMessage(responseData, 'Dialog SMS send failed.'));
    }
    return responseData;
  } catch (error) {
    console.error('[sms:dialog-error]', error.message);
    await persistSmsResponse(smsTransactionId, { error: error.message });
    throw error;
  }
}

export function isInternationalSmsConfigured() {
  return Boolean(env.sms.twilioAccountSid && env.sms.twilioAuthToken && env.sms.twilioFrom);
}

export function toE164(msisdn) {
  const raw = String(msisdn || '').trim();
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (!digits) return null;

  const lkLocal = parseLkMobileNumber(raw);
  if (lkLocal) return `+94${lkLocal}`;

  if (raw.startsWith('+') && digits.length >= 10 && digits.length <= 15) {
    return `+${digits}`;
  }
  if (digits.startsWith('00') && digits.length >= 12 && digits.length <= 17) {
    return `+${digits.slice(2)}`;
  }
  if (digits.length >= 10 && digits.length <= 15) {
    return `+${digits}`;
  }
  return null;
}

export async function sendInternationalSms({
  message,
  msisdn,
  userId = null,
  smsType = 'GENERAL',
}) {
  const e164 = toE164(msisdn);
  if (!e164) return null;
  if (!isInternationalSmsConfigured()) return null;

  const insertResult = await query(
    `INSERT INTO sms_transactions (user_id, message, sms_type, created_at, updated_at)
     VALUES (?, ?, ?, NOW(), NOW())`,
    [persistUserId(userId), message, smsType],
  );
  const smsTransactionId = insertResult.insertId;

  if (env.sms.enabled === false) {
    console.info('[sms:twilio-log-only]', { userId, smsType, to: e164 });
    return { logged: true, id: smsTransactionId };
  }

  try {
    const auth = Buffer.from(`${env.sms.twilioAccountSid}:${env.sms.twilioAuthToken}`).toString(
      'base64',
    );
    const body = new URLSearchParams({
      To: e164,
      From: env.sms.twilioFrom,
      Body: message,
    });
    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${env.sms.twilioAccountSid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
      },
    );
    const responseData = await response.json().catch(() => ({}));
    await persistSmsResponse(smsTransactionId, responseData);
    if (!response.ok) {
      return { error: responseData?.message || 'Twilio SMS failed.', id: smsTransactionId };
    }
    return responseData;
  } catch (error) {
    console.error('[sms:twilio-error]', error.message);
    await persistSmsResponse(smsTransactionId, { error: error.message });
    return { error: error.message, id: smsTransactionId };
  }
}
