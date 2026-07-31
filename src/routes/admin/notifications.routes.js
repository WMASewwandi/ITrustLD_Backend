import { Router } from 'express';
import { requireAdminAuth } from '../../middleware/requireAdminAuth.js';
import { getAdminNavCounts } from '../../services/adminNotification.service.js';

export const adminNotificationsRouter = Router();

adminNotificationsRouter.use(requireAdminAuth);

adminNotificationsRouter.get('/counts', async (req, res, next) => {
  try {
    const counts = await getAdminNavCounts(req.auth.roles, req.auth.userId);
    res.json({ ok: true, counts });
  } catch (error) {
    next(error);
  }
});
