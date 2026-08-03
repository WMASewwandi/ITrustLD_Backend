import { Router } from 'express';
import fs from 'fs/promises';
import path from 'node:path';
import { env } from '../../config/env.js';
import { getActiveWebsiteLogo } from '../../services/websiteLogo.service.js';
import {
  guessWebsiteLogoMimeType,
  resolveWebsiteLogoPath,
} from '../../services/websiteLogoStorage.service.js';

export const publicWebsiteLogosRouter = Router();

publicWebsiteLogosRouter.get('/', async (_req, res, next) => {
  try {
    const logo = await getActiveWebsiteLogo();
    res.json({ ok: true, ...logo });
  } catch (error) {
    next(error);
  }
});

publicWebsiteLogosRouter.get('/media/:filename', async (req, res, next) => {
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
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Cache-Control', 'public, max-age=3600');
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
});
