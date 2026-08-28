import jwt from 'jsonwebtoken';
import { ADMIN_PORTAL_ROLES } from '../constants/adminRoles.js';
import { env } from '../config/env.js';
import {
  findUserByEmail,
  findUserById,
  getUserRoles,
  getUserPermissions,
  isUserActive,
  setUserOnline,
} from './user.service.js';
import { getUserStatusUpdateScope } from './statusUpdateScope.service.js';
import { verifyLaravelPassword } from '../utils/laravelPassword.js';

/**
 * Post-login path in the Next.js admin app.
 * Dashboard when permitted; otherwise the ops home page (not the first queue).
 */
export function resolveAdminRedirect(_roles, permissions = []) {
  if (permissions.includes('view_admin_dashboard')) {
    return '/dashboard';
  }
  return '/home';
}

export function userCanAccessAdminPortal(roles) {
  if (roles.some((role) => ADMIN_PORTAL_ROLES.includes(role))) {
    return true;
  }
  // Allow custom admin roles (any non-customer role can access the portal).
  return roles.some((role) => role !== 'customer');
}

export function toPublicUser(user, roles, permissions = [], statusScope = {}) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    roles,
    permissions,
    shift: user.shift ?? null,
    is_online: Boolean(user.is_online),
    allowed_deposit_statuses: statusScope.allowed_deposit_statuses ?? null,
    allowed_withdrawal_statuses: statusScope.allowed_withdrawal_statuses ?? null,
  };
}

export function signAccessToken(user, roles) {
  return jwt.sign(
    {
      sub: user.id,
      email: user.email,
      roles,
    },
    env.jwtSecret,
    { expiresIn: env.jwtExpiresIn },
  );
}

export function verifyAccessToken(token) {
  return jwt.verify(token, env.jwtSecret);
}

export async function loginAdmin({ email, password }) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail || !password) {
    const error = new Error('Email and password are required.');
    error.status = 422;
    throw error;
  }

  const user = await findUserByEmail(normalizedEmail);
  if (!user) {
    const error = new Error('These credentials do not match our records.');
    error.status = 401;
    throw error;
  }

  const passwordValid = await verifyLaravelPassword(password, user.password);
  if (!passwordValid) {
    const error = new Error('These credentials do not match our records.');
    error.status = 401;
    throw error;
  }

  if (!isUserActive(user)) {
    const error = new Error('This account has been deactivated. Please contact an administrator.');
    error.status = 403;
    throw error;
  }

  const roles = await getUserRoles(user.id);
  if (!userCanAccessAdminPortal(roles)) {
    const error = new Error('This account is not authorized for the admin portal.');
    error.status = 403;
    throw error;
  }

  const permissions = await getUserPermissions(user.id);
  const statusScope = await getUserStatusUpdateScope(user.id);

  await setUserOnline(user.id, true);

  const publicUser = toPublicUser(user, roles, permissions, statusScope);
  const token = signAccessToken(user, roles);
  const redirect_to = resolveAdminRedirect(roles, permissions);

  return {
    ok: true,
    message: 'Login successful.',
    redirect_to,
    token,
    user: publicUser,
  };
}

export async function logoutAdmin(userId) {
  if (userId) {
    await setUserOnline(userId, false);
  }
  return { ok: true };
}

export async function getAdminSession(userId) {
  const user = await findUserById(userId);
  if (!user) {
    const error = new Error('User not found.');
    error.status = 404;
    throw error;
  }

  if (!isUserActive(user)) {
    const error = new Error('This account has been deactivated.');
    error.status = 403;
    throw error;
  }

  const roles = await getUserRoles(userId);
  if (!userCanAccessAdminPortal(roles)) {
    const error = new Error('This account is not authorized for the admin portal.');
    error.status = 403;
    throw error;
  }

  const permissions = await getUserPermissions(userId);
  const statusScope = await getUserStatusUpdateScope(userId);

  return toPublicUser(user, roles, permissions, statusScope);
}
