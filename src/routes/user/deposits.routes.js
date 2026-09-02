import { Router } from 'express';
import multer from 'multer';
import { requireUserAuth } from '../../middleware/requireUserAuth.js';
import { requireCustomerDepositActivity } from '../../middleware/requireCustomerDepositActivity.js';
import {
  createUserDeposit,
  checkGiftVoucherPlatformReuse,
  exportUserDepositTransactions,
  getDepositBootstrap,
  getDepositMethodDetails,
  getDepositPaymentProofContext,
  getUserDepositTransaction,
  listUserDepositTransactions,
  listUserDepositTransactionsForPrint,
  saveDepositPaymentProof,
} from '../../services/userDeposit.service.js';

export const userDepositsRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
});

userDepositsRouter.use(requireUserAuth);
userDepositsRouter.use(requireCustomerDepositActivity);

userDepositsRouter.get('/bootstrap', async (req, res, next) => {
  try {
    const data = await getDepositBootstrap(req.auth.userId);
    res.json(data);
  } catch (error) {
    next(error);
  }
});

userDepositsRouter.get('/method-details', async (req, res, next) => {
  try {
    const data = await getDepositMethodDetails(req.auth.userId, {
      topupMethodId: req.query.topupMethodId ?? req.query.topup_method_id,
      depositAmount: req.query.depositAmount ?? req.query.deposit_amount,
      depositAmountCurrency:
        req.query.depositAmountCurrency ?? req.query.deposit_amount_currency ?? 'USD',
    });
    res.json(data);
  } catch (error) {
    next(error);
  }
});

userDepositsRouter.get('/transactions', async (req, res, next) => {
  try {
    const data = await listUserDepositTransactions(req.auth.userId, req.query);
    res.json(data);
  } catch (error) {
    next(error);
  }
});

userDepositsRouter.get('/transactions/print', async (req, res, next) => {
  try {
    const transactions = await listUserDepositTransactionsForPrint(req.auth.userId, req.query);
    res.json({ transactions });
  } catch (error) {
    next(error);
  }
});

userDepositsRouter.get('/transactions/:transactionId', async (req, res, next) => {
  try {
    const data = await getUserDepositTransaction(req.auth.userId, req.params.transactionId);
    res.json(data);
  } catch (error) {
    next(error);
  }
});

userDepositsRouter.get('/export', async (req, res, next) => {
  try {
    const exported = await exportUserDepositTransactions(req.auth.userId, req.query);
    res.setHeader('Content-Type', exported.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${exported.filename}"`);
    res.send(exported.content);
  } catch (error) {
    next(error);
  }
});

userDepositsRouter.get('/platform-check', async (req, res, next) => {
  try {
    const data = await checkGiftVoucherPlatformReuse(req.auth.userId, {
      paymentOptionId: req.query.paymentOptionId ?? req.query.payment_option_id,
      topupAccountId: req.query.topupAccountId ?? req.query.topup_account_id,
    });
    res.json(data);
  } catch (error) {
    next(error);
  }
});

userDepositsRouter.post('/', async (req, res, next) => {
  try {
    const data = await createUserDeposit(req.auth.userId, req.body ?? {});
    res.status(201).json(data);
  } catch (error) {
    next(error);
  }
});

userDepositsRouter.get('/:depositId/payment-proof', async (req, res, next) => {
  try {
    const data = await getDepositPaymentProofContext(req.auth.userId, req.params.depositId);
    res.json(data);
  } catch (error) {
    next(error);
  }
});

userDepositsRouter.post('/:depositId/proof', upload.single('payment_proof'), async (req, res, next) => {
  try {
    const data = await saveDepositPaymentProof(req.auth.userId, req.params.depositId, req.file);
    res.json(data);
  } catch (error) {
    if (error instanceof multer.MulterError) {
      return res.status(422).json({
        error: true,
        message: 'Payment proof should be less than 2Mb. Kindly reupload.',
      });
    }
    next(error);
  }
});
