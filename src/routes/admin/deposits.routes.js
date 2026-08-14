import { Router } from 'express';
import { requireAdminAuth } from '../../middleware/requireAdminAuth.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import {
  assignDeposits,
  exportDepositsForAdmin,
  getExecutivesForAssignment,
  updateDepositStatus,
} from '../../services/deposit-actions.service.js';
import {
  getDepositByTransactionId,
  listDepositsForAdmin,
  listSimilarDepositsToday,
} from '../../services/deposit.service.js';
import {
  guessDepositProofMimeType,
  readDepositProofBuffer,
} from '../../services/depositProofStorage.service.js';

export const adminDepositsRouter = Router();

adminDepositsRouter.use(requireAdminAuth);

adminDepositsRouter.get(
  '/',
  requirePermission('read_deposit_data'),
  async (req, res, next) => {
    try {
      const data = await listDepositsForAdmin(req.auth, {
        status: req.query.status,
        page: req.query.page,
        perPage: req.query.per_page || req.query.perPage,
        keyword: req.query.keyword,
        transactionId: req.query.t_id || req.query.transactionId,
        platformId: req.query.p_acc || req.query.platformId,
        userAccount: req.query.u_acc || req.query.userAccount,
        amount: req.query.amount,
        filter: req.query.filter,
        fromDate: req.query.from_date || req.query.fromDate,
        toDate: req.query.to_date || req.query.toDate,
      });
      res.json({ ok: true, ...data });
    } catch (error) {
      next(error);
    }
  },
);

adminDepositsRouter.get(
  '/proof',
  requirePermission('read_deposit_data'),
  async (req, res, next) => {
    try {
      const proofPath = req.query.path;
      if (!proofPath) {
        res.status(400).json({ ok: false, message: 'Proof path is required.' });
        return;
      }

      const buffer = await readDepositProofBuffer(proofPath);
      res.type(guessDepositProofMimeType(proofPath));
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.send(buffer);
    } catch (error) {
      next(error);
    }
  },
);

adminDepositsRouter.get(
  '/export',
  requirePermission('read_deposit_data'),
  async (req, res, next) => {
    try {
      const data = await exportDepositsForAdmin(req.auth, {
        status: req.query.status || 'Pending',
        filter: req.query.filter,
        fromDate: req.query.from_date || req.query.fromDate,
        toDate: req.query.to_date || req.query.toDate,
      });
      res.setHeader('Content-Type', data.contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${data.filename}"`);
      res.send(data.body);
    } catch (error) {
      next(error);
    }
  },
);

adminDepositsRouter.get(
  '/executives',
  requirePermission('read_deposit_data'),
  async (req, res, next) => {
    try {
      const data = await getExecutivesForAssignment();
      res.json(data);
    } catch (error) {
      next(error);
    }
  },
);

adminDepositsRouter.post(
  '/assign',
  requirePermission('status_update_deposit_data'),
  async (req, res, next) => {
    try {
      const data = await assignDeposits(req.auth, {
        depositIds: req.body?.deposit_ids || req.body?.depositIds,
        executiveId: req.body?.executive_id ?? req.body?.executiveId ?? null,
      });
      res.json(data);
    } catch (error) {
      next(error);
    }
  },
);

adminDepositsRouter.post(
  '/status',
  requirePermission('status_update_deposit_data'),
  async (req, res, next) => {
    try {
      const data = await updateDepositStatus(req.auth, {
        depositId: req.body?.deposit_id || req.body?.depositId,
        transactionId: req.body?.transaction_id || req.body?.transactionId,
        status: req.body?.deposit_status || req.body?.status,
        rejectedReason: req.body?.rejected_reason || req.body?.rejectedReason,
        rejectedReasonMessage:
          req.body?.rejected_reason_message || req.body?.rejectedReasonMessage,
      });
      res.json(data);
    } catch (error) {
      next(error);
    }
  },
);

adminDepositsRouter.get(
  '/similar',
  requirePermission('read_deposit_data'),
  async (req, res, next) => {
    try {
      const data = await listSimilarDepositsToday(req.auth, {
        depositId: req.query.deposit_id || req.query.depositId,
        transactionId: req.query.transaction_id || req.query.transactionId,
      });
      res.json({ ok: true, ...data });
    } catch (error) {
      next(error);
    }
  },
);

adminDepositsRouter.get(
  '/:transactionId',
  requirePermission('read_deposit_data'),
  async (req, res, next) => {
    try {
      const deposit = await getDepositByTransactionId(req.auth, req.params.transactionId);
      if (!deposit) {
        res.status(404).json({ ok: false, message: 'Deposit not found.' });
        return;
      }
      res.json({ ok: true, deposit });
    } catch (error) {
      next(error);
    }
  },
);
