import { Router } from 'express';
import fs from 'fs/promises';
import path from 'node:path';
import { env } from '../../config/env.js';
import { getMaintenanceMode } from '../../services/maintenanceMode.service.js';
import {
  guessCountdownBackgroundMimeType,
  resolveCountdownBackgroundPath,
} from '../../services/countdownBackgroundStorage.service.js';

export const publicMaintenanceModeRouter = Router();

publicMaintenanceModeRouter.get('/', async (_req, res, next) => {
  try {
    const maintenanceMode = await getMaintenanceMode();
    res.json({
      ok: true,
      enabled: maintenanceMode.enabled,
      message: maintenanceMode.message,
      serverNow: maintenanceMode.serverNow,
      countdown: maintenanceMode.countdown,
    });
  } catch (error) {
    next(error);
  }
});

publicMaintenanceModeRouter.get('/media/:filename', async (req, res, next) => {
  try {
    const safeName = path.basename(String(req.params.filename || ''));
    let filePath = resolveCountdownBackgroundPath(safeName);
    try {
      await fs.access(filePath);
    } catch {
      filePath = path.resolve(
        env.projectRoot,
        '../ITrustLD_Existing/public/uploads/launch-countdown',
        safeName,
      );
    }
    const buffer = await fs.readFile(filePath);
    res.setHeader('Content-Type', guessCountdownBackgroundMimeType(safeName));
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(buffer);
  } catch (error) {
    if (error.code === 'ENOENT') {
      const notFound = new Error('Background image not found.');
      notFound.status = 404;
      next(notFound);
      return;
    }
    next(error);
  }
});
