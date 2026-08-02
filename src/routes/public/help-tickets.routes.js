import { Router } from 'express';
import { optionalUserAuth } from '../../middleware/optionalUserAuth.js';
import { createHelpTicket } from '../../services/helpTicket.service.js';

export const publicHelpTicketsRouter = Router();

publicHelpTicketsRouter.post('/', optionalUserAuth, async (req, res, next) => {
  try {
    const userId = req.auth?.userId ?? null;
    const data = await createHelpTicket(userId, req.body ?? {});
    res.status(201).json(data);
  } catch (error) {
    next(error);
  }
});
