import { Router } from 'express';
import { requireAdminAuth } from '../../middleware/requireAdminAuth.js';
import { getAdminNavCounts } from '../../services/adminNotification.service.js';
import { getAdminNavCountsRevision } from '../../services/adminNavCountsRevision.service.js';

export const adminNotificationsRouter = Router();

adminNotificationsRouter.use(requireAdminAuth);

function noStore(res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
}

adminNotificationsRouter.get('/revision', (req, res) => {
  noStore(res);
  res.json({ ok: true, revision: getAdminNavCountsRevision() });
});

adminNotificationsRouter.get('/counts', async (req, res, next) => {
  try {
    noStore(res);
    const revision = getAdminNavCountsRevision();
    const counts = await getAdminNavCounts(req.auth.roles, req.auth.userId);
    res.json({ ok: true, counts, revision });
  } catch (error) {
    next(error);
  }
});
