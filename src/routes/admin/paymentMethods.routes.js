import { Router } from 'express';
import { requireAdminAuth } from '../../middleware/requireAdminAuth.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import {
  createPaymentMethod,
  deletePaymentMethod,
  getPaymentMethodFormMeta,
  listPaymentMethods,
  setPaymentMethodPriority,
  togglePaymentMethodStatus,
  updatePaymentMethod,
} from '../../services/paymentMethod.service.js';

export const adminPaymentMethodsRouter = Router();

adminPaymentMethodsRouter.use(requireAdminAuth);

adminPaymentMethodsRouter.get(
  '/meta',
  requirePermission('view_account_configs'),
  async (_req, res, next) => {
    try {
      const meta = await getPaymentMethodFormMeta();
      res.json({ ok: true, ...meta });
    } catch (error) {
      next(error);
    }
  },
);

adminPaymentMethodsRouter.get(
  '/',
  requirePermission('view_account_configs'),
  async (_req, res, next) => {
    try {
      const paymentMethods = await listPaymentMethods();
      res.json({ ok: true, paymentMethods });
    } catch (error) {
      next(error);
    }
  },
);

adminPaymentMethodsRouter.post(
  '/',
  requirePermission('change_account_configs'),
  async (req, res, next) => {
    try {
      const paymentMethod = await createPaymentMethod(req.body);
      res.status(201).json({ ok: true, paymentMethod });
    } catch (error) {
      next(error);
    }
  },
);

adminPaymentMethodsRouter.post(
  '/:paymentMethodId/update',
  requirePermission('change_account_configs'),
  async (req, res, next) => {
    try {
      const paymentMethod = await updatePaymentMethod(req.params.paymentMethodId, req.body);
      res.json({ ok: true, paymentMethod });
    } catch (error) {
      next(error);
    }
  },
);

adminPaymentMethodsRouter.post(
  '/:paymentMethodId/delete',
  requirePermission('change_account_configs'),
  async (req, res, next) => {
    try {
      const result = await deletePaymentMethod(req.params.paymentMethodId);
      res.json(result);
    } catch (error) {
      next(error);
    }
  },
);

adminPaymentMethodsRouter.post(
  '/:paymentMethodId/toggle-status',
  requirePermission('change_account_configs'),
  async (req, res, next) => {
    try {
      const active =
        req.body?.active === true ||
        req.body?.active === 'true' ||
        req.body?.active === 1 ||
        req.body?.active === '1';
      const paymentMethod = await togglePaymentMethodStatus(req.params.paymentMethodId, active);
      res.json({ ok: true, paymentMethod });
    } catch (error) {
      next(error);
    }
  },
);

adminPaymentMethodsRouter.post(
  '/:paymentMethodId/set-priority',
  requirePermission('change_account_configs'),
  async (req, res, next) => {
    try {
      const paymentMethods = await setPaymentMethodPriority(req.params.paymentMethodId);
      res.json({ ok: true, paymentMethods });
    } catch (error) {
      next(error);
    }
  },
);
