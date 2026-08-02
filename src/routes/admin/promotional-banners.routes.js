import { Router } from 'express';
import fs from 'fs/promises';
import multer from 'multer';
import path from 'node:path';
import { env } from '../../config/env.js';
import { requireAdminAuth } from '../../middleware/requireAdminAuth.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import {
  createPromotionalBanner,
  deletePromotionalBanner,
  listPromotionalBannersAdmin,
  updatePromotionalBanner,
} from '../../services/promotionalBanner.service.js';
import {
  guessPromotionalMediaMimeType,
  resolvePromotionalMediaPath,
} from '../../services/promotionalBannerStorage.service.js';

export const adminPromotionalBannersRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

adminPromotionalBannersRouter.use(requireAdminAuth);

adminPromotionalBannersRouter.get(
  '/',
  requirePermission('manage_blog_posts'),
  async (_req, res, next) => {
    try {
      const data = await listPromotionalBannersAdmin();
      res.json(data);
    } catch (error) {
      next(error);
    }
  },
);

adminPromotionalBannersRouter.post(
  '/',
  requirePermission('manage_blog_posts'),
  upload.single('media'),
  async (req, res, next) => {
    try {
      const data = await createPromotionalBanner(req.body ?? {}, req.file ?? null);
      res.status(201).json(data);
    } catch (error) {
      if (error instanceof multer.MulterError) {
        const limitError = new Error(
          error.code === 'LIMIT_FILE_SIZE'
            ? 'Media file must not exceed 10MB.'
            : error.message,
        );
        limitError.status = 422;
        next(limitError);
        return;
      }
      next(error);
    }
  },
);

adminPromotionalBannersRouter.post(
  '/:id/update',
  requirePermission('manage_blog_posts'),
  upload.single('media'),
  async (req, res, next) => {
    try {
      const data = await updatePromotionalBanner(req.params.id, req.body ?? {}, req.file ?? null);
      res.json(data);
    } catch (error) {
      if (error instanceof multer.MulterError) {
        const limitError = new Error(
          error.code === 'LIMIT_FILE_SIZE'
            ? 'Media file must not exceed 10MB.'
            : error.message,
        );
        limitError.status = 422;
        next(limitError);
        return;
      }
      next(error);
    }
  },
);

adminPromotionalBannersRouter.post(
  '/:id/delete',
  requirePermission('manage_blog_posts'),
  async (req, res, next) => {
    try {
      const data = await deletePromotionalBanner(req.params.id);
      res.json(data);
    } catch (error) {
      next(error);
    }
  },
);

adminPromotionalBannersRouter.get(
  '/media/:filename',
  requirePermission('manage_blog_posts'),
  async (req, res, next) => {
    try {
      const safeName = path.basename(String(req.params.filename || ''));
      let filePath = resolvePromotionalMediaPath(safeName);
      try {
        await fs.access(filePath);
      } catch {
        filePath = path.resolve(
          env.projectRoot,
          '../ITrustLD_Existing/public/uploads/promotions',
          safeName,
        );
      }
      const buffer = await fs.readFile(filePath);
      res.setHeader('Content-Type', guessPromotionalMediaMimeType(safeName));
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.send(buffer);
    } catch (error) {
      if (error.code === 'ENOENT') {
        const notFound = new Error('Media not found.');
        notFound.status = 404;
        next(notFound);
        return;
      }
      next(error);
    }
  },
);
