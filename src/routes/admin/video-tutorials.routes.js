import { Router } from 'express';
import { requireAdminAuth } from '../../middleware/requireAdminAuth.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import {
  createVideoTutorial,
  deleteVideoTutorial,
  listVideoTutorialsAdmin,
  updateVideoTutorial,
} from '../../services/videoTutorial.service.js';

export const adminVideoTutorialsRouter = Router();

adminVideoTutorialsRouter.use(requireAdminAuth);

adminVideoTutorialsRouter.get(
  '/',
  requirePermission('manage_blog_posts'),
  async (_req, res, next) => {
    try {
      const data = await listVideoTutorialsAdmin();
      res.json(data);
    } catch (error) {
      next(error);
    }
  },
);

adminVideoTutorialsRouter.post(
  '/',
  requirePermission('manage_blog_posts'),
  async (req, res, next) => {
    try {
      const data = await createVideoTutorial(req.body ?? {});
      res.status(201).json(data);
    } catch (error) {
      next(error);
    }
  },
);

adminVideoTutorialsRouter.post(
  '/:id/update',
  requirePermission('manage_blog_posts'),
  async (req, res, next) => {
    try {
      const data = await updateVideoTutorial(req.params.id, req.body ?? {});
      res.json(data);
    } catch (error) {
      next(error);
    }
  },
);

adminVideoTutorialsRouter.post(
  '/:id/delete',
  requirePermission('manage_blog_posts'),
  async (req, res, next) => {
    try {
      const data = await deleteVideoTutorial(req.params.id);
      res.json(data);
    } catch (error) {
      next(error);
    }
  },
);
