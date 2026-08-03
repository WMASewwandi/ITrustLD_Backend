import { Router } from 'express';
import fs from 'fs/promises';
import multer from 'multer';
import path from 'node:path';
import { env } from '../../config/env.js';
import { requireAdminAuth } from '../../middleware/requireAdminAuth.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import {
  createWebsiteLogoSchedule,
  deleteWebsiteLogoSchedule,
  listWebsiteLogosAdmin,
} from '../../services/websiteLogo.service.js';
import {
  guessWebsiteLogoMimeType,
  resolveWebsiteLogoPath,
} from '../../services/websiteLogoStorage.service.js';

export const adminWebsiteLogosRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
});

adminWebsiteLogosRouter.use(requireAdminAuth);

adminWebsiteLogosRouter.get(
  '/',
  requirePermission('manage_blog_posts'),
  async (_req, res, next) => {
    try {
      const data = await listWebsiteLogosAdmin();
      res.json({ ok: true, ...data });
    } catch (error) {
      next(error);
    }
  },
);

adminWebsiteLogosRouter.post(
  '/',
  requirePermission('manage_blog_posts'),
  upload.single('logo'),
  async (req, res, next) => {
    try {
      const data = await createWebsiteLogoSchedule(req.body ?? {}, req.file ?? null);
      res.status(201).json(data);
    } catch (error) {
      if (error instanceof multer.MulterError) {
        const limitError = new Error(
          error.code === 'LIMIT_FILE_SIZE'
            ? 'Logo file must not exceed 2MB.'
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

adminWebsiteLogosRouter.post(
  '/:id/delete',
  requirePermission('manage_blog_posts'),
  async (req, res, next) => {
    try {
      const data = await deleteWebsiteLogoSchedule(req.params.id);
      res.json(data);
    } catch (error) {
      next(error);
    }
  },
);

adminWebsiteLogosRouter.get(
  '/media/:filename',
  requirePermission('manage_blog_posts'),
  async (req, res, next) => {
    try {
      const safeName = path.basename(String(req.params.filename || ''));
      let filePath = resolveWebsiteLogoPath(safeName);
      try {
        await fs.access(filePath);
      } catch {
        filePath = path.resolve(
          env.projectRoot,
          '../ITrustLD_Existing/public/uploads/website-logos',
          safeName,
        );
      }
      const buffer = await fs.readFile(filePath);
      res.setHeader('Content-Type', guessWebsiteLogoMimeType(safeName));
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.send(buffer);
    } catch (error) {
      if (error.code === 'ENOENT') {
        const notFound = new Error('Logo not found.');
        notFound.status = 404;
        next(notFound);
        return;
      }
      next(error);
    }
  },
);
