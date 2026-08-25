import { Router } from 'express';
import { listActiveLoyaltyMembershipTiers } from '../../services/loyaltyMembershipTier.service.js';

export const publicLoyaltyMembershipTiersRouter = Router();

publicLoyaltyMembershipTiersRouter.get('/', async (req, res, next) => {
  try {
    const audience = String(req.query.audience || req.query.user_type || '').trim() || 'normal';
    const tiers = await listActiveLoyaltyMembershipTiers(audience);
    res.json({ ok: true, tiers, count: tiers.length, audience });
  } catch (error) {
    next(error);
  }
});
