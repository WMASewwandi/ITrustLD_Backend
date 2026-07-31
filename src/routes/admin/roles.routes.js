import { Router } from 'express';
import { requireAdminAuth } from '../../middleware/requireAdminAuth.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import {
  createRole,
  getAllActivitiesGrouped,
  getAllRoles,
  getRoleWithPermissions,
  syncRolePermissions,
} from '../../services/role.service.js';

export const adminRolesRouter = Router();

adminRolesRouter.use(requireAdminAuth);

adminRolesRouter.get('/', requirePermission('role_manage_activity'), async (_req, res, next) => {
  try {
    const roles = await getAllRoles();
    res.json({ ok: true, roles });
  } catch (error) {
    next(error);
  }
});

adminRolesRouter.get('/activities', requirePermission('role_manage_activity'), async (_req, res, next) => {
  try {
    const categories = await getAllActivitiesGrouped();
    res.json({ ok: true, categories });
  } catch (error) {
    next(error);
  }
});

adminRolesRouter.get('/:roleName', requirePermission('role_manage_activity'), async (req, res, next) => {
  try {
    const role = await getRoleWithPermissions(req.params.roleName);
    if (!role) {
      return res.status(404).json({ message: 'Role not found.' });
    }
    const categories = await getAllActivitiesGrouped();
    res.json({ ok: true, role, categories });
  } catch (error) {
    next(error);
  }
});

adminRolesRouter.post('/', requirePermission('role_manage_activity'), async (req, res, next) => {
  try {
    const role = await createRole({ name: req.body?.name });
    res.status(201).json({ ok: true, role });
  } catch (error) {
    next(error);
  }
});

adminRolesRouter.put(
  '/:roleName/permissions',
  requirePermission('role_manage_activity'),
  async (req, res, next) => {
    try {
      const role = await syncRolePermissions(req.params.roleName, req.body?.permissions);
      res.json({ ok: true, role });
    } catch (error) {
      next(error);
    }
  },
);
