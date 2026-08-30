import { Router } from 'express';
import fs from 'fs/promises';
import multer from 'multer';
import path from 'node:path';
import { env } from '../../config/env.js';
import { requireAdminAuth } from '../../middleware/requireAdminAuth.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import {
  getMaintenanceMode,
  updateMaintenanceMode,
} from '../../services/maintenanceMode.service.js';
import {
  COUNTDOWN_BACKGROUND_MAX_BYTES,
  guessCountdownBackgroundMimeType,
  resolveCountdownBackgroundPath,
} from '../../services/countdownBackgroundStorage.service.js';

export const adminMaintenanceModeRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: COUNTDOWN_BACKGROUND_MAX_BYTES },
});

function optionalBackgroundUpload(req, res, next) {
  const contentType = String(req.headers['content-type'] || '');
  if (!contentType.includes('multipart/form-data')) {
    next();
    return;
  }
  upload.single('background')(req, res, (error) => {
    if (!error) {
      next();
      return;
    }
    if (error instanceof multer.MulterError) {
      const limitError = new Error(
        error.code === 'LIMIT_FILE_SIZE'
          ? 'Background image must not exceed 8MB.'
          : error.message,
      );
      limitError.status = 422;
      next(limitError);
      return;
    }
    next(error);
  });
}

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
  optionalBackgroundUpload,
  async (req, res, next) => {
    try {
      const maintenanceMode = await updateMaintenanceMode(
        req.auth.userId,
        req.body ?? {},
        req.file ?? null,
      );
      res.json({ ok: true, maintenanceMode });
    } catch (error) {
      next(error);
    }
  },
);

adminMaintenanceModeRouter.get(
  '/media/:filename',
  requirePermission('manage_blog_posts'),
  async (req, res, next) => {
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
      res.setHeader('Cache-Control', 'private, max-age=300');
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
  },
);
