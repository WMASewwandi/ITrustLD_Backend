import { Router } from 'express';
import fs from 'fs/promises';
import { requireAdminAuth } from '../../middleware/requireAdminAuth.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import {
  getCustomerKycDocuments,
  listCustomerAccounts,
  updateCustomerEmail,
  updateCustomerKycVerification,
} from '../../services/customerAccount.service.js';
import {
  guessDocumentMimeType,
  resolveDocumentPath,
} from '../../services/documentStorage.service.js';

export const adminCustomersRouter = Router();

adminCustomersRouter.use(requireAdminAuth);

adminCustomersRouter.get(
  '/',
  requirePermission('read_customer_accounts_data'),
  async (req, res, next) => {
    try {
      const filter = String(req.query.filter || 'pending');
      const search = {
        email: req.query.email?.trim() || undefined,
        account_id: req.query.account_id?.trim() || undefined,
        primary_id: req.query.primary_id?.trim() || undefined,
        first_name: req.query.first_name?.trim() || undefined,
        last_name: req.query.last_name?.trim() || undefined,
      };

      const customers = await listCustomerAccounts(filter, search);
      res.json({ ok: true, customers, filter });
    } catch (error) {
      next(error);
    }
  },
);

adminCustomersRouter.get(
  '/documents/:filename',
  requirePermission('read_customer_accounts_data'),
  async (req, res, next) => {
    try {
      const filePath = resolveDocumentPath(req.params.filename);
      await fs.access(filePath);
      res.type(guessDocumentMimeType(req.params.filename));
      res.sendFile(filePath);
    } catch (error) {
      if (error.code === 'ENOENT') {
        const notFound = new Error('Document not found.');
        notFound.status = 404;
        next(notFound);
        return;
      }
      next(error);
    }
  },
);

adminCustomersRouter.get(
  '/:accountHolderId/kyc-documents',
  requirePermission('read_customer_accounts_data'),
  async (req, res, next) => {
    try {
      const accountHolderId = Number(req.params.accountHolderId);
      if (!Number.isFinite(accountHolderId) || accountHolderId <= 0) {
        return res.status(400).json({ message: 'Invalid customer id.' });
      }

      const field = String(req.query.field || 'nic').toLowerCase();
      const result = await getCustomerKycDocuments(accountHolderId, field);
      res.json({ ok: true, ...result, field });
    } catch (error) {
      next(error);
    }
  },
);

adminCustomersRouter.post(
  '/:accountHolderId/kyc/:field/approve',
  requirePermission('change_customer_account_status'),
  async (req, res, next) => {
    try {
      const accountHolderId = Number(req.params.accountHolderId);
      if (!Number.isFinite(accountHolderId) || accountHolderId <= 0) {
        return res.status(400).json({ message: 'Invalid customer id.' });
      }

      const customer = await updateCustomerKycVerification(
        accountHolderId,
        req.params.field,
        'VERIFIED',
      );
      res.json({ ok: true, customer, message: 'Verification approved.' });
    } catch (error) {
      next(error);
    }
  },
);

adminCustomersRouter.post(
  '/:accountHolderId/kyc/:field/reject',
  requirePermission('change_customer_account_status'),
  async (req, res, next) => {
    try {
      const accountHolderId = Number(req.params.accountHolderId);
      if (!Number.isFinite(accountHolderId) || accountHolderId <= 0) {
        return res.status(400).json({ message: 'Invalid customer id.' });
      }

      const reason = String(req.body?.reason || '').trim();
      if (!reason) {
        return res.status(422).json({ message: 'Rejection reason is required.' });
      }

      const customer = await updateCustomerKycVerification(
        accountHolderId,
        req.params.field,
        'REJECTED',
        { rejectionReason: reason, rejectionMessage: reason },
      );
      res.json({ ok: true, customer, message: 'Verification rejected.' });
    } catch (error) {
      next(error);
    }
  },
);

adminCustomersRouter.patch(
  '/:accountHolderId/email',
  requirePermission('change_customer_account_status'),
  async (req, res, next) => {
    try {
      const accountHolderId = Number(req.params.accountHolderId);
      if (!Number.isFinite(accountHolderId) || accountHolderId <= 0) {
        return res.status(400).json({ message: 'Invalid customer id.' });
      }

      const email = req.body?.email;
      const customer = await updateCustomerEmail(accountHolderId, email);
      res.json({ ok: true, customer });
    } catch (error) {
      next(error);
    }
  },
);
