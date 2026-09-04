import { Router } from 'express';
import { requireAdminAuth } from '../../middleware/requireAdminAuth.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import {
  addPointWithdrawalRate,
  createRates,
  deletePointWithdrawalRate,
  deleteRate,
  getRatesManagementData,
  listRatePaymentOptions,
  updateDepositRate,
  updatePointWithdrawalRate,
  updateWithdrawalRate,
} from '../../services/rates.service.js';
import { listCustomPayAccountCategoryNames } from '../../services/customPayAccount.service.js';

export const adminRatesRouter = Router();

adminRatesRouter.use(requireAdminAuth);

adminRatesRouter.get(
  '/payment-options',
  requirePermission('view_currency_configs'),
  async (_req, res, next) => {
    try {
      const customCategories = await listCustomPayAccountCategoryNames();
      const paymentOptions = await listRatePaymentOptions();
      res.json({ ok: true, paymentOptions, customCategories });
    } catch (error) {
      next(error);
    }
  },
);

adminRatesRouter.get(
  '/:methodName',
  requirePermission('view_currency_configs'),
  async (req, res, next) => {
    try {
      const data = await getRatesManagementData(req.params.methodName);
      res.json({ ok: true, ...data });
    } catch (error) {
      next(error);
    }
  },
);

adminRatesRouter.post(
  '/',
  requirePermission('change_currency_configs'),
  async (req, res, next) => {
    try {
      await createRates(req.auth.userId, req.body);
      res.status(201).json({ ok: true, message: 'Rates saved successfully' });
    } catch (error) {
      next(error);
    }
  },
);

adminRatesRouter.post(
  '/deposit/update',
  requirePermission('change_currency_configs'),
  async (req, res, next) => {
    try {
      await updateDepositRate(req.auth.userId, req.body);
      res.json({ ok: true, message: 'Deposit rates updated successfully' });
    } catch (error) {
      next(error);
    }
  },
);

adminRatesRouter.post(
  '/withdrawal/update',
  requirePermission('change_currency_configs'),
  async (req, res, next) => {
    try {
      await updateWithdrawalRate(req.auth.userId, req.body);
      res.json({ ok: true, message: 'Withdrawal rates updated successfully' });
    } catch (error) {
      next(error);
    }
  },
);

adminRatesRouter.post(
  '/delete',
  requirePermission('change_currency_configs'),
  async (req, res, next) => {
    try {
      const result = await deleteRate(req.auth.userId, req.body);
      res.json(result);
    } catch (error) {
      next(error);
    }
  },
);

adminRatesRouter.post(
  '/point-withdrawal',
  requirePermission('change_currency_configs'),
  async (req, res, next) => {
    try {
      await addPointWithdrawalRate(req.body);
      res.status(201).json({ ok: true });
    } catch (error) {
      next(error);
    }
  },
);

adminRatesRouter.post(
  '/point-withdrawal/update',
  requirePermission('change_currency_configs'),
  async (req, res, next) => {
    try {
      await updatePointWithdrawalRate(req.body);
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  },
);

adminRatesRouter.post(
  '/point-withdrawal/:pointRateId/delete',
  requirePermission('change_currency_configs'),
  async (req, res, next) => {
    try {
      await deletePointWithdrawalRate(req.params.pointRateId);
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  },
);
