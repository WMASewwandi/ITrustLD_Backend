import { userHasPermission } from '../constants/loyaltyPermissions.js';
import { getUserPermissions } from '../services/user.service.js';

export function requirePermission(...requiredPermissions) {
  return async (req, res, next) => {
    try {
      const permissions = await getUserPermissions(req.auth.userId);
      const hasAccess = requiredPermissions.some((p) => userHasPermission(permissions, p));

      if (!hasAccess) {
        return res.status(403).json({ message: 'You do not have permission to perform this action.' });
      }

      req.auth.permissions = permissions;
      return next();
    } catch (error) {
      return next(error);
    }
  };
}
