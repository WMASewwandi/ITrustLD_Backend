import { Router } from 'express';
import { getMaintenanceMode } from '../../services/maintenanceMode.service.js';

export const publicMaintenanceModeRouter = Router();

publicMaintenanceModeRouter.get('/', async (_req, res, next) => {
  try {
    const maintenanceMode = await getMaintenanceMode();
    res.json({
      ok: true,
      enabled: maintenanceMode.enabled,
      message: maintenanceMode.message,
    });
  } catch (error) {
    next(error);
  }
});
