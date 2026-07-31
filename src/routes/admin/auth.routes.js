import { Router } from 'express';
import { requireAdminAuth } from '../../middleware/requireAdminAuth.js';
import {
  getAdminSession,
  loginAdmin,
  logoutAdmin,
} from '../../services/adminAuth.service.js';

export const adminAuthRouter = Router();

adminAuthRouter.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body ?? {};
    const result = await loginAdmin({ email, password });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

adminAuthRouter.post('/logout', requireAdminAuth, async (req, res, next) => {
  try {
    const result = await logoutAdmin(req.auth.userId);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

adminAuthRouter.get('/me', requireAdminAuth, async (req, res, next) => {
  try {
    const user = await getAdminSession(req.auth.userId);
    res.json({ ok: true, user });
  } catch (error) {
    next(error);
  }
});
