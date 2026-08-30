import { Router } from 'express';
import { requireUserAuth } from '../../middleware/requireUserAuth.js';
import { getUserDashboard, getUserNotifications } from '../../services/dashboard.service.js';

export const userDashboardRouter = Router();

userDashboardRouter.use(requireUserAuth);

function noStore(res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
}

userDashboardRouter.get('/notifications', async (req, res, next) => {
  try {
    noStore(res);
    const payload = await getUserNotifications(req.auth.userId);
    res.json(payload);
  } catch (error) {
    next(error);
  }
});

userDashboardRouter.get('/', async (req, res, next) => {
  try {
    noStore(res);
    const dashboard = await getUserDashboard(req.auth.userId);
    res.json(dashboard);
  } catch (error) {
    next(error);
  }
});
