import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { query } from '../config/database.js';
import { getDepositMethodDetails } from './userDeposit.service.js';
import { getWithdrawalMethodDetails } from './userWithdrawal.service.js';
import { verifyGatewayToken } from '../utils/partnerPayToken.js';
import { PartnerPayCode } from '../utils/partnerPayCodes.js';
import { findAccountHolderByEmail, findAccountHolderByUserId } from './accountHolder.service.js';
import { findUserByEmail, findUserById } from './user.service.js';
import { ensureWalletGuidSchema } from './wallet.service.js';

function apiError(message, status = 422, code = PartnerPayCode.VALIDATION_ERROR) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function secretsEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  if (!a.length || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function requiredHttpUrl(value, label) {
  const text = String(value || '').trim();
  if (!text) throw apiError(`${label} is required.`, 422, PartnerPayCode.RETURN_URL_REQUIRED);
  try {
    const parsed = new URL(text);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('invalid');
    }
  } catch {
    throw apiError(`${label} must be a valid http or https URL.`, 422, PartnerPayCode.RETURN_URL_INVALID);
  }
  return text;
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
    throw apiError('Invalid API credentials.', 401, PartnerPayCode.LOGIN_FAILURE);
  }

  const dbPartner = await findDbPartnerByApiKey(key);
  if (dbPartner && secretsEqual(dbPartner.api_secret, secret)) {
    return {
      id: dbPartner.id,
      name: dbPartner.name,
      apiKey: dbPartner.api_key,
      apiSecret: dbPartner.api_secret,
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
      webhookUrl: null,
    };
  }

  throw apiError('Invalid API credentials.', 401, PartnerPayCode.LOGIN_FAILURE);
}

function requiredNumber(value, label, code = PartnerPayCode.AMOUNT_REQUIRED) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw apiError(`${label} is required.`, 422, code);
  return n;
}

function isMethodGuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || '').trim(),
  );
}

async function resolveMethodIdFromGuid(kind, payload) {
  await ensureWalletGuidSchema();
  const isDeposit = kind === 'deposit';
  const guid = String(
    (isDeposit
      ? payload.topup_method_guid ?? payload.topup_method_id
      : payload.cashout_method_guid ?? payload.cashout_method_id) || '',
  ).trim();
  const missingCode = isDeposit
    ? PartnerPayCode.TOPUP_METHOD_ID_REQUIRED
    : PartnerPayCode.CASHOUT_METHOD_ID_REQUIRED;
  if (!isMethodGuid(guid)) {
    throw apiError(
      isDeposit ? 'topup_method_guid is required.' : 'cashout_method_guid is required.',
      422,
      missingCode,
    );
  }
  const table = isDeposit ? 'topup_methods' : 'cashout_methods';
  const rows = await query(`SELECT id FROM ${table} WHERE guid = ? LIMIT 1`, [guid]);
  if (!rows[0]) throw apiError('Selected method is not available.', 422, PartnerPayCode.METHOD_UNAVAILABLE);
  return Number(rows[0].id);
}

function requiredText(value, label, code = PartnerPayCode.PLATFORM_ID_REQUIRED) {
  const text = String(value || '').trim();
  if (!text) throw apiError(`${label} is required.`, 422, code);
  return text;
}

function platformIdFrom(payload, labels) {
  return requiredText(
    payload.topup_account_id ?? payload.cashout_account_id ?? payload.platform_id ?? payload.plat_id,
    labels,
    PartnerPayCode.PLATFORM_ID_REQUIRED,
  );
}

function assertAmountInRange(amount, minLimit, maxLimit, kindLabel) {
  const min = Number(minLimit);
  const max = Number(maxLimit);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return;
  if (amount < min || amount > max) {
    throw apiError(
      `${kindLabel} amount must be between USD ${min} and USD ${max}.`,
      422,
      PartnerPayCode.AMOUNT_OUT_OF_RANGE,
    );
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
    if (!rows[0]) throw apiError('Selected top-up method is not available.', 422, PartnerPayCode.METHOD_UNAVAILABLE);
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
  if (!rows[0]) throw apiError('Selected cash-out method is not available.', 422, PartnerPayCode.METHOD_UNAVAILABLE);
  assertAmountInRange(fields.cashout_amount, rows[0].minimum_limit, rows[0].maximum_limit, 'Cash-out');
}

async function buildDepositFields(payload = {}) {
  return {
    topup_method_id: await resolveMethodIdFromGuid('deposit', payload),
    topup_account_id: platformIdFrom(payload, 'platform_id'),
    deposit_amount: requiredNumber(payload.deposit_amount ?? payload.amount, 'amount', PartnerPayCode.AMOUNT_REQUIRED),
    deposit_amount_currency: 'USD',
    currency: String(payload.currency || payload.deposit_amount_currency || 'USD').trim() || 'USD',
  };
}

async function buildWithdrawalFields(payload = {}) {
  return {
    cashout_method_id: await resolveMethodIdFromGuid('withdrawal', payload),
    cashout_account_id: platformIdFrom(payload, 'platform_id'),
    cashout_amount: requiredNumber(payload.cashout_amount ?? payload.amount, 'amount', PartnerPayCode.AMOUNT_REQUIRED),
    cashout_amount_currency: 'USD',
    currency: String(payload.currency || payload.cashout_amount_currency || 'USD').trim() || 'USD',
  };
}

function requiredEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (!email) throw apiError('A valid email is required.', 422, PartnerPayCode.EMAIL_REQUIRED);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw apiError('A valid email is required.', 422, PartnerPayCode.EMAIL_INVALID);
  }
  return email;
}

async function assertRegisteredEmail(email) {
  const user = await findUserByEmail(email);
  const holder = await findAccountHolderByEmail(email);
  if (!user && !holder) {
    throw apiError('No iTrustLD account found for this email.', 422, PartnerPayCode.NO_ACCOUNT);
  }
}

async function assertCheckoutEmailMatchesUser(userId, checkoutEmail) {
  const expected = String(checkoutEmail || '').trim().toLowerCase();
  if (!expected) return;
  const [holder, user] = await Promise.all([
    findAccountHolderByUserId(userId),
    findUserById(userId),
  ]);
  const actual = String(holder?.email || user?.email || '')
    .trim()
    .toLowerCase();
  if (actual !== expected) {
    throw apiError('This checkout is for a different iTrustLD account.', 403, PartnerPayCode.EMAIL_MISMATCH);
  }
}

function continuePath(type, token) {
  const encoded = encodeURIComponent(token);
  return type === 'withdrawal'
    ? `/dashboard/withdrawal?gateway=${encoded}`
    : `/dashboard/deposit?gateway=${encoded}`;
}

export async function createGatewayCheckout(partner, kind, payload = {}) {
  const type = String(kind || '').toLowerCase() === 'withdrawal' ? 'withdrawal' : 'deposit';
  const returnUrl = requiredHttpUrl(payload.return_url, 'return_url');
  const email = requiredEmail(payload.email);
  await assertRegisteredEmail(email);

  const fields = type === 'deposit' ? await buildDepositFields(payload) : await buildWithdrawalFields(payload);
  fields.email = email;
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

  const entryPath = `/partner-pay?gateway=${encodeURIComponent(token)}`;

  return {
    ok: true,
    type,
    token,
    expires_in: ttl,
    checkout_url: `${env.userAppUrl}${entryPath}`,
    login_url: `${env.userAppUrl}${entryPath}`,
  };
}

export async function previewGatewayCheckout(rawToken) {
  const payload = verifyGatewayToken(rawToken);
  const type = payload.typ === 'gateway_withdrawal' ? 'withdrawal' : 'deposit';
  const email = String(payload.fields?.email || '').trim().toLowerCase();
  const path = continuePath(type, rawToken);

  if (!email) {
    return { ok: true, has_account: true, type, continue_path: path };
  }

  const user = await findUserByEmail(email);
  const holder = await findAccountHolderByEmail(email);
  if (!user && !holder) {
    return {
      ok: false,
      has_account: false,
      type,
      code: PartnerPayCode.NO_ACCOUNT,
      message: 'No iTrustLD account found for this email.',
    };
  }

  return { ok: true, has_account: true, type, continue_path: path, email };
}

export async function claimGatewayCheckout(userId, rawToken) {
  const payload = verifyGatewayToken(rawToken);
  const type = payload.typ === 'gateway_withdrawal' ? 'withdrawal' : 'deposit';
  const fields = payload.fields || {};
  await assertCheckoutEmailMatchesUser(userId, fields.email);
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
  if (!id) throw apiError('Transaction id is required.', 422, PartnerPayCode.TRANSACTION_ID_REQUIRED);
  if (type === 'withdrawal') {
    const rows = await query(
      `SELECT transaction_id, transaction_status, cashout_amount, cashout_amount_currency,
              receiving_amount, receiving_amount_currency
       FROM withdrawals
       WHERE transaction_id = ?
       LIMIT 1`,
      [id],
    );
    if (!rows[0]) throw apiError('Payment not found.', 404, PartnerPayCode.PAYMENT_NOT_FOUND);
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
  if (!rows[0]) throw apiError('Payment not found.', 404, PartnerPayCode.PAYMENT_NOT_FOUND);
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
  await ensureWalletGuidSchema();
  const [topupMethods, cashoutMethods, depositRates, withdrawalRates] = await Promise.all([
    query(
      `SELECT guid, topup_method_name AS name, minimum_limit, maximum_limit
       FROM topup_methods
       WHERE UPPER(availability) = 'AVAILABLE'
         AND (is_deleted = 0 OR is_deleted IS NULL)
       ORDER BY id ASC`,
    ),
    query(
      `SELECT guid, cashout_method_name AS name, minimum_limit, maximum_limit
       FROM cashout_methods
       WHERE UPPER(availability) = 'AVAILABLE'
         AND (is_deleted = 0 OR is_deleted IS NULL)
       ORDER BY id ASC`,
    ),
    query(
      `SELECT dr.id, tm.guid AS topup_method_guid, dr.payment_option_id, dr.rate,
              po.payment_option_name, po.payment_option_currency
       FROM deposit_rates dr
       INNER JOIN topup_methods tm ON tm.id = dr.topup_method_id
       INNER JOIN payment_options po ON po.id = dr.payment_option_id
       WHERE (dr.is_deleted = 0 OR dr.is_deleted IS NULL)
         AND UPPER(po.availability) = 'AVAILABLE'
         AND (po.is_deleted = 0 OR po.is_deleted IS NULL)
       ORDER BY dr.id DESC`,
    ),
    query(
      `SELECT wr.id, cm.guid AS cashout_method_guid, wr.payment_option_id, wr.rate,
              po.payment_option_name, po.payment_option_currency
       FROM withdrawal_rates wr
       INNER JOIN cashout_methods cm ON cm.id = wr.cashout_method_id
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
    const key = `${row.topup_method_guid}:${row.payment_option_id}`;
    if (seenDeposit.has(key)) continue;
    seenDeposit.add(key);
    latestDeposit.push(row);
  }

  const latestWithdrawal = [];
  const seenWithdrawal = new Set();
  for (const row of withdrawalRates) {
    const key = `${row.cashout_method_guid}:${row.payment_option_id}`;
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
