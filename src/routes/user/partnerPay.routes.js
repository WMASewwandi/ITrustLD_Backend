import { Router } from 'express';
import { requireUserAuth } from '../../middleware/requireUserAuth.js';
import { claimGatewayCheckout } from '../../services/partnerPay.service.js';
import { takeCompletedPartnerReturn } from '../../services/partnerPayReturn.service.js';

export const userPartnerPayRouter = Router();

userPartnerPayRouter.use(requireUserAuth);

userPartnerPayRouter.post('/claim', async (req, res, next) => {
  try {
    res.json(await claimGatewayCheckout(req.auth.userId, req.body?.token || req.query.token));
  } catch (error) {
    next(error);
  }
});

userPartnerPayRouter.get('/pending-return', async (req, res, next) => {
  try {
    res.json(await takeCompletedPartnerReturn(req.auth.userId));
  } catch (error) {
    next(error);
  }
});
