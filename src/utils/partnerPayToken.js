import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

function expiredTokenError() {
  const error = new Error('Expired Token — please restart payment from the partner platform.');
  error.status = 401;
  error.code = 'EXPIRED_TOKEN';
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
    if (error.code === 'EXPIRED_TOKEN') throw error;
    throw expiredTokenError();
  }
}

export function matchesPartnerCheckout(rawToken, type, methodId) {
  try {
    const payload = verifyGatewayToken(rawToken);
    const expected = type === 'withdrawal' ? 'gateway_withdrawal' : 'gateway_deposit';
    if (payload.typ !== expected) return false;
    const fieldId =
      type === 'withdrawal' ? payload.fields?.cashout_method_id : payload.fields?.topup_method_id;
    return Number(fieldId) === Number(methodId);
  } catch {
    return false;
  }
}
