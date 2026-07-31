import { Router } from 'express';
import { requireUserAuth } from '../../middleware/requireUserAuth.js';
import { getUserDashboard } from '../../services/dashboard.service.js';

export const userDashboardRouter = Router();

userDashboardRouter.use(requireUserAuth);

userDashboardRouter.get('/', async (req, res, next) => {
  try {
    const dashboard = await getUserDashboard(req.auth.userId);
    res.json(dashboard);
  } catch (error) {
    next(error);
  }
});
