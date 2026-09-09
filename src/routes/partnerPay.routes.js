import { Router } from 'express';
import { requirePartnerApiKey } from '../middleware/requirePartnerApiKey.js';
import {
  createGatewayCheckout,
  getGatewayTransactionStatus,
  listGatewayCatalog,
} from '../services/partnerPay.service.js';

export const partnerPayRouter = Router();

partnerPayRouter.use(requirePartnerApiKey);

partnerPayRouter.get('/catalog', async (_req, res, next) => {
  try {
    res.json(await listGatewayCatalog());
  } catch (error) {
    next(error);
  }
});

partnerPayRouter.post('/deposits', async (req, res, next) => {
  try {
    res.status(201).json(await createGatewayCheckout(req.partner, 'deposit', req.body ?? {}));
  } catch (error) {
    next(error);
  }
});

partnerPayRouter.post('/withdrawals', async (req, res, next) => {
  try {
    res.status(201).json(await createGatewayCheckout(req.partner, 'withdrawal', req.body ?? {}));
  } catch (error) {
    next(error);
  }
});

partnerPayRouter.get('/deposits/:transactionId', async (req, res, next) => {
  try {
    res.json(await getGatewayTransactionStatus('deposit', req.params.transactionId));
  } catch (error) {
    next(error);
  }
});

partnerPayRouter.get('/withdrawals/:transactionId', async (req, res, next) => {
  try {
    res.json(await getGatewayTransactionStatus('withdrawal', req.params.transactionId));
  } catch (error) {
    next(error);
  }
});
