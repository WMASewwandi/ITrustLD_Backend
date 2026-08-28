import { Router } from 'express';
import { requireAdminAuth } from '../../middleware/requireAdminAuth.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import {
  assignWithdrawals,
  exportWithdrawalsForAdmin,
  getAuthorizersForWithdrawalAssignment,
  getExecutivesForWithdrawalAssignment,
  updateWithdrawalStatus,
} from '../../services/withdrawal-actions.service.js';
import {
  getWithdrawalByTransactionId,
  listSimilarWithdrawalsToday,
  listWithdrawalsForAdmin,
} from '../../services/withdrawal.service.js';
import {
  guessWithdrawalProofMimeType,
  readWithdrawalProofBuffer,
} from '../../services/withdrawalProofStorage.service.js';

export const adminWithdrawalsRouter = Router();

adminWithdrawalsRouter.use(requireAdminAuth);

adminWithdrawalsRouter.get(
  '/',
  requirePermission('read_withdrawal_data', 'authorize_withdrawal_data'),
  async (req, res, next) => {
    try {
      const data = await listWithdrawalsForAdmin(req.auth, {
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

adminWithdrawalsRouter.get(
  '/proof',
  requirePermission('read_withdrawal_data'),
  async (req, res, next) => {
    try {
      const proofPath = req.query.path;
      if (!proofPath) {
        res.status(400).json({ ok: false, message: 'Proof path is required.' });
        return;
      }

      const buffer = await readWithdrawalProofBuffer(proofPath);
      res.type(guessWithdrawalProofMimeType(proofPath));
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.send(buffer);
    } catch (error) {
      next(error);
    }
  },
);

adminWithdrawalsRouter.get(
  '/export',
  requirePermission('read_withdrawal_data'),
  async (req, res, next) => {
    try {
      const data = await exportWithdrawalsForAdmin(req.auth, {
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

adminWithdrawalsRouter.get(
  '/executives',
  requirePermission('read_withdrawal_data'),
  async (req, res, next) => {
    try {
      const data =
        req.query.queue === 'pending-authorization'
          ? await getAuthorizersForWithdrawalAssignment()
          : await getExecutivesForWithdrawalAssignment();
      res.json(data);
    } catch (error) {
      next(error);
    }
  },
);

adminWithdrawalsRouter.post(
  '/assign',
  requirePermission('status_update_withdrawal_data'),
  async (req, res, next) => {
    try {
      const data = await assignWithdrawals(req.auth, {
        withdrawalIds: req.body?.withdrawal_ids || req.body?.withdrawalIds,
        executiveId: req.body?.executive_id ?? req.body?.executiveId ?? null,
      });
      res.json(data);
    } catch (error) {
      next(error);
    }
  },
);

adminWithdrawalsRouter.post(
  '/status',
  requirePermission('status_update_withdrawal_data', 'authorize_withdrawal_data'),
  async (req, res, next) => {
    try {
      const data = await updateWithdrawalStatus(req.auth, {
        withdrawalId: req.body?.withdrawal_id || req.body?.withdrawalId,
        transactionId: req.body?.transaction_id || req.body?.transactionId,
        status: req.body?.withdrawal_status || req.body?.status,
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

adminWithdrawalsRouter.get(
  '/similar',
  requirePermission('read_withdrawal_data'),
  async (req, res, next) => {
    try {
      const data = await listSimilarWithdrawalsToday(req.auth, {
        withdrawalId: req.query.withdrawal_id || req.query.withdrawalId,
        transactionId: req.query.transaction_id || req.query.transactionId,
      });
      res.json({ ok: true, ...data });
    } catch (error) {
      next(error);
    }
  },
);

adminWithdrawalsRouter.get(
  '/:transactionId',
  requirePermission('read_withdrawal_data'),
  async (req, res, next) => {
    try {
      const withdrawal = await getWithdrawalByTransactionId(req.auth, req.params.transactionId);
      if (!withdrawal) {
        res.status(404).json({ ok: false, message: 'Withdrawal not found.' });
        return;
      }
      res.json({ ok: true, withdrawal });
    } catch (error) {
      next(error);
    }
  },
);
