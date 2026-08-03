import { Router } from 'express';
import { requireAdminAuth } from '../../middleware/requireAdminAuth.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import {
  createCurrencyType,
  deleteCurrencyType,
  listCurrencyTypes,
  toggleCurrencyTypeStatus,
  updateCurrencyType,
} from '../../services/currencyType.service.js';

export const adminCurrencyTypesRouter = Router();

adminCurrencyTypesRouter.use(requireAdminAuth);

adminCurrencyTypesRouter.get(
  '/',
  requirePermission('view_account_configs'),
  async (_req, res, next) => {
    try {
      const currencyTypes = await listCurrencyTypes();
      res.json({ ok: true, currencyTypes });
    } catch (error) {
      next(error);
    }
  },
);

adminCurrencyTypesRouter.post(
  '/',
  requirePermission('change_account_configs'),
  async (req, res, next) => {
    try {
      const currencyType = await createCurrencyType(req.auth.userId, req.body);
      res.status(201).json({ ok: true, currencyType });
    } catch (error) {
      next(error);
    }
  },
);

adminCurrencyTypesRouter.post(
  '/:currencyTypeId/update',
  requirePermission('change_account_configs'),
  async (req, res, next) => {
    try {
      const currencyType = await updateCurrencyType(
        req.params.currencyTypeId,
        req.auth.userId,
        req.body,
      );
      res.json({ ok: true, currencyType });
    } catch (error) {
      next(error);
    }
  },
);

adminCurrencyTypesRouter.post(
  '/:currencyTypeId/delete',
  requirePermission('change_account_configs'),
  async (req, res, next) => {
    try {
      const result = await deleteCurrencyType(req.params.currencyTypeId);
      res.json(result);
    } catch (error) {
      next(error);
    }
  },
);

adminCurrencyTypesRouter.post(
  '/:currencyTypeId/toggle-status',
  requirePermission('change_account_configs'),
  async (req, res, next) => {
    try {
      const active =
        req.body?.active === true ||
        req.body?.active === 'true' ||
        req.body?.active === 1 ||
        req.body?.active === '1';
      const currencyType = await toggleCurrencyTypeStatus(req.params.currencyTypeId, active);
      res.json({ ok: true, currencyType });
    } catch (error) {
      next(error);
    }
  },
);
