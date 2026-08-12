import { Router } from 'express';
import multer from 'multer';
import { requireAdminAuth } from '../../middleware/requireAdminAuth.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import {
  createCashoutWallet,
  createTopupWallet,
  deleteCashoutWallet,
  deleteTopupWallet,
  getWalletFormMeta,
  listCashoutWallets,
  listTopupWallets,
  toggleCashoutWalletStatus,
  toggleTopupWalletStatus,
  unhideCashoutWallet,
  unhideTopupWallet,
  updateCashoutWallet,
  updateTopupWallet,
  getTopupWalletById,
  getCashoutWalletById,
} from '../../services/wallet.service.js';

export const adminWalletsRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
});

adminWalletsRouter.use(requireAdminAuth);

adminWalletsRouter.get(
  '/meta',
  requirePermission('view_account_configs'),
  async (_req, res, next) => {
    try {
      const meta = await getWalletFormMeta();
      res.json({ ok: true, ...meta });
    } catch (error) {
      next(error);
    }
  },
);

adminWalletsRouter.get(
  '/topup',
  requirePermission('view_account_configs'),
  async (_req, res, next) => {
    try {
      const wallets = await listTopupWallets();
      res.json({ ok: true, wallets });
    } catch (error) {
      next(error);
    }
  },
);

adminWalletsRouter.get(
  '/cashout',
  requirePermission('view_account_configs'),
  async (_req, res, next) => {
    try {
      const wallets = await listCashoutWallets();
      res.json({ ok: true, wallets });
    } catch (error) {
      next(error);
    }
  },
);

adminWalletsRouter.get(
  '/topup/:walletId',
  requirePermission('view_account_configs'),
  async (req, res, next) => {
    try {
      const wallet = await getTopupWalletById(Number(req.params.walletId));
      if (!wallet) {
        return res.status(404).json({ message: 'Top-up wallet not found.' });
      }
      res.json({ ok: true, wallet });
    } catch (error) {
      next(error);
    }
  },
);

adminWalletsRouter.get(
  '/cashout/:walletId',
  requirePermission('view_account_configs'),
  async (req, res, next) => {
    try {
      const wallet = await getCashoutWalletById(Number(req.params.walletId));
      if (!wallet) {
        return res.status(404).json({ message: 'Cash-out wallet not found.' });
      }
      res.json({ ok: true, wallet });
    } catch (error) {
      next(error);
    }
  },
);

adminWalletsRouter.post(
  '/topup',
  requirePermission('change_account_configs'),
  upload.single('wallet_logo'),
  async (req, res, next) => {
    try {
      const wallet = await createTopupWallet(req.body, req.file ?? null);
      res.status(201).json({ ok: true, wallet });
    } catch (error) {
      next(error);
    }
  },
);

adminWalletsRouter.post(
  '/cashout',
  requirePermission('change_account_configs'),
  upload.single('wallet_logo'),
  async (req, res, next) => {
    try {
      const wallet = await createCashoutWallet(req.body, req.file ?? null);
      res.status(201).json({ ok: true, wallet });
    } catch (error) {
      next(error);
    }
  },
);

adminWalletsRouter.post(
  '/topup/:walletId/update',
  requirePermission('change_account_configs'),
  upload.single('wallet_logo'),
  async (req, res, next) => {
    try {
      const wallet = await updateTopupWallet(Number(req.params.walletId), req.body, req.file ?? null);
      res.json({ ok: true, wallet });
    } catch (error) {
      next(error);
    }
  },
);

adminWalletsRouter.post(
  '/cashout/:walletId/update',
  requirePermission('change_account_configs'),
  upload.single('wallet_logo'),
  async (req, res, next) => {
    try {
      const wallet = await updateCashoutWallet(
        Number(req.params.walletId),
        req.body,
        req.file ?? null,
      );
      res.json({ ok: true, wallet });
    } catch (error) {
      next(error);
    }
  },
);

adminWalletsRouter.post(
  '/topup/:walletId/delete',
  requirePermission('change_account_configs'),
  async (req, res, next) => {
    try {
      const result = await deleteTopupWallet(Number(req.params.walletId));
      res.json(result);
    } catch (error) {
      next(error);
    }
  },
);

adminWalletsRouter.post(
  '/cashout/:walletId/delete',
  requirePermission('change_account_configs'),
  async (req, res, next) => {
    try {
      const result = await deleteCashoutWallet(Number(req.params.walletId));
      res.json(result);
    } catch (error) {
      next(error);
    }
  },
);

adminWalletsRouter.post(
  '/topup/:walletId/unhide',
  requirePermission('change_account_configs'),
  async (req, res, next) => {
    try {
      const wallet = await unhideTopupWallet(Number(req.params.walletId));
      res.json({ ok: true, wallet });
    } catch (error) {
      next(error);
    }
  },
);

adminWalletsRouter.post(
  '/cashout/:walletId/unhide',
  requirePermission('change_account_configs'),
  async (req, res, next) => {
    try {
      const wallet = await unhideCashoutWallet(Number(req.params.walletId));
      res.json({ ok: true, wallet });
    } catch (error) {
      next(error);
    }
  },
);

adminWalletsRouter.post(
  '/topup/:walletId/toggle-status',
  requirePermission('change_account_configs'),
  async (req, res, next) => {
    try {
      const active =
        req.body?.active === true ||
        req.body?.active === 'true' ||
        req.body?.active === 1 ||
        req.body?.active === '1';
      const wallet = await toggleTopupWalletStatus(Number(req.params.walletId), active);
      res.json({ ok: true, wallet });
    } catch (error) {
      next(error);
    }
  },
);

adminWalletsRouter.post(
  '/cashout/:walletId/toggle-status',
  requirePermission('change_account_configs'),
  async (req, res, next) => {
    try {
      const active =
        req.body?.active === true ||
        req.body?.active === 'true' ||
        req.body?.active === 1 ||
        req.body?.active === '1';
      const wallet = await toggleCashoutWalletStatus(Number(req.params.walletId), active);
      res.json({ ok: true, wallet });
    } catch (error) {
      next(error);
    }
  },
);
