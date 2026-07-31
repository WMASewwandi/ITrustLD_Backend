import { Router } from 'express';
import { requireUserAuth } from '../middleware/requireUserAuth.js';
import { env } from '../config/env.js';
import {
  checkEmailAvailability,
  checkMobileAvailability,
  getUserSession,
  loginUser,
  logoutUser,
  registerUser,
} from '../services/userAuth.service.js';
import {
  requestPasswordReset,
  resetPassword,
} from '../services/passwordReset.service.js';

export const authRouter = Router();

authRouter.get('/config', (_req, res) => {
  res.json({
    ok: true,
    turnstileSiteKey: env.turnstile.siteKey || null,
  });
});

authRouter.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body ?? {};
    const result = await loginUser({ email, password });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

authRouter.post('/register', async (req, res, next) => {
  try {
    const result = await registerUser(req.body ?? {}, { remoteIp: req.ip });
    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

authRouter.post('/check-mobile', async (req, res, next) => {
  try {
    const { mobile_number: mobileNumber } = req.body ?? {};
    const result = await checkMobileAvailability(mobileNumber);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

authRouter.post('/check-email', async (req, res, next) => {
  try {
    const { email } = req.body ?? {};
    const result = await checkEmailAvailability(email);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

authRouter.post('/forgot-password', async (req, res, next) => {
  try {
    const { email } = req.body ?? {};
    const result = await requestPasswordReset(email);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

authRouter.post('/reset-password', async (req, res, next) => {
  try {
    const result = await resetPassword(req.body ?? {});
    res.json(result);
  } catch (error) {
    next(error);
  }
});

authRouter.post('/logout', requireUserAuth, async (req, res, next) => {
  try {
    const result = await logoutUser(req.auth.userId);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

authRouter.get('/me', requireUserAuth, async (req, res, next) => {
  try {
    const user = await getUserSession(req.auth.userId);
    res.json({ ok: true, user });
  } catch (error) {
    next(error);
  }
});
