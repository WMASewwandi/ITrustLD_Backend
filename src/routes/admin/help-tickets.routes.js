import { Router } from 'express';
import { requireAdminAuth } from '../../middleware/requireAdminAuth.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import {
  getHelpTicketById,
  listHelpTickets,
  markAllHelpTicketsRead,
  markHelpTicketRead,
  replyToHelpTicket,
} from '../../services/helpTicket.service.js';

export const adminHelpTicketsRouter = Router();

adminHelpTicketsRouter.use(requireAdminAuth);

adminHelpTicketsRouter.get(
  '/',
  requirePermission('read_customer_accounts_data'),
  async (req, res, next) => {
    try {
      const data = await listHelpTickets(req.query ?? {});
      res.json(data);
    } catch (error) {
      next(error);
    }
  },
);

adminHelpTicketsRouter.patch(
  '/read-all',
  requirePermission('read_customer_accounts_data'),
  async (req, res, next) => {
    try {
      const data = await markAllHelpTicketsRead();
      res.json(data);
    } catch (error) {
      next(error);
    }
  },
);

adminHelpTicketsRouter.get(
  '/:id',
  requirePermission('read_customer_accounts_data'),
  async (req, res, next) => {
    try {
      const data = await getHelpTicketById(req.params.id);
      res.json(data);
    } catch (error) {
      next(error);
    }
  },
);

adminHelpTicketsRouter.patch(
  '/:id/read',
  requirePermission('read_customer_accounts_data'),
  async (req, res, next) => {
    try {
      const data = await markHelpTicketRead(req.params.id);
      res.json(data);
    } catch (error) {
      next(error);
    }
  },
);

adminHelpTicketsRouter.post(
  '/:id/reply',
  requirePermission('read_customer_accounts_data'),
  async (req, res, next) => {
    try {
      const data = await replyToHelpTicket(req.params.id, req.body ?? {});
      res.json(data);
    } catch (error) {
      next(error);
    }
  },
);
