import { Router } from 'express';
import { requireAdminAuth } from '../../middleware/requireAdminAuth.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import {
  cancelBulkSmsCampaign,
  createBulkSmsCampaign,
  deleteBulkSmsCampaign,
  listBulkSmsCampaignsAdmin,
  resendBulkSmsCampaign,
} from '../../services/bulkSmsCampaign.service.js';

export const adminBulkSmsRouter = Router();

adminBulkSmsRouter.use(requireAdminAuth);

adminBulkSmsRouter.get(
  '/',
  requirePermission('manage_bulk_sms', 'comunicatte_to_customer'),
  async (_req, res, next) => {
    try {
      const data = await listBulkSmsCampaignsAdmin();
      res.json(data);
    } catch (error) {
      next(error);
    }
  },
);

adminBulkSmsRouter.post(
  '/',
  requirePermission('manage_bulk_sms', 'comunicatte_to_customer'),
  async (req, res, next) => {
    try {
      const data = await createBulkSmsCampaign(req.auth.userId, req.body);
      res.status(201).json(data);
    } catch (error) {
      next(error);
    }
  },
);

adminBulkSmsRouter.post(
  '/:id/cancel',
  requirePermission('manage_bulk_sms', 'comunicatte_to_customer'),
  async (req, res, next) => {
    try {
      const data = await cancelBulkSmsCampaign(req.params.id);
      res.json(data);
    } catch (error) {
      next(error);
    }
  },
);

adminBulkSmsRouter.post(
  '/:id/resend',
  requirePermission('manage_bulk_sms', 'comunicatte_to_customer'),
  async (req, res, next) => {
    try {
      const data = await resendBulkSmsCampaign(req.auth.userId, req.params.id);
      res.status(201).json(data);
    } catch (error) {
      next(error);
    }
  },
);

adminBulkSmsRouter.delete(
  '/:id',
  requirePermission('manage_bulk_sms', 'comunicatte_to_customer'),
  async (req, res, next) => {
    try {
      const data = await deleteBulkSmsCampaign(req.params.id);
      res.json(data);
    } catch (error) {
      next(error);
    }
  },
);
