import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { query } from '../config/database.js';
import { getDepositMethodDetails } from './userDeposit.service.js';
import { getWithdrawalMethodDetails } from './userWithdrawal.service.js';

function apiError(message, status = 422, code) {
  const error = new Error(message);
  error.status = status;
  if (code) error.code = code;
  return error;
}

function secretsEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  if (!a.length || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function isLocalDevReturnUrl(url) {
  try {
    const parsed = new URL(url);
    return ['localhost', '127.0.0.1'].includes(parsed.hostname);
  } catch {
    return false;
  }
}

function returnUrlAllowed(url, extraPrefixes = []) {
  const prefixes = [...(env.partnerPay.allowedReturnUrls || []), ...extraPrefixes].filter(Boolean);
  if (prefixes.length) {
    return prefixes.some((prefix) => url === prefix || url.startsWith(prefix));
  }
  return env.nodeEnv !== 'production' && isLocalDevReturnUrl(url);
}

async function findDbPartnerByApiKey(apiKey) {
  const key = String(apiKey || '').trim();
  if (!key) return null;
  try {
    const rows = await query(
      `SELECT id, name, api_key, api_secret, allowed_return_urls, webhook_url, is_active
       FROM partner_pay_integrations
       WHERE api_key = ?
       LIMIT 1`,
      [key],
    );
    const row = rows[0];
    if (!row || Number(row.is_active) === 0) return null;
    return row;
  } catch {
    return null;
  }
}

export async function authenticatePartner(apiKey, apiSecret) {
  const key = String(apiKey || '').trim();
  const secret = String(apiSecret || '').trim();
  if (!key || !secret) {
    throw apiError('Invalid API credentials.', 401, 'LOGIN_FAILURE');
  }

  const dbPartner = await findDbPartnerByApiKey(key);
  if (dbPartner && secretsEqual(dbPartner.api_secret, secret)) {
    return {
      id: dbPartner.id,
      name: dbPartner.name,
      apiKey: dbPartner.api_key,
      apiSecret: dbPartner.api_secret,
      allowedReturnUrls: String(dbPartner.allowed_return_urls || '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
      webhookUrl: dbPartner.webhook_url || null,
    };
  }

  if (
    env.partnerPay.apiKey &&
    secretsEqual(env.partnerPay.apiKey, key) &&
    secretsEqual(env.partnerPay.apiSecret, secret)
  ) {
    return {
      id: null,
      name: env.partnerPay.name,
      apiKey: env.partnerPay.apiKey,
      apiSecret: env.partnerPay.apiSecret,
      allowedReturnUrls: env.partnerPay.allowedReturnUrls,
      webhookUrl: null,
    };
  }

  throw apiError('Invalid API credentials.', 401, 'LOGIN_FAILURE');
}

function requiredNumber(value, label) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw apiError(`${label} is required.`);
  return n;
}

function requiredInt(value, label) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw apiError(`${label} is required.`);
  return n;
}

function requiredText(value, label) {
  const text = String(value || '').trim();
  if (!text) throw apiError(`${label} is required.`);
  return text;
}

function platformIdFrom(payload, labels) {
  return requiredText(
    payload.topup_account_id ?? payload.cashout_account_id ?? payload.platform_id ?? payload.plat_id,
    labels,
  );
}

function assertAmountInRange(amount, minLimit, maxLimit, kindLabel) {
  const min = Number(minLimit);
  const max = Number(maxLimit);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return;
  if (amount < min || amount > max) {
    throw apiError(`${kindLabel} amount must be between USD ${min} and USD ${max}.`);
  }
}

async function assertGatewayAmountLimits(type, fields) {
  if (type === 'deposit') {
    const rows = await query(
      `SELECT topup_method_name, minimum_limit, maximum_limit
       FROM topup_methods
       WHERE id = ?
         AND UPPER(availability) = 'AVAILABLE'
         AND (is_deleted = 0 OR is_deleted IS NULL)
       LIMIT 1`,
      [fields.topup_method_id],
    );
    if (!rows[0]) throw apiError('Selected top-up method is not available.');
    assertAmountInRange(fields.deposit_amount, rows[0].minimum_limit, rows[0].maximum_limit, 'Deposit');
    return;
  }

  const rows = await query(
    `SELECT cashout_method_name, minimum_limit, maximum_limit
     FROM cashout_methods
     WHERE id = ?
       AND UPPER(availability) = 'AVAILABLE'
       AND (is_deleted = 0 OR is_deleted IS NULL)
     LIMIT 1`,
    [fields.cashout_method_id],
  );
  if (!rows[0]) throw apiError('Selected cash-out method is not available.');
  assertAmountInRange(fields.cashout_amount, rows[0].minimum_limit, rows[0].maximum_limit, 'Cash-out');
}

function buildDepositFields(payload = {}) {
  return {
    topup_method_id: requiredInt(payload.topup_method_id, 'topup_method_id'),
    topup_account_id: platformIdFrom(payload, 'platform_id'),
    deposit_amount: requiredNumber(payload.deposit_amount ?? payload.amount, 'amount'),
    deposit_amount_currency: 'USD',
    currency: String(payload.currency || payload.deposit_amount_currency || 'USD').trim() || 'USD',
  };
}

function buildWithdrawalFields(payload = {}) {
  return {
    cashout_method_id: requiredInt(payload.cashout_method_id, 'cashout_method_id'),
    cashout_account_id: platformIdFrom(payload, 'platform_id'),
    cashout_amount: requiredNumber(payload.cashout_amount ?? payload.amount, 'amount'),
    cashout_amount_currency: 'USD',
    currency: String(payload.currency || payload.cashout_amount_currency || 'USD').trim() || 'USD',
  };
}

export async function createGatewayCheckout(partner, kind, payload = {}) {
  const type = String(kind || '').toLowerCase() === 'withdrawal' ? 'withdrawal' : 'deposit';
  const returnUrl = requiredText(payload.return_url, 'return_url');
  if (!returnUrlAllowed(returnUrl, partner.allowedReturnUrls)) {
    throw apiError('return_url is not on the partner allowlist.');
  }

  const fields = type === 'deposit' ? buildDepositFields(payload) : buildWithdrawalFields(payload);
  await assertGatewayAmountLimits(type, fields);
  const ttl = Math.min(
    Math.max(Number(payload.expires_in_seconds || env.partnerPay.tokenTtlSeconds) || 900, 60),
    3600,
  );
  const jti = crypto.randomBytes(16).toString('hex');
  const token = jwt.sign(
    {
      typ: `gateway_${type}`,
      jti,
      pid: partner.id || 0,
      return_url: returnUrl,
      fields,
    },
    env.partnerPay.tokenSecret,
    { expiresIn: ttl },
  );

  const path =
    type === 'deposit'
      ? `/dashboard/deposit?gateway=${encodeURIComponent(token)}`
      : `/dashboard/withdrawal?gateway=${encodeURIComponent(token)}`;

  return {
    ok: true,
    type,
    token,
    expires_in: ttl,
    checkout_url: `${env.userAppUrl}${path}`,
    login_url: `${env.userAppUrl}/login?redirect=${encodeURIComponent(path)}`,
  };
}

function verifyGatewayToken(rawToken) {
  try {
    const payload = jwt.verify(String(rawToken || ''), env.partnerPay.tokenSecret);
    if (!String(payload.typ || '').startsWith('gateway_') || !payload.fields) {
      throw apiError('Expired Token — please restart payment from the partner platform.', 401, 'EXPIRED_TOKEN');
    }
    return payload;
  } catch (error) {
    if (error.code === 'EXPIRED_TOKEN') throw error;
    throw apiError('Expired Token — please restart payment from the partner platform.', 401, 'EXPIRED_TOKEN');
  }
}

export async function claimGatewayCheckout(userId, rawToken) {
  const payload = verifyGatewayToken(rawToken);
  const type = payload.typ === 'gateway_withdrawal' ? 'withdrawal' : 'deposit';
  const fields = payload.fields || {};
  await assertGatewayAmountLimits(type, fields);

  if (type === 'deposit') {
    await getDepositMethodDetails(userId, {
      topupMethodId: fields.topup_method_id,
      depositAmount: fields.deposit_amount,
      depositAmountCurrency: fields.deposit_amount_currency || 'USD',
    });
    return {
      ok: true,
      type: 'deposit',
      return_url: payload.return_url,
      fields,
    };
  }

  await getWithdrawalMethodDetails(userId, {
    cashoutMethodId: fields.cashout_method_id,
    cashoutAmount: fields.cashout_amount,
    cashoutAmountCurrency: fields.cashout_amount_currency || 'USD',
  });
  return {
    ok: true,
    type: 'withdrawal',
    return_url: payload.return_url,
    fields,
  };
}

export async function getGatewayTransactionStatus(type, transactionId) {
  const id = String(transactionId || '').trim();
  if (!id) throw apiError('Transaction id is required.');
  if (type === 'withdrawal') {
    const rows = await query(
      `SELECT transaction_id, transaction_status, cashout_amount, cashout_amount_currency,
              receiving_amount, receiving_amount_currency
       FROM withdrawals
       WHERE transaction_id = ?
       LIMIT 1`,
      [id],
    );
    if (!rows[0]) throw apiError('Payment not found.', 404);
    const row = rows[0];
    return {
      ok: true,
      type: 'withdrawal',
      reference_id: row.transaction_id,
      status: row.transaction_status,
      amount: Number(row.cashout_amount).toFixed(2),
      currency: row.cashout_amount_currency,
      receiving_amount: Number(row.receiving_amount).toFixed(2),
      receiving_currency: row.receiving_amount_currency,
    };
  }

  const rows = await query(
    `SELECT transaction_id, transaction_status, deposit_amount, deposit_amount_currency,
            payment_amount, payment_amount_currency
     FROM deposits
     WHERE transaction_id = ?
     LIMIT 1`,
    [id],
  );
  if (!rows[0]) throw apiError('Payment not found.', 404);
  const row = rows[0];
  return {
    ok: true,
    type: 'deposit',
    reference_id: row.transaction_id,
    status: row.transaction_status,
    amount: Number(row.deposit_amount).toFixed(2),
    currency: row.deposit_amount_currency,
    payment_amount: Number(row.payment_amount).toFixed(2),
    payment_currency: row.payment_amount_currency,
  };
}

export async function listGatewayCatalog() {
  const [topupMethods, cashoutMethods, depositRates, withdrawalRates] = await Promise.all([
    query(
      `SELECT id, topup_method_name AS name, minimum_limit, maximum_limit
       FROM topup_methods
       WHERE UPPER(availability) = 'AVAILABLE'
         AND (is_deleted = 0 OR is_deleted IS NULL)
       ORDER BY id ASC`,
    ),
    query(
      `SELECT id, cashout_method_name AS name, minimum_limit, maximum_limit
       FROM cashout_methods
       WHERE UPPER(availability) = 'AVAILABLE'
         AND (is_deleted = 0 OR is_deleted IS NULL)
       ORDER BY id ASC`,
    ),
    query(
      `SELECT dr.id, dr.topup_method_id, dr.payment_option_id, dr.rate,
              po.payment_option_name, po.payment_option_currency
       FROM deposit_rates dr
       INNER JOIN payment_options po ON po.id = dr.payment_option_id
       WHERE (dr.is_deleted = 0 OR dr.is_deleted IS NULL)
         AND UPPER(po.availability) = 'AVAILABLE'
         AND (po.is_deleted = 0 OR po.is_deleted IS NULL)
       ORDER BY dr.id DESC`,
    ),
    query(
      `SELECT wr.id, wr.cashout_method_id, wr.payment_option_id, wr.rate,
              po.payment_option_name, po.payment_option_currency
       FROM withdrawal_rates wr
       INNER JOIN payment_options po ON po.id = wr.payment_option_id
       WHERE (wr.is_deleted = 0 OR wr.is_deleted IS NULL)
         AND UPPER(po.availability) = 'AVAILABLE'
         AND (po.is_deleted = 0 OR po.is_deleted IS NULL)
       ORDER BY wr.id DESC`,
    ),
  ]);

  const latestDeposit = [];
  const seenDeposit = new Set();
  for (const row of depositRates) {
    const key = `${row.topup_method_id}:${row.payment_option_id}`;
    if (seenDeposit.has(key)) continue;
    seenDeposit.add(key);
    latestDeposit.push(row);
  }

  const latestWithdrawal = [];
  const seenWithdrawal = new Set();
  for (const row of withdrawalRates) {
    const key = `${row.cashout_method_id}:${row.payment_option_id}`;
    if (seenWithdrawal.has(key)) continue;
    seenWithdrawal.add(key);
    latestWithdrawal.push(row);
  }

  return {
    ok: true,
    topup_methods: topupMethods,
    cashout_methods: cashoutMethods,
    deposit_rates: latestDeposit,
    withdrawal_rates: latestWithdrawal,
  };
}
