import { Router } from 'express';
import { requireUserAuth } from '../../middleware/requireUserAuth.js';
import { claimGatewayCheckout } from '../../services/partnerPay.service.js';

export const userPartnerPayRouter = Router();

userPartnerPayRouter.use(requireUserAuth);

userPartnerPayRouter.post('/claim', async (req, res, next) => {
  try {
    res.json(await claimGatewayCheckout(req.auth.userId, req.body?.token || req.query.token));
  } catch (error) {
    next(error);
  }
});
