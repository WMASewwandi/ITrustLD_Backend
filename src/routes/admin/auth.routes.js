import { Router } from 'express';
import { requireAdminAuth } from '../../middleware/requireAdminAuth.js';
import {
  getAdminSession,
  loginAdmin,
  logoutAdmin,
  markAdminOfflineFromToken,
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

adminAuthRouter.post('/mark-offline', async (req, res) => {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ message: 'Unauthenticated.' });
  }
  try {
    const result = await markAdminOfflineFromToken(token);
    return res.json(result);
  } catch {
    return res.status(401).json({ message: 'Could not mark user offline.' });
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
