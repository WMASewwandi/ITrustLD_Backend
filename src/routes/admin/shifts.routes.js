import { Router } from 'express';
import { requireAdminAuth } from '../../middleware/requireAdminAuth.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { getShiftCalendar, updateShiftSchedule } from '../../services/shiftManagement.service.js';
import { getColomboDateParts } from '../../utils/slTime.js';

export const adminShiftsRouter = Router();

adminShiftsRouter.use(requireAdminAuth);

adminShiftsRouter.get(
  '/calendar',
  requirePermission('system_user_manage_activity'),
  async (req, res, next) => {
    try {
      const parts = getColomboDateParts();
      const year = Number(req.query.year) || parts.year;
      const month = Number(req.query.month) || parts.month;
      const calendar = await getShiftCalendar({ year, month });
      res.json({ ok: true, calendar });
    } catch (error) {
      next(error);
    }
  },
);

adminShiftsRouter.patch(
  '/schedule',
  requirePermission('system_user_manage_activity'),
  async (req, res, next) => {
    try {
      const shiftDate = req.body?.shift_date ?? req.body?.shiftDate;
      const activeShift = req.body?.active_shift ?? req.body?.activeShift;
      const result = await updateShiftSchedule({ shiftDate, activeShift });
      res.json({ ok: true, schedule: result });
    } catch (error) {
      next(error);
    }
  },
);
