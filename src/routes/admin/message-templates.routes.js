import { Router } from 'express';
import { requireAdminAuth } from '../../middleware/requireAdminAuth.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import {
  createMessageTemplate,
  deleteMessageTemplate,
  duplicateMessageTemplate,
  listMessageTemplatesAdmin,
  toggleMessageTemplateStatus,
} from '../../services/messageTemplate.service.js';

export const adminMessageTemplatesRouter = Router();

adminMessageTemplatesRouter.use(requireAdminAuth);

adminMessageTemplatesRouter.get(
  '/',
  requirePermission('comunicatte_to_customer'),
  async (_req, res, next) => {
    try {
      const data = await listMessageTemplatesAdmin();
      res.json(data);
    } catch (error) {
      next(error);
    }
  },
);

adminMessageTemplatesRouter.post(
  '/',
  requirePermission('comunicatte_to_customer'),
  async (req, res, next) => {
    try {
      const data = await createMessageTemplate(req.auth.userId, req.body);
      res.status(201).json(data);
    } catch (error) {
      next(error);
    }
  },
);

adminMessageTemplatesRouter.post(
  '/:id/toggle-status',
  requirePermission('comunicatte_to_customer'),
  async (req, res, next) => {
    try {
      const data = await toggleMessageTemplateStatus(req.params.id);
      res.json(data);
    } catch (error) {
      next(error);
    }
  },
);

adminMessageTemplatesRouter.post(
  '/:id/duplicate',
  requirePermission('comunicatte_to_customer'),
  async (req, res, next) => {
    try {
      const data = await duplicateMessageTemplate(req.params.id, req.auth.userId);
      res.json(data);
    } catch (error) {
      next(error);
    }
  },
);

adminMessageTemplatesRouter.post(
  '/:id/delete',
  requirePermission('comunicatte_to_customer'),
  async (req, res, next) => {
    try {
      const data = await deleteMessageTemplate(req.params.id);
      res.json(data);
    } catch (error) {
      next(error);
    }
  },
);
