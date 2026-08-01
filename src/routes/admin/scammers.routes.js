import { Router } from 'express';
import { requireAdminAuth } from '../../middleware/requireAdminAuth.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import {
  addScammer,
  deleteScammer,
  listScammers,
  searchScammerUserByPlatformId,
} from '../../services/scammer.service.js';

export const adminScammersRouter = Router();

adminScammersRouter.use(requireAdminAuth);

adminScammersRouter.get(
  '/',
  requirePermission('read_customer_accounts_data'),
  async (req, res, next) => {
    try {
      const data = await listScammers(req.query);
      res.json(data);
    } catch (error) {
      next(error);
    }
  },
);

adminScammersRouter.post(
  '/search-user',
  requirePermission('read_customer_accounts_data'),
  async (req, res, next) => {
    try {
      const platformId = req.body?.platform_id ?? req.body?.platformId;
      const data = await searchScammerUserByPlatformId(platformId);
      res.json(data);
    } catch (error) {
      next(error);
    }
  },
);

adminScammersRouter.post(
  '/',
  requirePermission('change_customer_account_status'),
  async (req, res, next) => {
    try {
      const data = await addScammer(req.body ?? {});
      res.status(201).json(data);
    } catch (error) {
      next(error);
    }
  },
);

adminScammersRouter.delete(
  '/:id',
  requirePermission('change_customer_account_status'),
  async (req, res, next) => {
    try {
      const data = await deleteScammer(req.params.id);
      res.json(data);
    } catch (error) {
      next(error);
    }
  },
);
