import { Router } from 'express';
import fs from 'fs/promises';
import {
  guessWalletLogoMimeType,
  resolveWalletLogoPath,
} from '../../services/walletLogoStorage.service.js';

export const publicWalletLogosRouter = Router();

publicWalletLogosRouter.get('/:filename', async (req, res, next) => {
  try {
    const filePath = resolveWalletLogoPath(req.params.filename);
    const buffer = await fs.readFile(filePath);
    res.setHeader('Content-Type', guessWalletLogoMimeType(req.params.filename));
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.send(buffer);
  } catch (error) {
    if (error.code === 'ENOENT') {
      const notFound = new Error('Wallet logo not found.');
      notFound.status = 404;
      next(notFound);
      return;
    }
    next(error);
  }
});
