import { Router } from 'express';
import { requireUserAuth } from '../../middleware/requireUserAuth.js';
import { getUserProfile, updateUserProfile } from '../../services/userProfile.service.js';
import { getUserRoles, findUserById } from '../../services/user.service.js';
import { findAccountHolderByUserId } from '../../services/accountHolder.service.js';
import { toPublicUser } from '../../services/userAuth.service.js';
import { getUserAccountSummary } from '../../services/userSummary.service.js';
import { resolveUserType } from '../../services/userSummary.service.js';

export const userProfileRouter = Router();

userProfileRouter.use(requireUserAuth);

userProfileRouter.get('/', async (req, res, next) => {
  try {
    const data = await getUserProfile(req.auth.userId);
    res.json(data);
  } catch (error) {
    next(error);
  }
});

userProfileRouter.put('/', async (req, res, next) => {
  try {
    const data = await updateUserProfile(req.auth.userId, req.body ?? {});
    const user = await findUserById(req.auth.userId);
    const roles = await getUserRoles(req.auth.userId);
    const accountHolder = await findAccountHolderByUserId(req.auth.userId);
    const summary = await getUserAccountSummary(req.auth.userId);

    res.json({
      ok: true,
      message: 'Profile updated successfully.',
      profile: data,
      user: {
        ...toPublicUser(user, roles, accountHolder),
        user_type: resolveUserType(accountHolder),
        ...summary,
      },
    });
  } catch (error) {
    next(error);
  }
});
