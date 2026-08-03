import { Router } from 'express';
import multer from 'multer';
import { requireUserAuth } from '../middleware/requireUserAuth.js';
import { getUserSession } from '../services/userAuth.service.js';
import {
  getVerificationStep,
  saveVerificationDocuments,
  sendVerificationEmail,
  sendVerificationSms,
  verifyEmailCode,
  verifyMobileCode,
} from '../services/verification.service.js';
import { findAccountHolderByUserId } from '../services/accountHolder.service.js';

export const verificationRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

verificationRouter.use(requireUserAuth);

verificationRouter.get('/status', async (req, res, next) => {
  try {
    const user = await getUserSession(req.auth.userId);
    const accountHolder = await findAccountHolderByUserId(req.auth.userId);
    res.json({
      ok: true,
      step: getVerificationStep(accountHolder),
      user,
    });
  } catch (error) {
    next(error);
  }
});

verificationRouter.post('/send-email', async (req, res, next) => {
  try {
    const { email } = req.body ?? {};
    const result = await sendVerificationEmail(req.auth.userId, email);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

verificationRouter.post('/verify-email', async (req, res, next) => {
  try {
    const { email, verification_code: verificationCode } = req.body ?? {};
    const result = await verifyEmailCode(req.auth.userId, email, verificationCode);
    const user = await getUserSession(req.auth.userId);
    res.json({ ...result, user });
  } catch (error) {
    next(error);
  }
});

verificationRouter.post('/send-sms', async (req, res, next) => {
  try {
    const { mobile_number: mobileNumber } = req.body ?? {};
    const result = await sendVerificationSms(req.auth.userId, mobileNumber);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

verificationRouter.post('/verify-mobile', async (req, res, next) => {
  try {
    const { mobile_number: mobileNumber, verification_code: verificationCode } = req.body ?? {};
    const result = await verifyMobileCode(req.auth.userId, mobileNumber, verificationCode);
    const user = await getUserSession(req.auth.userId);
    res.json({ ...result, user });
  } catch (error) {
    next(error);
  }
});

verificationRouter.post(
  '/documents',
  upload.fields([
    { name: 'identity_document', maxCount: 1 },
    { name: 'identity_document_back', maxCount: 1 },
    { name: 'address_document', maxCount: 1 },
  ]),
  async (req, res, next) => {
    try {
      const identityFile = req.files?.identity_document?.[0] ?? null;
      const identityBackFile = req.files?.identity_document_back?.[0] ?? null;
      const addressFile = req.files?.address_document?.[0] ?? null;
      const result = await saveVerificationDocuments(req.auth.userId, {
        identityDocumentType: req.body?.identity_document_type,
        addressDocumentType: req.body?.address_document_type,
        identityFile,
        identityBackFile,
        addressFile,
      });
      res.json(result);
    } catch (error) {
      if (error instanceof multer.MulterError) {
        const limitError = new Error(
          error.code === 'LIMIT_FILE_SIZE'
            ? 'File size must not exceed 5MB.'
            : error.message,
        );
        limitError.status = 422;
        next(limitError);
        return;
      }
      next(error);
    }
  },
);
