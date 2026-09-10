import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { PartnerPayCode } from './partnerPayCodes.js';

function expiredTokenError() {
  const error = new Error('Expired Token — please restart payment from the partner platform.');
  error.status = 401;
  error.code = PartnerPayCode.EXPIRED_TOKEN;
  return error;
}

export function verifyGatewayToken(rawToken) {
  try {
    const payload = jwt.verify(String(rawToken || ''), env.partnerPay.tokenSecret);
    if (!String(payload.typ || '').startsWith('gateway_') || !payload.fields) {
      throw expiredTokenError();
    }
    return payload;
  } catch (error) {
    if (error.code === PartnerPayCode.EXPIRED_TOKEN) throw error;
    throw expiredTokenError();
  }
}

export function partnerCheckoutMeta(rawToken, type, methodId) {
  try {
    const payload = verifyGatewayToken(rawToken);
    const expected = type === 'withdrawal' ? 'gateway_withdrawal' : 'gateway_deposit';
    if (payload.typ !== expected) return { ok: false, returnUrl: '' };
    const fieldId =
      type === 'withdrawal' ? payload.fields?.cashout_method_id : payload.fields?.topup_method_id;
    if (Number(fieldId) !== Number(methodId)) return { ok: false, returnUrl: '' };
    return { ok: true, returnUrl: String(payload.return_url || '').trim() };
  } catch {
    return { ok: false, returnUrl: '' };
  }
}

export function matchesPartnerCheckout(rawToken, type, methodId) {
  return partnerCheckoutMeta(rawToken, type, methodId).ok;
}
