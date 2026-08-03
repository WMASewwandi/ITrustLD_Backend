import { Router } from 'express';
import fs from 'fs/promises';
import path from 'node:path';
import { env } from '../../config/env.js';
import {
  guessBlogBannerMimeType,
  resolveBlogBannerPath,
} from '../../services/blogStorage.service.js';

export const publicBlogBannersRouter = Router();

publicBlogBannersRouter.get('/:filename', async (req, res, next) => {
  try {
    const safeName = path.basename(String(req.params.filename || ''));
    let filePath = resolveBlogBannerPath(safeName);
    try {
      await fs.access(filePath);
    } catch {
      filePath = path.resolve(
        env.projectRoot,
        '../ITrustLD_Existing/public/uploads/blogs',
        safeName,
      );
    }
    const buffer = await fs.readFile(filePath);
    res.setHeader('Content-Type', guessBlogBannerMimeType(req.params.filename));
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(buffer);
  } catch (error) {
    if (error.code === 'ENOENT') {
      const notFound = new Error('Banner not found.');
      notFound.status = 404;
      next(notFound);
      return;
    }
    next(error);
  }
});
