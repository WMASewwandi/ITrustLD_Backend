import { Router } from 'express';
import { requireUserAuth } from '../../middleware/requireUserAuth.js';
import { requireCustomerLoyaltyActivity } from '../../middleware/requireCustomerLoyaltyActivity.js';
import {
  createUserLoyaltyWithdrawal,
  getUserLoyaltySummary,
  listUserLoyaltyWithdrawals,
} from '../../services/userLoyalty.service.js';

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
