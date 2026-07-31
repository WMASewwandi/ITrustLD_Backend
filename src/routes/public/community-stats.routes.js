import { Router } from 'express';
import { getUserCountDisplay } from '../../services/userCountDisplay.service.js';

export const publicCommunityStatsRouter = Router();

publicCommunityStatsRouter.get('/', async (_req, res, next) => {
  try {
    const userCount = await getUserCountDisplay();
    res.json({
      ok: true,
      members: {
        baseCount: userCount.baseCount,
        liveCount: userCount.liveCount,
        displayedCount: userCount.displayedCount,
      },
    });
  } catch (error) {
    next(error);
  }
});
