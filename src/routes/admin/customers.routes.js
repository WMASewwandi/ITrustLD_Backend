import { Router } from 'express';
import fs from 'fs/promises';
import multer from 'multer';
import { requireAdminAuth } from '../../middleware/requireAdminAuth.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import {
  getCustomerKycDocuments,
  listCustomerAccounts,
  updateCustomerAccountStatus,
  updateCustomerEmail,
  updateCustomerKycVerification,
  updateCustomerPartnerStatus,
  updateMultipleCustomerAccountStatus,
} from '../../services/customerAccount.service.js';
import {
  sendEmailToCustomers,
  sendSmsToCustomers,
} from '../../services/customerMessaging.service.js';
import {
  guessDocumentMimeType,
  resolveDocumentPath,
} from '../../services/documentStorage.service.js';

export const adminCustomersRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

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

adminCustomersRouter.post(
  '/ban-multiple',
  requirePermission('change_customer_account_status'),
  async (req, res, next) => {
    try {
      const accountHolderIds = Array.isArray(req.body?.account_holder_ids)
        ? req.body.account_holder_ids
        : [];
      const customers = await updateMultipleCustomerAccountStatus(accountHolderIds, 'BANNED');
      res.json({
        ok: true,
        customers,
        message: `Successfully banned ${customers.length} account(s).`,
      });
    } catch (error) {
      next(error);
    }
  },
);

adminCustomersRouter.post(
  '/email/send',
  requirePermission('comunicatte_to_customer'),
  upload.single('attachment'),
  async (req, res, next) => {
    try {
      const receivers =
        req.body?.receivers ||
        req.body?.['popup-email-receivers'] ||
        req.body?.popup_email_receivers;
      const subject =
        req.body?.subject || req.body?.['popup-email-subject'] || req.body?.popup_email_subject;
      const body =
        req.body?.body || req.body?.['popup-email-body'] || req.body?.popup_email_body;
      const result = await sendEmailToCustomers({
        receivers,
        subject,
        body,
        attachment: req.file,
      });
      res.json(result);
    } catch (error) {
      next(error);
    }
  },
);

adminCustomersRouter.post(
  '/sms/send',
  requirePermission('comunicatte_to_customer'),
  async (req, res, next) => {
    try {
      const mobileNumbers =
        req.body?.mobile_numbers || req.body?.mobileNumbers || req.body?.mobiles;
      const message = req.body?.message;
      const result = await sendSmsToCustomers({
        mobileNumbers,
        message,
        adminUserId: req.auth.userId,
      });
      res.json(result);
    } catch (error) {
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
        { adminUserId: req.auth.userId },
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
        {
          rejectionReason: reason,
          rejectionMessage: reason,
          adminUserId: req.auth.userId,
        },
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

adminCustomersRouter.post(
  '/:accountHolderId/ban',
  requirePermission('change_customer_account_status'),
  async (req, res, next) => {
    try {
      const accountHolderId = Number(req.params.accountHolderId);
      if (!Number.isFinite(accountHolderId) || accountHolderId <= 0) {
        return res.status(400).json({ message: 'Invalid customer id.' });
      }

      const reason = String(req.body?.reason || '').trim();
      const customer = await updateCustomerAccountStatus(accountHolderId, 'BANNED', {
        bannedReason: reason,
      });
      res.json({ ok: true, customer, message: 'Customer banned successfully.' });
    } catch (error) {
      next(error);
    }
  },
);

adminCustomersRouter.post(
  '/:accountHolderId/unban',
  requirePermission('change_customer_account_status'),
  async (req, res, next) => {
    try {
      const accountHolderId = Number(req.params.accountHolderId);
      if (!Number.isFinite(accountHolderId) || accountHolderId <= 0) {
        return res.status(400).json({ message: 'Invalid customer id.' });
      }

      const customer = await updateCustomerAccountStatus(accountHolderId, 'ACTIVE');
      res.json({ ok: true, customer, message: 'Customer unbanned successfully.' });
    } catch (error) {
      next(error);
    }
  },
);

adminCustomersRouter.post(
  '/:accountHolderId/partner',
  requirePermission('change_customer_account_status'),
  async (req, res, next) => {
    try {
      const accountHolderId = Number(req.params.accountHolderId);
      if (!Number.isFinite(accountHolderId) || accountHolderId <= 0) {
        return res.status(400).json({ message: 'Invalid customer id.' });
      }

      const isPartner =
        req.body?.is_partner === true ||
        req.body?.is_partner === 'true' ||
        req.body?.is_partner === 'YES';
      const customer = await updateCustomerPartnerStatus(accountHolderId, isPartner);
      res.json({
        ok: true,
        customer,
        message: `Partner status updated to ${isPartner ? 'Yes' : 'No'}.`,
      });
    } catch (error) {
      next(error);
    }
  },
);
