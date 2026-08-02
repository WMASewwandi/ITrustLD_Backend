import { Router } from 'express';
import { requireAdminAuth } from '../../middleware/requireAdminAuth.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import {
  getMaintenanceMode,
  updateMaintenanceMode,
} from '../../services/maintenanceMode.service.js';

export const adminMaintenanceModeRouter = Router();

adminMaintenanceModeRouter.use(requireAdminAuth);

adminMaintenanceModeRouter.get(
  '/',
  requirePermission('manage_blog_posts'),
  async (_req, res, next) => {
    try {
      const maintenanceMode = await getMaintenanceMode();
      res.json({ ok: true, maintenanceMode });
    } catch (error) {
      next(error);
    }
  },
);

adminMaintenanceModeRouter.post(
  '/',
  requirePermission('manage_blog_posts'),
  async (req, res, next) => {
    try {
      const maintenanceMode = await updateMaintenanceMode(req.auth.userId, req.body);
      res.json({ ok: true, maintenanceMode });
    } catch (error) {
      next(error);
    }
  },
);
