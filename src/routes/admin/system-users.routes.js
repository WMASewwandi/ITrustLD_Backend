import { Router } from 'express';
import { requireAdminAuth } from '../../middleware/requireAdminAuth.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import {
  createSystemUser,
  findSystemUserById,
  getAllSystemUsers,
  getAssignableRoles,
  updateSystemUser,
} from '../../services/systemUser.service.js';

export const adminSystemUsersRouter = Router();

adminSystemUsersRouter.use(requireAdminAuth);

adminSystemUsersRouter.get(
  '/',
  requirePermission('system_user_manage_activity'),
  async (_req, res, next) => {
    try {
      const [users, assignable_roles] = await Promise.all([
        getAllSystemUsers(),
        getAssignableRoles(),
      ]);
      res.json({ ok: true, users, assignable_roles });
    } catch (error) {
      next(error);
    }
  },
);

adminSystemUsersRouter.post(
  '/',
  requirePermission('system_user_manage_activity'),
  async (req, res, next) => {
    try {
      const user = await createSystemUser(req.body ?? {});
      res.status(201).json({ ok: true, user });
    } catch (error) {
      next(error);
    }
  },
);

adminSystemUsersRouter.get(
  '/:userId',
  requirePermission('system_user_manage_activity'),
  async (req, res, next) => {
    try {
      const user = await findSystemUserById(Number(req.params.userId));
      if (!user) {
        return res.status(404).json({ message: 'User not found.' });
      }
      const assignable_roles = await getAssignableRoles();
      res.json({ ok: true, user, assignable_roles });
    } catch (error) {
      next(error);
    }
  },
);

adminSystemUsersRouter.put(
  '/:userId',
  requirePermission('system_user_manage_activity'),
  async (req, res, next) => {
    try {
      const user = await updateSystemUser(Number(req.params.userId), req.body ?? {});
      res.json({ ok: true, user });
    } catch (error) {
      next(error);
    }
  },
);
