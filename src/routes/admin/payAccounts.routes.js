import { Router } from 'express';
import { requireAdminAuth } from '../../middleware/requireAdminAuth.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import {
  createAccountIdPayAccount,
  createBankAccount,
  createBinanceAccount,
  createWalletAccount,
  deletePayAccount,
  listPayAccounts,
  togglePayAccountStatus,
  updateAccountIdPayAccount,
  updateBankAccount,
  updateBinanceAccount,
  updateWalletAccount,
} from '../../services/payAccount.service.js';

export const adminPayAccountsRouter = Router();

adminPayAccountsRouter.use(requireAdminAuth);

adminPayAccountsRouter.get(
  '/',
  requirePermission('view_account_configs'),
  async (_req, res, next) => {
    try {
      const accounts = await listPayAccounts();
      res.json({ ok: true, ...accounts });
    } catch (error) {
      next(error);
    }
  },
);

adminPayAccountsRouter.post(
  '/bank',
  requirePermission('change_account_configs'),
  async (req, res, next) => {
    try {
      const account = await createBankAccount(req.auth.userId, req.body);
      res.status(201).json({ ok: true, account });
    } catch (error) {
      next(error);
    }
  },
);

adminPayAccountsRouter.post(
  '/bank/:accountId/update',
  requirePermission('change_account_configs'),
  async (req, res, next) => {
    try {
      const account = await updateBankAccount(req.params.accountId, req.auth.userId, req.body);
      res.json({ ok: true, account });
    } catch (error) {
      next(error);
    }
  },
);

adminPayAccountsRouter.post(
  '/skrill',
  requirePermission('change_account_configs'),
  async (req, res, next) => {
    try {
      const account = await createWalletAccount('skrill', req.auth.userId, req.body);
      res.status(201).json({ ok: true, account });
    } catch (error) {
      next(error);
    }
  },
);

adminPayAccountsRouter.post(
  '/skrill/:accountId/update',
  requirePermission('change_account_configs'),
  async (req, res, next) => {
    try {
      const account = await updateWalletAccount('skrill', req.params.accountId, req.auth.userId, req.body);
      res.json({ ok: true, account });
    } catch (error) {
      next(error);
    }
  },
);

adminPayAccountsRouter.post(
  '/neteller',
  requirePermission('change_account_configs'),
  async (req, res, next) => {
    try {
      const account = await createWalletAccount('neteller', req.auth.userId, req.body);
      res.status(201).json({ ok: true, account });
    } catch (error) {
      next(error);
    }
  },
);

adminPayAccountsRouter.post(
  '/neteller/:accountId/update',
  requirePermission('change_account_configs'),
  async (req, res, next) => {
    try {
      const account = await updateWalletAccount(
        'neteller',
        req.params.accountId,
        req.auth.userId,
        req.body,
      );
      res.json({ ok: true, account });
    } catch (error) {
      next(error);
    }
  },
);

adminPayAccountsRouter.post(
  '/binance',
  requirePermission('change_account_configs'),
  async (req, res, next) => {
    try {
      const account = await createBinanceAccount(req.auth.userId, req.body);
      res.status(201).json({ ok: true, account });
    } catch (error) {
      next(error);
    }
  },
);

adminPayAccountsRouter.post(
  '/binance/:accountId/update',
  requirePermission('change_account_configs'),
  async (req, res, next) => {
    try {
      const account = await updateBinanceAccount(req.params.accountId, req.auth.userId, req.body);
      res.json({ ok: true, account });
    } catch (error) {
      next(error);
    }
  },
);

adminPayAccountsRouter.post(
  '/pm',
  requirePermission('change_account_configs'),
  async (req, res, next) => {
    try {
      const account = await createAccountIdPayAccount('pm', req.auth.userId, req.body);
      res.status(201).json({ ok: true, account });
    } catch (error) {
      next(error);
    }
  },
);

adminPayAccountsRouter.post(
  '/pm/:accountId/update',
  requirePermission('change_account_configs'),
  async (req, res, next) => {
    try {
      const account = await updateAccountIdPayAccount(
        'pm',
        req.params.accountId,
        req.auth.userId,
        req.body,
      );
      res.json({ ok: true, account });
    } catch (error) {
      next(error);
    }
  },
);

adminPayAccountsRouter.post(
  '/xm',
  requirePermission('change_account_configs'),
  async (req, res, next) => {
    try {
      const account = await createAccountIdPayAccount('xm', req.auth.userId, req.body);
      res.status(201).json({ ok: true, account });
    } catch (error) {
      next(error);
    }
  },
);

adminPayAccountsRouter.post(
  '/xm/:accountId/update',
  requirePermission('change_account_configs'),
  async (req, res, next) => {
    try {
      const account = await updateAccountIdPayAccount(
        'xm',
        req.params.accountId,
        req.auth.userId,
        req.body,
      );
      res.json({ ok: true, account });
    } catch (error) {
      next(error);
    }
  },
);

adminPayAccountsRouter.post(
  '/:accountType/:accountId/delete',
  requirePermission('change_account_configs'),
  async (req, res, next) => {
    try {
      const result = await deletePayAccount(req.params.accountType, req.params.accountId);
      res.json(result);
    } catch (error) {
      next(error);
    }
  },
);

adminPayAccountsRouter.post(
  '/:accountType/:accountId/toggle-status',
  requirePermission('change_account_configs'),
  async (req, res, next) => {
    try {
      const active =
        req.body?.active === true ||
        req.body?.active === 'true' ||
        req.body?.active === 1 ||
        req.body?.active === '1';
      const account = await togglePayAccountStatus(
        req.params.accountType,
        req.params.accountId,
        active,
      );
      res.json({ ok: true, account });
    } catch (error) {
      next(error);
    }
  },
);
