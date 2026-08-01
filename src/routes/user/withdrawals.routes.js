import { Router } from 'express';
import multer from 'multer';
import { requireUserAuth } from '../../middleware/requireUserAuth.js';
import { requireCustomerWithdrawalActivity } from '../../middleware/requireCustomerWithdrawalActivity.js';
import {
  createUserWithdrawal,
  exportUserWithdrawalTransactions,
  getWithdrawalBootstrap,
  getWithdrawalMethodDetails,
  getWithdrawalPaymentProofContext,
  getUserWithdrawalTransaction,
  listUserWithdrawalTransactions,
  listUserWithdrawalTransactionsForPrint,
  saveWithdrawalPaymentProof,
} from '../../services/userWithdrawal.service.js';

export const userWithdrawalsRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
});

userWithdrawalsRouter.use(requireUserAuth);
userWithdrawalsRouter.use(requireCustomerWithdrawalActivity);

userWithdrawalsRouter.get('/bootstrap', async (req, res, next) => {
  try {
    const data = await getWithdrawalBootstrap(req.auth.userId);
    res.json(data);
  } catch (error) {
    next(error);
  }
});

userWithdrawalsRouter.get('/method-details', async (req, res, next) => {
  try {
    const data = await getWithdrawalMethodDetails(req.auth.userId, {
      cashoutMethodId: req.query.cashoutMethodId ?? req.query.cashout_method_id,
      cashoutAmount: req.query.cashoutAmount ?? req.query.cashout_amount,
      cashoutAmountCurrency:
        req.query.cashoutAmountCurrency ?? req.query.cashout_amount_currency ?? 'USD',
    });
    res.json(data);
  } catch (error) {
    next(error);
  }
});

userWithdrawalsRouter.get('/transactions', async (req, res, next) => {
  try {
    const data = await listUserWithdrawalTransactions(req.auth.userId, req.query);
    res.json(data);
  } catch (error) {
    next(error);
  }
});

userWithdrawalsRouter.get('/transactions/print', async (req, res, next) => {
  try {
    const transactions = await listUserWithdrawalTransactionsForPrint(req.auth.userId, req.query);
    res.json({ transactions });
  } catch (error) {
    next(error);
  }
});

userWithdrawalsRouter.get('/transactions/:transactionId', async (req, res, next) => {
  try {
    const data = await getUserWithdrawalTransaction(req.auth.userId, req.params.transactionId);
    res.json(data);
  } catch (error) {
    next(error);
  }
});

userWithdrawalsRouter.get('/export', async (req, res, next) => {
  try {
    const exported = await exportUserWithdrawalTransactions(req.auth.userId);
    res.setHeader('Content-Type', exported.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${exported.filename}"`);
    res.send(exported.content);
  } catch (error) {
    next(error);
  }
});

userWithdrawalsRouter.post('/', async (req, res, next) => {
  try {
    const data = await createUserWithdrawal(req.auth.userId, req.body ?? {});
    res.status(201).json(data);
  } catch (error) {
    next(error);
  }
});

userWithdrawalsRouter.get('/:withdrawalId/payment-proof', async (req, res, next) => {
  try {
    const data = await getWithdrawalPaymentProofContext(req.auth.userId, req.params.withdrawalId);
    res.json(data);
  } catch (error) {
    next(error);
  }
});

userWithdrawalsRouter.post(
  '/:withdrawalId/proof',
  upload.single('payment_proof'),
  async (req, res, next) => {
    try {
      const data = await saveWithdrawalPaymentProof(
        req.auth.userId,
        req.params.withdrawalId,
        req.file,
        req.body ?? {},
      );
      res.json(data);
    } catch (error) {
      if (error instanceof multer.MulterError) {
        return res.status(422).json({
          error: true,
          message: 'Payment proof photo should be less than 2Mb. Kindly reupload.',
        });
      }
      next(error);
    }
  },
);
