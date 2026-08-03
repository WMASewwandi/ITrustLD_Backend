import { verifyAccessToken } from '../services/adminAuth.service.js';

export function optionalUserAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    req.auth = null;
    return next();
  }

  try {
    const payload = verifyAccessToken(token);
    req.auth = {
      userId: payload.sub,
      email: payload.email,
      roles: payload.roles || [],
    };
  } catch {
    req.auth = null;
  }

  return next();
}
