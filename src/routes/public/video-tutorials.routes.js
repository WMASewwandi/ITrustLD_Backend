import { Router } from 'express';
import { listActiveVideoTutorials } from '../../services/videoTutorial.service.js';

export const publicVideoTutorialsRouter = Router();

publicVideoTutorialsRouter.get('/', async (_req, res, next) => {
  try {
    const tutorials = await listActiveVideoTutorials();
    res.json({ ok: true, tutorials, count: tutorials.length });
  } catch (error) {
    next(error);
  }
});
