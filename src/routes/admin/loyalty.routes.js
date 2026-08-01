import { Router } from 'express';
import { requireAdminAuth } from '../../middleware/requireAdminAuth.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import {
  listBonusClaimsForAdmin,
  listLoyaltyOrdersForAdmin,
  updateBonusClaimStatus,
  updateLoyaltyOrderStatus,
} from '../../services/userLoyalty.service.js';

export const adminLoyaltyRouter = Router();

adminLoyaltyRouter.use(requireAdminAuth);

adminLoyaltyRouter.get(
  '/orders',
  requirePermission('read_customer_loyalty_data'),
  async (req, res, next) => {
    try {
      const data = await listLoyaltyOrdersForAdmin(req.query ?? {});
      res.json({ ok: true, ...data });
    } catch (error) {
      next(error);
    }
  },
);

adminLoyaltyRouter.post(
  '/orders/status',
  requirePermission('change_customer_loyalty_status'),
  async (req, res, next) => {
    try {
      const data = await updateLoyaltyOrderStatus(req.auth.userId, req.body ?? {});
      res.json(data);
    } catch (error) {
      next(error);
    }
  },
);

adminLoyaltyRouter.get(
  '/bonus-claims',
  requirePermission('read_customer_loyalty_data'),
  async (req, res, next) => {
    try {
      const data = await listBonusClaimsForAdmin(req.query ?? {});
      res.json({ ok: true, ...data });
    } catch (error) {
      next(error);
    }
  },
);

adminLoyaltyRouter.post(
  '/bonus-claims/status',
  requirePermission('change_customer_loyalty_status'),
  async (req, res, next) => {
    try {
      const data = await updateBonusClaimStatus(req.auth.userId, req.body ?? {});
      res.json(data);
    } catch (error) {
      next(error);
    }
  },
);
