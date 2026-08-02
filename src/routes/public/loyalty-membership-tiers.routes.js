import { Router } from 'express';
import { listActiveLoyaltyMembershipTiers } from '../../services/loyaltyMembershipTier.service.js';

export const publicLoyaltyMembershipTiersRouter = Router();

publicLoyaltyMembershipTiersRouter.get('/', async (_req, res, next) => {
  try {
    const tiers = await listActiveLoyaltyMembershipTiers();
    res.json({ ok: true, tiers, count: tiers.length });
  } catch (error) {
    next(error);
  }
});
