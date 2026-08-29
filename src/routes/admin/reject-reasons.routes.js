import { Router } from 'express';
import { requireAdminAuth } from '../../middleware/requireAdminAuth.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import {
  createRejectReason,
  deleteRejectReason,
  listRejectReasons,
  moveRejectReason,
  updateRejectReason,
} from '../../services/rejectReason.service.js';

export const adminRejectReasonsRouter = Router();

adminRejectReasonsRouter.use(requireAdminAuth);

adminRejectReasonsRouter.get('/', async (req, res, next) => {
  try {
    const data = await listRejectReasons(req.query?.category);
    res.json({ ok: true, ...data });
  } catch (error) {
    next(error);
  }
});

adminRejectReasonsRouter.post(
  '/',
  requirePermission('manage_reject_reasons'),
  async (req, res, next) => {
    try {
      const reason = await createRejectReason(req.auth.userId, req.body);
      res.status(201).json({ ok: true, reason });
    } catch (error) {
      next(error);
    }
  },
);

adminRejectReasonsRouter.post(
  '/:id/update',
  requirePermission('manage_reject_reasons'),
  async (req, res, next) => {
    try {
      const reason = await updateRejectReason(req.params.id, req.body);
      res.json({ ok: true, reason });
    } catch (error) {
      next(error);
    }
  },
);

adminRejectReasonsRouter.post(
  '/:id/move',
  requirePermission('manage_reject_reasons'),
  async (req, res, next) => {
    try {
      const reason = await moveRejectReason(req.params.id, req.body?.direction);
      res.json({ ok: true, reason });
    } catch (error) {
      next(error);
    }
  },
);

adminRejectReasonsRouter.post(
  '/:id/delete',
  requirePermission('manage_reject_reasons'),
  async (req, res, next) => {
    try {
      const result = await deleteRejectReason(req.params.id);
      res.json(result);
    } catch (error) {
      next(error);
    }
  },
);
