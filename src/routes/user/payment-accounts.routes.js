import { Router } from 'express';
import { requireUserAuth } from '../../middleware/requireUserAuth.js';
import { requireCustomerAccountsActivity } from '../../middleware/requireCustomerAccountsActivity.js';
import {
  createUserPaymentAccount,
  deleteUserPaymentAccount,
  listUserPaymentAccounts,
  updateUserPaymentAccount,
} from '../../services/userPaymentAccount.service.js';

export const userPaymentAccountsRouter = Router();

userPaymentAccountsRouter.use(requireUserAuth);
userPaymentAccountsRouter.use(requireCustomerAccountsActivity);

userPaymentAccountsRouter.get('/', async (req, res, next) => {
  try {
    const data = await listUserPaymentAccounts(req.auth.userId);
    res.json(data);
  } catch (error) {
    next(error);
  }
});

userPaymentAccountsRouter.post('/', async (req, res, next) => {
  try {
    const data = await createUserPaymentAccount(req.auth.userId, req.body ?? {});
    res.status(data.error ? 422 : 201).json(data);
  } catch (error) {
    next(error);
  }
});

userPaymentAccountsRouter.put('/:accountId', async (req, res, next) => {
  try {
    const data = await updateUserPaymentAccount(req.auth.userId, {
      ...(req.body ?? {}),
      account_id: req.params.accountId,
    });
    res.status(data.error ? 422 : 200).json(data);
  } catch (error) {
    next(error);
  }
});

userPaymentAccountsRouter.delete('/:accountId', async (req, res, next) => {
  try {
    const data = await deleteUserPaymentAccount(req.auth.userId, {
      account_type: req.query.account_type ?? req.query.accountType,
      account_id: req.params.accountId,
    });
    res.status(data.error ? 422 : 200).json(data);
  } catch (error) {
    next(error);
  }
});
