import { Router } from 'express';
import fs from 'fs/promises';
import path from 'node:path';
import { env } from '../../config/env.js';
import { listActivePromotionalBanners } from '../../services/promotionalBanner.service.js';
import {
  guessPromotionalMediaMimeType,
  resolvePromotionalMediaPath,
} from '../../services/promotionalBannerStorage.service.js';

export const publicPromotionalBannersRouter = Router();

publicPromotionalBannersRouter.get('/', async (req, res, next) => {
  try {
    const audience = req.query.audience || 'normal';
    const displayType = req.query.display_type || req.query.displayType || 'all';
    const banners = await listActivePromotionalBanners({ audience, displayType });
    res.json({ ok: true, banners });
  } catch (error) {
    next(error);
  }
});

publicPromotionalBannersRouter.get('/media/:filename', async (req, res, next) => {
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
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Cache-Control', 'public, max-age=3600');
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
});
