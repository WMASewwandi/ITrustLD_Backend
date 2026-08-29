import { signAccessToken } from './adminAuth.service.js';
import {
  createAccountHolder,
  findAccountHolderByEmail,
  findAccountHolderByMobile,
  findAccountHolderByUserId,
  findPartnerByAffiliateCode,
  generateAccountNumber,
  isAccountBanned,
  linkPartnerClient,
  needsVerification,
  toPublicAccountHolder,
} from './accountHolder.service.js';
import {
  findUserByEmail,
  findUserById,
  getUserRoles,
  isUserActive,
  setUserOnline,
} from './user.service.js';
import { hashLaravelPassword, verifyLaravelPassword } from '../utils/laravelPassword.js';
import { query } from '../config/database.js';
import { LARAVEL_USER_MODEL } from '../constants/adminRoles.js';
import { sendRegistrationEmails } from './verification.service.js';
import { sendEmailAndSms } from './notification.service.js';
import { newClientJoinedEmailHtml } from './mail.templates.js';
import { isTurnstileRequired, verifyTurnstileToken } from './turnstile.service.js';
import { env } from '../config/env.js';
import { getUserAccountSummary, resolveUserType } from './userSummary.service.js';

const CUSTOMER_ROLE = 'customer';

function validationError(message, status = 422) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export function userCanAccessUserPortal(roles) {
  return roles.includes(CUSTOMER_ROLE);
}

export function resolveUserRedirect(accountHolder) {
  if (isAccountBanned(accountHolder)) {
    return '/banned';
  }
  if (needsVerification(accountHolder)) {
    return '/verify';
  }
  return '/dashboard';
}

export function toPublicUser(user, roles, accountHolder) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    roles,
    email_verified_at: user.email_verified_at ?? null,
    account_holder: toPublicAccountHolder(accountHolder),
    accountId: accountHolder?.account_number ?? null,
  };
}

async function assignCustomerRole(userId) {
  const roles = await query(
    `SELECT id FROM roles WHERE name = ? AND guard_name = 'web' LIMIT 1`,
    [CUSTOMER_ROLE],
  );
  const roleId = roles[0]?.id;
  if (!roleId) {
    throw validationError('Customer role is not configured in the system.');
  }

  await query(
    `INSERT INTO model_has_roles (role_id, model_type, model_id)
     VALUES (?, ?, ?)`,
    [roleId, LARAVEL_USER_MODEL, userId],
  );
}

async function cleanupOrphanCustomerUser(email) {
  const user = await findUserByEmail(email);
  if (!user) return;

  const roles = await getUserRoles(user.id);
  const accountHolder = await findAccountHolderByUserId(user.id);

  if (roles.includes(CUSTOMER_ROLE) && !accountHolder) {
    await query('DELETE FROM model_has_roles WHERE model_id = ? AND model_type = ?', [
      user.id,
      LARAVEL_USER_MODEL,
    ]);
    await query('DELETE FROM users WHERE id = ?', [user.id]);
  }
}

export async function checkEmailAvailability(email) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail) {
    throw validationError('Email is required.');
  }

  await cleanupOrphanCustomerUser(normalizedEmail);

  const user = await findUserByEmail(normalizedEmail);
  return { exists: Boolean(user) };
}

export async function checkMobileAvailability(mobileNumber) {
  const mobile = String(mobileNumber || '').trim();
  if (!mobile) {
    throw validationError('Mobile number is required.');
  }

  const accountHolder = await findAccountHolderByMobile(mobile);
  return { exists: Boolean(accountHolder) };
}

async function notifyPartnerNewClient(partnerAccountHolder, clientAccountHolder) {
  try {
    const partnerUser = await findUserById(partnerAccountHolder.user_id);
    if (!partnerUser) return;

    const clientsUrl = `${env.userAppUrl}/dashboard/loyalty/my-clients`;
    await sendEmailAndSms({
      email: partnerUser.email,
      subject: 'New client joined',
      html: newClientJoinedEmailHtml(clientsUrl),
      smsMessage: 'A new client has joined with you! Check your dashboard to view details.',
      msisdn: partnerAccountHolder.mobile_number,
      userId: partnerUser.id,
      smsType: 'NEW_CLIENT_JOINED',
    });
  } catch (error) {
    console.error('[register] partner notification failed:', error.message);
  }
}

export async function registerUser(payload, { remoteIp } = {}) {
  const firstName = String(payload.first_name || payload.firstName || '').trim();
  const lastName = String(payload.last_name || payload.lastName || '').trim();
  const email = String(payload.email || '').trim().toLowerCase();
  const password = String(payload.password || '');
  const passwordConfirmation = String(
    payload.password_confirmation || payload.passwordConfirmation || '',
  );
  const language = String(payload.language || 'English').trim();
  const mobileNumber = String(payload.mobile_number || payload.mobileNumber || '').trim();
  const dateOfBirth = payload.date_of_birth || payload.dateOfBirth || null;
  const addressNumber = String(payload.address_number || payload.addressNumber || '').trim();
  const street = String(payload.street || '').trim();
  const city = String(payload.city || '').trim();
  const country = String(payload.country || '').trim();
  const zipCode = String(payload.zip_code || payload.zipCode || '').trim();
  const affiliateCode = String(payload.affiliate_code || payload.affiliateCode || '').trim();
  const isAffiliated = payload.is_affiliated === true || payload.is_affiliated === 'true' || Boolean(affiliateCode);

  if (!firstName || !lastName) {
    throw validationError('First name and last name are required.');
  }
  if (!email || !email.includes('@')) {
    throw validationError('A valid email address is required.');
  }
  if (!password || password.length < 8) {
    throw validationError('Password must be at least 8 characters.');
  }
  if (password !== passwordConfirmation) {
    throw validationError('Password confirmation does not match.');
  }

  const turnstileToken =
    payload.cf_turnstile_response ||
    payload['cf-turnstile-response'] ||
    payload.turnstile_token;
  if (isTurnstileRequired()) {
    const valid = await verifyTurnstileToken(turnstileToken, remoteIp);
    if (!valid) {
      throw validationError('You failed to verify that you are not a robot.');
    }
  }

  if (mobileNumber) {
    const mobileDuplicate = await findAccountHolderByMobile(mobileNumber);
    if (mobileDuplicate) {
      throw validationError('This mobile number is already registered.');
    }
  }

  await cleanupOrphanCustomerUser(email);

  const existing = await findUserByEmail(email);
  if (existing) {
    throw validationError('This email is already registered.');
  }

  const hashedPassword = await hashLaravelPassword(password);
  const fullName = `${firstName} ${lastName}`.trim();

  const insertUser = await query(
    `INSERT INTO users (name, email, password, is_active, is_online, created_at, updated_at)
     VALUES (?, ?, ?, 1, 0, NOW(), NOW())`,
    [fullName, email, hashedPassword],
  );
  const userId = insertUser.insertId ?? insertUser.lastInsertRowid;

  await assignCustomerRole(userId);

  const accountNumber = generateAccountNumber(userId);
  const accountHolderId = await createAccountHolder({
    userId,
    firstName,
    lastName,
    email,
    language,
    mobileNumber,
    dateOfBirth,
    addressNumber,
    street,
    city,
    country,
    zipCode,
    accountNumber,
  });

  if (isAffiliated && affiliateCode) {
    const partner = await findPartnerByAffiliateCode(affiliateCode);
    if (partner) {
      await linkPartnerClient(partner.id, accountHolderId);
      const clientAccountHolder = await findAccountHolderByUserId(userId);
      await notifyPartnerNewClient(partner, clientAccountHolder);
    }
  }

  const user = await findUserById(userId);
  const roles = await getUserRoles(userId);
  const accountHolder = await findAccountHolderByUserId(userId);

  await sendRegistrationEmails(user, accountHolder);

  await setUserOnline(userId, true);

  const publicUser = toPublicUser(user, roles, accountHolder);
  const token = signAccessToken(user, roles);
  const redirect_to = resolveUserRedirect(accountHolder);

  return {
    ok: true,
    message: 'Registration successful.',
    redirect_to,
    token,
    user: publicUser,
  };
}

export async function loginUser({ email, password }) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail || !password) {
    throw validationError('Email and password are required.');
  }

  const user = await findUserByEmail(normalizedEmail);
  if (!user) {
    throw validationError('These credentials do not match our records.', 401);
  }

  const passwordValid = await verifyLaravelPassword(password, user.password);
  if (!passwordValid) {
    throw validationError('These credentials do not match our records.', 401);
  }

  if (!isUserActive(user)) {
    throw validationError('This account has been deactivated. Please contact support.', 403);
  }

  const roles = await getUserRoles(user.id);
  if (!userCanAccessUserPortal(roles)) {
    throw validationError('This account is not authorized for the user portal.', 403);
  }

  const accountHolder = await findAccountHolderByUserId(user.id);
  if (isAccountBanned(accountHolder)) {
    throw validationError('Your account has been banned. Please contact support.', 403);
  }

  await setUserOnline(user.id, true);

  const publicUser = toPublicUser(user, roles, accountHolder);
  const summary = await getUserAccountSummary(user.id);
  const token = signAccessToken(user, roles);
  const redirect_to = resolveUserRedirect(accountHolder);

  return {
    ok: true,
    message: 'Login successful.',
    redirect_to,
    token,
    user: {
      ...publicUser,
      user_type: resolveUserType(accountHolder),
      ...summary,
    },
  };
}

export async function logoutUser(userId) {
  if (userId) {
    await setUserOnline(userId, false);
  }
  return { ok: true };
}

export async function getUserSession(userId, options = {}) {
  const user = await findUserById(userId);
  if (!user) {
    throw validationError('User not found.', 404);
  }

  if (!isUserActive(user)) {
    throw validationError('This account has been deactivated.', 403);
  }

  const roles = await getUserRoles(userId);
  if (!userCanAccessUserPortal(roles)) {
    throw validationError('This account is not authorized for the user portal.', 403);
  }

  const accountHolder = options.accountHolder ?? (await findAccountHolderByUserId(userId));
  if (isAccountBanned(accountHolder)) {
    throw validationError('Your account has been banned.', 403);
  }

  const publicUser = toPublicUser(user, roles, accountHolder);
  const summary = options.skipSummary ? null : await getUserAccountSummary(userId);

  return {
    ...publicUser,
    user_type: resolveUserType(accountHolder),
    ...(summary || {}),
  };
}
