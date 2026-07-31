import { Router } from 'express';
import { requireAdminAuth } from '../../middleware/requireAdminAuth.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import {
  getUserCountDisplay,
  updateUserCountBase,
} from '../../services/userCountDisplay.service.js';

export const adminUserCountDisplayRouter = Router();

adminUserCountDisplayRouter.use(requireAdminAuth);

adminUserCountDisplayRouter.get(
  '/',
  requirePermission('view_account_configs'),
  async (_req, res, next) => {
    try {
      const userCount = await getUserCountDisplay();
      res.json({ ok: true, userCount });
    } catch (error) {
      next(error);
    }
  },
);

adminUserCountDisplayRouter.post(
  '/base-count',
  requirePermission('change_account_configs'),
  async (req, res, next) => {
    try {
      const userCount = await updateUserCountBase(req.auth.userId, req.body?.baseCount);
      res.json({ ok: true, userCount });
    } catch (error) {
      next(error);
    }
  },
);
