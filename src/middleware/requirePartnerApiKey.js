import { authenticatePartner } from '../services/partnerPay.service.js';

export async function requirePartnerApiKey(req, res, next) {
  const apiKey =
    req.headers['x-api-key'] ||
    req.headers['x-itrustld-api-key'] ||
    (String(req.headers.authorization || '').startsWith('Bearer ')
      ? String(req.headers.authorization).slice(7).trim()
      : '');
  const apiSecret = req.headers['x-api-secret'] || req.headers['x-itrustld-api-secret'] || '';

  try {
    req.partner = await authenticatePartner(apiKey, apiSecret);
    return next();
  } catch (error) {
    return next(error);
  }
}
