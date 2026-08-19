import { Router } from 'express';
import { env } from '../../config/env.js';
import { guestHelpTicketRateLimit } from '../../middleware/guestHelpTicketRateLimit.js';
import { optionalUserAuth } from '../../middleware/optionalUserAuth.js';
import { createHelpTicket } from '../../services/helpTicket.service.js';

export const publicHelpTicketsRouter = Router();

publicHelpTicketsRouter.get('/config', (_req, res) => {
  res.json({
    ok: true,
    turnstileRequired: Boolean(env.turnstile.secret),
  });
});

publicHelpTicketsRouter.post('/', optionalUserAuth, guestHelpTicketRateLimit, async (req, res, next) => {
  try {
    const userId = req.auth?.userId ?? null;
    const data = await createHelpTicket(userId, req.body ?? {}, { remoteIp: req.ip });
    res.status(201).json(data);
  } catch (error) {
    next(error);
  }
});
