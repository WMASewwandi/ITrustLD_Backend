import { Router } from 'express';
import { requireAdminAuth } from '../../middleware/requireAdminAuth.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import {
  LOYALTY_BONUS_READ,
  LOYALTY_BONUS_UPDATE,
  LOYALTY_GIFTS_CATALOG_UPDATE,
  LOYALTY_GIFTS_CLAIMS_UPDATE,
  LOYALTY_GIFTS_READ,
  LOYALTY_MANAGEMENT_READ,
  LOYALTY_MANAGEMENT_UPDATE,
  LOYALTY_ORDERS_READ,
  LOYALTY_ORDERS_UPDATE,
  AUTHORIZE_LOYALTY_ORDERS,
  LOYALTY_VOUCHER_READ,
  LOYALTY_VOUCHER_UPDATE,
} from '../../constants/loyaltyPermissions.js';
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
import {
  assignLoyaltyRecords,
  listLoyaltyAssignees,
} from '../../services/loyaltyAssignment.service.js';

export const adminLoyaltyRouter = Router();

adminLoyaltyRouter.use(requireAdminAuth);

adminLoyaltyRouter.get(
  '/orders',
  requirePermission(LOYALTY_ORDERS_READ, AUTHORIZE_LOYALTY_ORDERS),
  async (req, res, next) => {
    try {
      const data = await listLoyaltyOrdersForAdmin(req.query ?? {}, req.auth);
      res.json({ ok: true, ...data });
    } catch (error) {
      next(error);
    }
  },
);

adminLoyaltyRouter.get(
  '/orders/executives',
  requirePermission(LOYALTY_ORDERS_READ, AUTHORIZE_LOYALTY_ORDERS),
  async (req, res, next) => {
    try {
      const queue = String(req.query.queue || '');
      const data = await listLoyaltyAssignees('order', {
        authorizers: queue === 'pending-authorization',
      });
      res.json(data);
    } catch (error) {
      next(error);
    }
  },
);

adminLoyaltyRouter.post(
  '/orders/assign',
  requirePermission(LOYALTY_ORDERS_UPDATE),
  async (req, res, next) => {
    try {
      const body = req.body ?? {};
      const data = await assignLoyaltyRecords(req.auth, 'order', {
        ids: body.order_ids || body.withdrawal_ids || body.ids,
        executiveId: body.executive_id ?? body.executiveId ?? null,
      });
      res.json(data);
    } catch (error) {
      next(error);
    }
  },
);

adminLoyaltyRouter.post(
  '/orders/status',
  requirePermission(LOYALTY_ORDERS_UPDATE, AUTHORIZE_LOYALTY_ORDERS),
  async (req, res, next) => {
    try {
      const data = await updateLoyaltyOrderStatus(req.auth, req.body ?? {});
      res.json(data);
    } catch (error) {
      next(error);
    }
  },
);

adminLoyaltyRouter.get(
  '/bonus-claims',
  requirePermission(LOYALTY_BONUS_READ),
  async (req, res, next) => {
    try {
      const data = await listBonusClaimsForAdmin(req.query ?? {}, req.auth);
      res.json({ ok: true, ...data });
    } catch (error) {
      next(error);
    }
  },
);

adminLoyaltyRouter.get(
  '/bonus-claims/executives',
  requirePermission(LOYALTY_BONUS_READ),
  async (req, res, next) => {
    try {
      const data = await listLoyaltyAssignees('bonus');
      res.json(data);
    } catch (error) {
      next(error);
    }
  },
);

adminLoyaltyRouter.post(
  '/bonus-claims/assign',
  requirePermission(LOYALTY_BONUS_UPDATE),
  async (req, res, next) => {
    try {
      const body = req.body ?? {};
      const data = await assignLoyaltyRecords(req.auth, 'bonus', {
        ids: body.bonus_ids || body.claim_ids || body.ids,
        executiveId: body.executive_id ?? body.executiveId ?? null,
      });
      res.json(data);
    } catch (error) {
      next(error);
    }
  },
);

adminLoyaltyRouter.post(
  '/bonus-claims/status',
  requirePermission(LOYALTY_BONUS_UPDATE),
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
  requirePermission(LOYALTY_VOUCHER_READ),
  async (req, res, next) => {
    try {
      const data = await listVoucherClaimsForAdmin(req.query ?? {}, req.auth);
      res.json({ ok: true, ...data });
    } catch (error) {
      next(error);
    }
  },
);

adminLoyaltyRouter.get(
  '/voucher-claims/duplicate-stats',
  requirePermission(LOYALTY_VOUCHER_READ),
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
  requirePermission(LOYALTY_VOUCHER_READ),
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
  requirePermission(LOYALTY_VOUCHER_UPDATE),
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
  requirePermission(LOYALTY_VOUCHER_UPDATE),
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
  requirePermission(LOYALTY_MANAGEMENT_READ),
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
  requirePermission(LOYALTY_MANAGEMENT_UPDATE),
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
  requirePermission(LOYALTY_MANAGEMENT_UPDATE),
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
  requirePermission(LOYALTY_MANAGEMENT_UPDATE),
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
  requirePermission(LOYALTY_MANAGEMENT_UPDATE),
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
  requirePermission(LOYALTY_MANAGEMENT_UPDATE),
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
  requirePermission(LOYALTY_MANAGEMENT_UPDATE),
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
        notifyUsersByEmail:
          body.notifyUsersByEmail ?? body.notify_users ?? body.notifyUsers,
      });
      res.json(data);
    } catch (error) {
      next(error);
    }
  },
);

adminLoyaltyRouter.post(
  '/management/bonuses/amount',
  requirePermission(LOYALTY_MANAGEMENT_UPDATE),
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
        notifyUsersByEmail:
          body.notifyUsersByEmail ?? body.notify_users ?? body.notifyUsers,
      });
      res.json(data);
    } catch (error) {
      next(error);
    }
  },
);

adminLoyaltyRouter.post(
  '/management/bonuses/state',
  requirePermission(LOYALTY_MANAGEMENT_UPDATE),
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
  requirePermission(LOYALTY_MANAGEMENT_UPDATE),
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
  requirePermission(LOYALTY_MANAGEMENT_UPDATE),
  async (req, res, next) => {
    try {
      const body = req.body ?? {};
      const data = await createLoyaltyLevel(req.auth.userId, {
        clientBonusAmount: body.client_bonus_amount ?? body.clientBonusAmount,
        clientCount: body.client_count ?? body.clientCount,
        loyaltyLevel: body.loyalty_level ?? body.loyaltyLevel,
        notifyUsersByEmail:
          body.notifyUsersByEmail ?? body.notify_users ?? body.notifyUsers,
      });
      res.json(data);
    } catch (error) {
      next(error);
    }
  },
);

adminLoyaltyRouter.post(
  '/management/loyalty-levels/amount',
  requirePermission(LOYALTY_MANAGEMENT_UPDATE),
  async (req, res, next) => {
    try {
      const body = req.body ?? {};
      const data = await updateLoyaltyLevel({
        loyaltyLevelId: body.loyalty_level_id ?? body.id,
        clientBonusAmount: body.client_bonus_amount ?? body.clientBonusAmount,
        clientCount: body.client_count ?? body.clientCount,
        notifyUsersByEmail:
          body.notifyUsersByEmail ?? body.notify_users ?? body.notifyUsers,
      });
      res.json(data);
    } catch (error) {
      next(error);
    }
  },
);

adminLoyaltyRouter.post(
  '/management/loyalty-levels/state',
  requirePermission(LOYALTY_MANAGEMENT_UPDATE),
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
  requirePermission(LOYALTY_MANAGEMENT_UPDATE),
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
  requirePermission(LOYALTY_GIFTS_READ),
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
  requirePermission(LOYALTY_GIFTS_CATALOG_UPDATE),
  async (req, res, next) => {
    try {
      const body = req.body ?? {};
      const data = await createGift(req.auth.userId, {
        title: body.title,
        description: body.description,
        audience_type: body.audience_type ?? body.audienceType ?? body.audience,
        allowed_levels: body.allowed_levels ?? body.allowedLevels,
        expires_at: body.expires_at ?? body.expiresAt ?? body.expiry_date,
        notifyUsersByEmail:
          body.notifyUsersByEmail ?? body.notify_users ?? body.notifyUsers,
      });
      res.json(data);
    } catch (error) {
      next(error);
    }
  },
);

adminLoyaltyRouter.post(
  '/gifts/update',
  requirePermission(LOYALTY_GIFTS_CATALOG_UPDATE),
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
  requirePermission(LOYALTY_GIFTS_CATALOG_UPDATE),
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
  requirePermission(LOYALTY_GIFTS_CATALOG_UPDATE),
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
  requirePermission(LOYALTY_GIFTS_READ),
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
  requirePermission(LOYALTY_GIFTS_CLAIMS_UPDATE),
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
  requirePermission(LOYALTY_GIFTS_CLAIMS_UPDATE),
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
  requirePermission(LOYALTY_GIFTS_CLAIMS_UPDATE),
  async (req, res, next) => {
    try {
      const data = await markGiftClaimDelivered(req.auth.userId, req.body ?? {});
      res.json(data);
    } catch (error) {
      next(error);
    }
  },
);
