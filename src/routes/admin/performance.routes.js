import { Router } from 'express';
import { requireAdminAuth } from '../../middleware/requireAdminAuth.js';
import {
  canViewTeamPerformance,
  getMyPerformance,
  getTeamPerformance,
} from '../../services/adminPerformance.service.js';
import { findSystemUserById } from '../../services/systemUser.service.js';
import { getUserPermissions } from '../../services/user.service.js';

export const adminPerformanceRouter = Router();

adminPerformanceRouter.use(requireAdminAuth);

adminPerformanceRouter.get('/me', async (req, res, next) => {
  try {
    const user = await findSystemUserById(req.auth.userId);
    const data = await getMyPerformance(req.auth.userId, req.query.period, {
      name: user?.name,
      email: user?.email,
    });
    res.json({ ok: true, ...data });
  } catch (error) {
    next(error);
  }
});

adminPerformanceRouter.get('/team', async (req, res, next) => {
  try {
    const permissions = await getUserPermissions(req.auth.userId);
    if (!canViewTeamPerformance(req.auth.roles, permissions)) {
      return res.status(403).json({ message: 'You do not have permission to view team performance.' });
    }
    const data = await getTeamPerformance(req.query.period);
    res.json({ ok: true, ...data });
  } catch (error) {
    next(error);
  }
});
