import { Router } from 'express';
import { requireAdminAuth } from '../../middleware/requireAdminAuth.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import {
  createBonus,
  createLoyaltyLevel,
  createPointCollection,
  deleteBonus,
  deleteLoyaltyLevel,
  deletePointCollection,
  getLoyaltyManagementData,
  updateBonusActivationState,
  updateBonusAmount,
  updateLoyaltyLevel,
  updateLoyaltyLevelActivationState,
  updateMasterConfigActivationState,
  updatePointCollectionActivationState,
  updatePointCollectionAmount,
} from '../../services/adminLoyaltyManagement.service.js';
import {
  approveGiftClaim,
  createGift,
  deleteGift,
  listGiftClaimsForAdmin,
  listGiftsForAdmin,
  markGiftClaimDelivered,
  rejectGiftClaim,
  updateGift,
  updateGiftState,
} from '../../services/adminLoyaltyGifts.service.js';
import {
  checkVoucherDuplicatePlatformId,
  completeVoucherClaim,
  getVoucherDuplicatePlatformStats,
  listVoucherClaimsForAdmin,
  rejectVoucherClaim,
} from '../../services/adminVoucherClaims.service.js';
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

adminLoyaltyRouter.get(
  '/voucher-claims',
  requirePermission('read_customer_loyalty_data'),
  async (req, res, next) => {
    try {
      const data = await listVoucherClaimsForAdmin(req.query ?? {});
      res.json({ ok: true, ...data });
    } catch (error) {
      next(error);
    }
  },
);

adminLoyaltyRouter.get(
  '/voucher-claims/duplicate-stats',
  requirePermission('read_customer_loyalty_data'),
  async (req, res, next) => {
    try {
      const data = await getVoucherDuplicatePlatformStats();
      res.json(data);
    } catch (error) {
      next(error);
    }
  },
);

adminLoyaltyRouter.get(
  '/voucher-claims/:voucherId/duplicates',
  requirePermission('read_customer_loyalty_data'),
  async (req, res, next) => {
    try {
      const data = await checkVoucherDuplicatePlatformId(req.params.voucherId);
      res.json({ ok: true, ...data });
    } catch (error) {
      next(error);
    }
  },
);

adminLoyaltyRouter.post(
  '/voucher-claims/complete',
  requirePermission('change_customer_loyalty_status'),
  async (req, res, next) => {
    try {
      const data = await completeVoucherClaim(req.auth.userId, req.body ?? {});
      res.json(data);
    } catch (error) {
      next(error);
    }
  },
);

adminLoyaltyRouter.post(
  '/voucher-claims/reject',
  requirePermission('change_customer_loyalty_status'),
  async (req, res, next) => {
    try {
      const data = await rejectVoucherClaim(req.auth.userId, req.body ?? {});
      res.json(data);
    } catch (error) {
      next(error);
    }
  },
);

adminLoyaltyRouter.get(
  '/management/configs',
  requirePermission('view_account_configs'),
  async (req, res, next) => {
    try {
      const data = await getLoyaltyManagementData(req.query?.audience, req.query?.tier);
      res.json({ ok: true, ...data });
    } catch (error) {
      next(error);
    }
  },
);

adminLoyaltyRouter.post(
  '/management/master-config/state',
  requirePermission('change_account_configs'),
  async (req, res, next) => {
    try {
      const body = req.body ?? {};
      const data = await updateMasterConfigActivationState({
        identifier: body.identifier,
        activationState: body.activation_state ?? body.activationState,
      });
      res.json(data);
    } catch (error) {
      next(error);
    }
  },
);

adminLoyaltyRouter.post(
  '/management/point-collections',
  requirePermission('change_account_configs'),
  async (req, res, next) => {
    try {
      const body = req.body ?? {};
      const data = await createPointCollection(req.auth.userId, {
        calAmount: body.pointcollection_cal_amount ?? body.cal_amount ?? body.calAmount,
        isAffiliate: body.pointcollection_is_affiliate ?? body.is_affiliate ?? body.isAffiliate,
        membershipTier:
          body.pointcollection_membership_tier ??
          body.membership_tier ??
          body.membershipTier ??
          body.tier,
      });
      res.json(data);
    } catch (error) {
      next(error);
    }
  },
);

adminLoyaltyRouter.post(
  '/management/point-collections/amount',
  requirePermission('change_account_configs'),
  async (req, res, next) => {
    try {
      const body = req.body ?? {};
      const data = await updatePointCollectionAmount({
        pointCollectionId: body.pointcollection_id ?? body.point_collection_id ?? body.id,
        calAmount: body.pointcollection_cal_amount ?? body.cal_amount ?? body.calAmount,
        membershipTier:
          body.pointcollection_membership_tier ??
          body.membership_tier ??
          body.membershipTier ??
          body.tier,
      });
      res.json(data);
    } catch (error) {
      next(error);
    }
  },
);

adminLoyaltyRouter.post(
  '/management/point-collections/state',
  requirePermission('change_account_configs'),
  async (req, res, next) => {
    try {
      const body = req.body ?? {};
      const data = await updatePointCollectionActivationState({
        pointCollectionId: body.pointcollection_id ?? body.point_collection_id ?? body.id,
        activationState:
          body.pointcollection_activation_state ?? body.activation_state ?? body.activationState,
      });
      res.json(data);
    } catch (error) {
      next(error);
    }
  },
);

adminLoyaltyRouter.post(
  '/management/point-collections/delete',
  requirePermission('change_account_configs'),
  async (req, res, next) => {
    try {
      const body = req.body ?? {};
      const data = await deletePointCollection({
        pointCollectionId: body.pointcollection_id ?? body.point_collection_id ?? body.id,
      });
      res.json(data);
    } catch (error) {
      next(error);
    }
  },
);

adminLoyaltyRouter.post(
  '/management/bonuses',
  requirePermission('change_account_configs'),
  async (req, res, next) => {
    try {
      const body = req.body ?? {};
      const data = await createBonus(req.auth.userId, {
        bonusAmount: body.bonus_amount ?? body.bonusAmount,
        isAffiliate: body.bonus_is_affiliate ?? body.is_affiliate ?? body.isAffiliate,
        membershipTier:
          body.bonus_membership_tier ??
          body.membership_tier ??
          body.membershipTier ??
          body.tier,
      });
      res.json(data);
    } catch (error) {
      next(error);
    }
  },
);

adminLoyaltyRouter.post(
  '/management/bonuses/amount',
  requirePermission('change_account_configs'),
  async (req, res, next) => {
    try {
      const body = req.body ?? {};
      const data = await updateBonusAmount({
        bonusId: body.bonus_id ?? body.id,
        bonusAmount: body.bonus_amount ?? body.bonusAmount,
        membershipTier:
          body.bonus_membership_tier ??
          body.membership_tier ??
          body.membershipTier ??
          body.tier,
      });
      res.json(data);
    } catch (error) {
      next(error);
    }
  },
);

adminLoyaltyRouter.post(
  '/management/bonuses/state',
  requirePermission('change_account_configs'),
  async (req, res, next) => {
    try {
      const body = req.body ?? {};
      const data = await updateBonusActivationState({
        bonusId: body.bonus_id ?? body.id,
        activationState: body.bonus_activation_state ?? body.activation_state ?? body.activationState,
      });
      res.json(data);
    } catch (error) {
      next(error);
    }
  },
);

adminLoyaltyRouter.post(
  '/management/bonuses/delete',
  requirePermission('change_account_configs'),
  async (req, res, next) => {
    try {
      const body = req.body ?? {};
      const data = await deleteBonus({
        bonusId: body.bonus_id ?? body.id,
      });
      res.json(data);
    } catch (error) {
      next(error);
    }
  },
);

adminLoyaltyRouter.post(
  '/management/loyalty-levels',
  requirePermission('change_account_configs'),
  async (req, res, next) => {
    try {
      const body = req.body ?? {};
      const data = await createLoyaltyLevel(req.auth.userId, {
        clientBonusAmount: body.client_bonus_amount ?? body.clientBonusAmount,
        clientCount: body.client_count ?? body.clientCount,
        loyaltyLevel: body.loyalty_level ?? body.loyaltyLevel,
      });
      res.json(data);
    } catch (error) {
      next(error);
    }
  },
);

adminLoyaltyRouter.post(
  '/management/loyalty-levels/amount',
  requirePermission('change_account_configs'),
  async (req, res, next) => {
    try {
      const body = req.body ?? {};
      const data = await updateLoyaltyLevel({
        loyaltyLevelId: body.loyalty_level_id ?? body.id,
        clientBonusAmount: body.client_bonus_amount ?? body.clientBonusAmount,
        clientCount: body.client_count ?? body.clientCount,
      });
      res.json(data);
    } catch (error) {
      next(error);
    }
  },
);

adminLoyaltyRouter.post(
  '/management/loyalty-levels/state',
  requirePermission('change_account_configs'),
  async (req, res, next) => {
    try {
      const body = req.body ?? {};
      const data = await updateLoyaltyLevelActivationState({
        loyaltyLevelId: body.loyalty_level_id ?? body.id,
        activationState: body.activation_state ?? body.activationState,
      });
      res.json(data);
    } catch (error) {
      next(error);
    }
  },
);

adminLoyaltyRouter.post(
  '/management/loyalty-levels/delete',
  requirePermission('change_account_configs'),
  async (req, res, next) => {
    try {
      const body = req.body ?? {};
      const data = await deleteLoyaltyLevel({
        loyaltyLevelId: body.loyalty_level_id ?? body.id,
      });
      res.json(data);
    } catch (error) {
      next(error);
    }
  },
);

adminLoyaltyRouter.get(
  '/gifts',
  requirePermission('read_customer_loyalty_data'),
  async (req, res, next) => {
    try {
      const data = await listGiftsForAdmin(req.query?.audience);
      res.json({ ok: true, ...data });
    } catch (error) {
      next(error);
    }
  },
);

adminLoyaltyRouter.post(
  '/gifts',
  requirePermission('change_account_configs'),
  async (req, res, next) => {
    try {
      const body = req.body ?? {};
      const data = await createGift(req.auth.userId, {
        title: body.title,
        description: body.description,
        audience_type: body.audience_type ?? body.audienceType ?? body.audience,
        allowed_levels: body.allowed_levels ?? body.allowedLevels,
      });
      res.json(data);
    } catch (error) {
      next(error);
    }
  },
);

adminLoyaltyRouter.post(
  '/gifts/update',
  requirePermission('change_account_configs'),
  async (req, res, next) => {
    try {
      const data = await updateGift(req.body ?? {});
      res.json(data);
    } catch (error) {
      next(error);
    }
  },
);

adminLoyaltyRouter.post(
  '/gifts/state',
  requirePermission('change_account_configs'),
  async (req, res, next) => {
    try {
      const data = await updateGiftState(req.body ?? {});
      res.json(data);
    } catch (error) {
      next(error);
    }
  },
);

adminLoyaltyRouter.post(
  '/gifts/delete',
  requirePermission('change_account_configs'),
  async (req, res, next) => {
    try {
      const data = await deleteGift(req.body ?? {});
      res.json(data);
    } catch (error) {
      next(error);
    }
  },
);

adminLoyaltyRouter.get(
  '/gift-claims',
  requirePermission('read_customer_loyalty_data'),
  async (req, res, next) => {
    try {
      const data = await listGiftClaimsForAdmin(req.query ?? {});
      res.json({ ok: true, ...data });
    } catch (error) {
      next(error);
    }
  },
);

adminLoyaltyRouter.post(
  '/gift-claims/approve',
  requirePermission('change_customer_loyalty_status'),
  async (req, res, next) => {
    try {
      const data = await approveGiftClaim(req.auth.userId, req.body ?? {});
      res.json(data);
    } catch (error) {
      next(error);
    }
  },
);

adminLoyaltyRouter.post(
  '/gift-claims/reject',
  requirePermission('change_customer_loyalty_status'),
  async (req, res, next) => {
    try {
      const data = await rejectGiftClaim(req.auth.userId, req.body ?? {});
      res.json(data);
    } catch (error) {
      next(error);
    }
  },
);

adminLoyaltyRouter.post(
  '/gift-claims/deliver',
  requirePermission('change_customer_loyalty_status'),
  async (req, res, next) => {
    try {
      const data = await markGiftClaimDelivered(req.auth.userId, req.body ?? {});
      res.json(data);
    } catch (error) {
      next(error);
    }
  },
);
