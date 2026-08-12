import { Router } from 'express';
import { requireAdminAuth } from '../../middleware/requireAdminAuth.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import {
  filterDashboardDeposits,
  filterDashboardTransactions,
  filterDashboardWithdrawals,
  getAdminDashboard,
} from '../../services/adminDashboard.service.js';

export const adminDashboardRouter = Router();

adminDashboardRouter.use(requireAdminAuth);

adminDashboardRouter.get(
  '/',
  requirePermission('view_admin_dashboard'),
  async (req, res, next) => {
    try {
      const data = await getAdminDashboard({
        filter: req.query.filter,
        fromDate: req.query.from || req.query.from_date || req.query.fromDate,
        toDate: req.query.to || req.query.to_date || req.query.toDate,
      });
      res.json({ ok: true, ...data });
    } catch (error) {
      next(error);
    }
  },
);

adminDashboardRouter.get(
  '/filter-deposits',
  requirePermission('read_deposit_data'),
  async (req, res, next) => {
    try {
      const total = await filterDashboardDeposits({
        filter: req.query.filter,
        fromDate: req.query.from || req.query.from_date || req.query.fromDate,
        toDate: req.query.to || req.query.to_date || req.query.toDate,
      });
      res.json(total);
    } catch (error) {
      next(error);
    }
  },
);

adminDashboardRouter.get(
  '/filter-withdrawals',
  requirePermission('read_withdrawal_data'),
  async (req, res, next) => {
    try {
      const total = await filterDashboardWithdrawals({
        filter: req.query.filter,
        fromDate: req.query.from || req.query.from_date || req.query.fromDate,
        toDate: req.query.to || req.query.to_date || req.query.toDate,
      });
      res.json(total);
    } catch (error) {
      next(error);
    }
  },
);

adminDashboardRouter.get(
  '/filter-transactions',
  requirePermission('view_admin_dashboard'),
  async (req, res, next) => {
    try {
      const data = await filterDashboardTransactions({
        filter: req.query.filter,
        fromDate: req.query.from || req.query.from_date || req.query.fromDate,
        toDate: req.query.to || req.query.to_date || req.query.toDate,
      });
      res.json(data);
    } catch (error) {
      next(error);
    }
  },
);
