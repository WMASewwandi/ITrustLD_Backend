import { Router } from 'express';
import { requireAdminAuth } from '../../middleware/requireAdminAuth.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import {
  listLoyaltyMembershipTiersAdmin,
  saveLoyaltyMembershipTiers,
} from '../../services/loyaltyMembershipTier.service.js';

export const adminLoyaltyMembershipTiersRouter = Router();

adminLoyaltyMembershipTiersRouter.use(requireAdminAuth);

adminLoyaltyMembershipTiersRouter.get(
  '/',
  requirePermission('view_account_configs'),
  async (_req, res, next) => {
    try {
      const data = await listLoyaltyMembershipTiersAdmin();
      res.json(data);
    } catch (error) {
      next(error);
    }
  },
);

adminLoyaltyMembershipTiersRouter.post(
  '/save',
  requirePermission('change_account_configs'),
  async (req, res, next) => {
    try {
      const tiers = req.body?.tiers ?? req.body ?? [];
      const data = await saveLoyaltyMembershipTiers(tiers);
      res.json(data);
    } catch (error) {
      next(error);
    }
  },
);
