import { Router } from 'express';
import { requireUserAuth } from '../../middleware/requireUserAuth.js';
import { requireCustomerLoyaltyActivity } from '../../middleware/requireCustomerLoyaltyActivity.js';
import {
  listPartnerClients,
  listSubPartnerClients,
} from '../../services/userAffiliate.service.js';
import {
  createUserBonusClaim,
  createUserLoyaltyWithdrawal,
  getUserLoyaltySummary,
  listUserBonusClaims,
  listUserLoyaltyWithdrawals,
} from '../../services/userLoyalty.service.js';
import {
  createUserClientBonusVoucher,
  getUserVoucherByToken,
  listTopupMethodsForVoucher,
  listUserVoucherClaims,
} from '../../services/userVoucherClaims.service.js';
import {
  createGiftClaim,
  listAvailableGiftsForUser,
  listUserGiftClaims,
} from '../../services/userLoyaltyGifts.service.js';

export const userLoyaltyRouter = Router();

userLoyaltyRouter.use(requireUserAuth);
userLoyaltyRouter.use(requireCustomerLoyaltyActivity);

userLoyaltyRouter.get('/summary', async (req, res, next) => {
  try {
    const data = await getUserLoyaltySummary(req.auth.userId);
    res.json(data);
  } catch (error) {
    next(error);
  }
});

userLoyaltyRouter.get('/clients', async (req, res, next) => {
  try {
    const data = await listPartnerClients(req.auth.userId, req.query ?? {});
    res.json(data);
  } catch (error) {
    next(error);
  }
});

userLoyaltyRouter.get('/sub-partners', async (req, res, next) => {
  try {
    const data = await listSubPartnerClients(req.auth.userId, req.query ?? {});
    res.json(data);
  } catch (error) {
    next(error);
  }
});

userLoyaltyRouter.get('/withdrawals', async (req, res, next) => {
  try {
    const data = await listUserLoyaltyWithdrawals(req.auth.userId, req.query ?? {});
    res.json(data);
  } catch (error) {
    next(error);
  }
});

userLoyaltyRouter.post('/withdrawals', async (req, res, next) => {
  try {
    const data = await createUserLoyaltyWithdrawal(req.auth.userId, req.body ?? {});
    res.status(201).json(data);
  } catch (error) {
    next(error);
  }
});

userLoyaltyRouter.get('/bonus-claims', async (req, res, next) => {
  try {
    const data = await listUserBonusClaims(req.auth.userId, req.query ?? {});
    res.json({ ok: true, ...data });
  } catch (error) {
    next(error);
  }
});

userLoyaltyRouter.post('/bonus-claims', async (req, res, next) => {
  try {
    const data = await createUserBonusClaim(req.auth.userId, req.body ?? {});
    res.status(201).json(data);
  } catch (error) {
    next(error);
  }
});

userLoyaltyRouter.get('/vouchers', async (req, res, next) => {
  try {
    const data = await listUserVoucherClaims(req.auth.userId, req.query ?? {});
    res.json({ ok: true, ...data });
  } catch (error) {
    next(error);
  }
});

userLoyaltyRouter.post('/vouchers', async (req, res, next) => {
  try {
    const data = await createUserClientBonusVoucher(req.auth.userId, req.body ?? {});
    res.status(201).json(data);
  } catch (error) {
    next(error);
  }
});

userLoyaltyRouter.get('/vouchers/:token', async (req, res, next) => {
  try {
    const data = await getUserVoucherByToken(req.auth.userId, req.params.token);
    res.json({ ok: true, ...data });
  } catch (error) {
    next(error);
  }
});

userLoyaltyRouter.get('/topup-methods', async (req, res, next) => {
  try {
    const data = await listTopupMethodsForVoucher();
    res.json({ ok: true, ...data });
  } catch (error) {
    next(error);
  }
});

userLoyaltyRouter.get('/gifts', async (req, res, next) => {
  try {
    const data = await listAvailableGiftsForUser(req.auth.userId);
    res.json({ ok: true, ...data });
  } catch (error) {
    next(error);
  }
});

userLoyaltyRouter.post('/gifts/claim', async (req, res, next) => {
  try {
    const data = await createGiftClaim(req.auth.userId, req.body ?? {});
    res.status(201).json(data);
  } catch (error) {
    next(error);
  }
});

userLoyaltyRouter.get('/gift-claims', async (req, res, next) => {
  try {
    const data = await listUserGiftClaims(req.auth.userId);
    res.json({ ok: true, ...data });
  } catch (error) {
    next(error);
  }
});
