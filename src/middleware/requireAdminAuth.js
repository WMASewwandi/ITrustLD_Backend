import { verifyAccessToken } from '../services/adminAuth.service.js';
import { findUserById } from '../services/user.service.js';
import { isShiftManagedRole } from '../services/shiftAssignment.service.js';

export async function requireAdminAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ message: 'Unauthenticated.' });
  }

  try {
    const payload = verifyAccessToken(token);
    const roles = payload.roles || [];
    req.auth = {
      userId: payload.sub,
      email: payload.email,
      roles,
    };

    if (isShiftManagedRole(roles)) {
      const user = await findUserById(payload.sub);
      if (user && !user.is_online) {
        return res.status(401).json({
          message: 'Your shift has ended. Please log in again for the next shift.',
        });
      }
    }

    return next();
  } catch {
    return res.status(401).json({ message: 'Invalid or expired token.' });
  }
}
