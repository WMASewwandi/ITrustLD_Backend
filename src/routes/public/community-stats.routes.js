import { Router } from 'express';
import { getPublicCommunityStats } from '../../services/communityStats.service.js';

export const publicCommunityStatsRouter = Router();

publicCommunityStatsRouter.get('/', async (_req, res, next) => {
  try {
    const stats = await getPublicCommunityStats();
    res.json({
      ok: true,
      ...stats,
    });
  } catch (error) {
    next(error);
  }
});
