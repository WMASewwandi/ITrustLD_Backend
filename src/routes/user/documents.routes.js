import { Router } from 'express';
import { requireUserAuth } from '../../middleware/requireUserAuth.js';
import { getUserVerificationDocuments } from '../../services/userDocuments.service.js';

export const userDocumentsRouter = Router();

userDocumentsRouter.use(requireUserAuth);

userDocumentsRouter.get('/', async (req, res, next) => {
  try {
    const data = await getUserVerificationDocuments(req.auth.userId);
    res.json(data);
  } catch (error) {
    next(error);
  }
});
