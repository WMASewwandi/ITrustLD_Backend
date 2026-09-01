import { query } from '../config/database.js';
import { formatYmdColombo, parseDbDateTime } from '../utils/slTime.js';
import {
  findAccountHolderByEmail,
  findAccountHolderByMobile,
  findAccountHolderByUserId,
  isAccountBanned,
  toPublicAccountHolder,
} from './accountHolder.service.js';
import { findUserByEmail, findUserById } from './user.service.js';

function validationError(message, status = 422) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function normalizeYmd(value) {
  if (!value) return '';
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  const date = parseDbDateTime(value);
  if (!date) return text;
  return formatYmdColombo(date);
}

function isFullyVerified(accountHolder) {
  if (!accountHolder) return false;
  return (
    accountHolder.email_verification === 'VERIFIED' &&
    accountHolder.mobile_number_verification === 'VERIFIED' &&
    accountHolder.identity_verification === 'VERIFIED' &&
    accountHolder.address_verification === 'VERIFIED'
  );
}

async function getTrustPointSummary(userId) {
  const [earnedRows, withdrawnRows] = await Promise.all([
    query(
      `SELECT COALESCE(SUM(point_earning_amount), 0) AS total
       FROM point_earnings
       WHERE user_id = ?`,
      [userId],
    ),
    query(
      `SELECT COALESCE(SUM(point_withdrawal_amount), 0) AS total
       FROM point_withdrawals
       WHERE user_id = ?
         AND (status IS NULL OR status != 'Rejected')`,
      [userId],
    ),
  ]);

  const earned = Number(earnedRows[0]?.total || 0);
  const withdrawn = Number(withdrawnRows[0]?.total || 0);

  return {
    earned,
    withdrawn,
    remaining: earned - withdrawn,
  };
}

async function countPaymentAccounts(userId) {
  const rows = await query(
    `SELECT COUNT(*) AS total
     FROM user_payment_options
     WHERE user_id = ?
       AND (is_deleted = 0 OR is_deleted IS NULL OR is_deleted = FALSE)`,
    [userId],
  );
  return Number(rows[0]?.total || 0);
}

async function assertProfileAccess(userId) {
  const accountHolder = await findAccountHolderByUserId(userId);
  if (!accountHolder) {
    throw validationError('Account holder not found.', 404);
  }
  if (isAccountBanned(accountHolder)) {
    throw validationError('Your account has been banned. Please contact support.', 403);
  }
  return accountHolder;
}

export async function getUserProfile(userId) {
  const accountHolder = await assertProfileAccess(userId);
  const user = await findUserById(userId);
  if (!user) {
    throw validationError('User not found.', 404);
  }

  const [trustPoints, paymentAccountsCount] = await Promise.all([
    getTrustPointSummary(userId),
    countPaymentAccounts(userId),
  ]);

  const publicHolder = toPublicAccountHolder(accountHolder);
  if (publicHolder) {
    publicHolder.date_of_birth = normalizeYmd(publicHolder.date_of_birth);
  }

  return {
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
    },
    account_holder: publicHolder,
    trust_points: trustPoints,
    payment_accounts_count: paymentAccountsCount,
    is_fully_verified: isFullyVerified(accountHolder),
  };
}

function requireField(value, label) {
  const text = String(value ?? '').trim();
  if (!text) {
    throw validationError(`${label} is required.`);
  }
  return text;
}

function isOldEnough(dateOfBirth, minAge = 10) {
  const dob = new Date(normalizeYmd(dateOfBirth));
  if (Number.isNaN(dob.getTime())) return false;
  const today = new Date();
  let age = today.getFullYear() - dob.getFullYear();
  const monthDiff = today.getMonth() - dob.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < dob.getDate())) {
    age -= 1;
  }
  return age >= minAge;
}

export async function updateUserProfile(userId, payload = {}) {
  const accountHolder = await assertProfileAccess(userId);
  const user = await findUserById(userId);
  if (!user) {
    throw validationError('User not found.', 404);
  }

  const firstName = requireField(payload.first_name ?? payload.firstName, 'First name');
  const lastName = requireField(payload.last_name ?? payload.lastName, 'Last name');
  const language = requireField(payload.language, 'Preferred language');
  const email = requireField(payload.email, 'Email').toLowerCase();
  const mobileNumber = requireField(payload.mobile_number ?? payload.mobileNumber, 'Mobile number');
  const dateOfBirth = normalizeYmd(payload.date_of_birth ?? payload.dateOfBirth);
  const addressNumber = requireField(payload.address_number ?? payload.addressNumber, 'Residential address/no');
  const street = requireField(payload.street, 'Street');
  const country = requireField(payload.country, 'Country');
  const city = requireField(payload.city, 'City');
  const zipCode = requireField(payload.zip_code ?? payload.zipCode, 'Zip code');

  if (!email.includes('@')) {
    throw validationError('A valid email address is required.');
  }
  if (!isOldEnough(dateOfBirth, 10)) {
    throw validationError('Users below 10 years are not allowed.');
  }

  if (email !== String(accountHolder.email || '').toLowerCase()) {
    const duplicateUser = await findUserByEmail(email);
    if (duplicateUser && duplicateUser.id !== userId) {
      throw validationError('This email is already registered.');
    }
    const duplicateHolder = await findAccountHolderByEmail(email);
    if (duplicateHolder && duplicateHolder.user_id !== userId) {
      throw validationError('This email is already registered.');
    }
  }

  if (mobileNumber !== String(accountHolder.mobile_number || '').trim()) {
    const duplicateMobile = await findAccountHolderByMobile(mobileNumber, userId);
    if (duplicateMobile) {
      throw validationError('This mobile number is already registered.');
    }
  }

  const holderUpdates = {};
  const userUpdates = {};

  if (email !== String(accountHolder.email || '').toLowerCase()) {
    holderUpdates.email = email;
    holderUpdates.email_verification = 'NOT_VERIFIED';
    userUpdates.email = email;
    userUpdates.email_verified_at = null;
  }

  if (mobileNumber !== String(accountHolder.mobile_number || '').trim()) {
    holderUpdates.mobile_number = mobileNumber;
    holderUpdates.mobile_number_verification = 'NOT_VERIFIED';
  }

  const identityChanged =
    firstName !== String(accountHolder.first_name || '').trim() ||
    lastName !== String(accountHolder.last_name || '').trim() ||
    normalizeYmd(accountHolder.date_of_birth) !== dateOfBirth;

  if (identityChanged) {
    holderUpdates.first_name = firstName;
    holderUpdates.last_name = lastName;
    holderUpdates.date_of_birth = dateOfBirth;
    holderUpdates.identity_verification = 'NOT_VERIFIED';
    userUpdates.name = `${firstName} ${lastName}`.trim();
  }

  const addressChanged =
    addressNumber !== String(accountHolder.address_number || '').trim() ||
    street !== String(accountHolder.street || '').trim() ||
    city !== String(accountHolder.city || '').trim() ||
    country !== String(accountHolder.country || '').trim() ||
    zipCode !== String(accountHolder.zip_code || '').trim();

  if (addressChanged) {
    holderUpdates.address_number = addressNumber;
    holderUpdates.street = street;
    holderUpdates.city = city;
    holderUpdates.country = country;
    holderUpdates.zip_code = zipCode;
    holderUpdates.address_verification = 'NOT_VERIFIED';
  }

  if (language !== String(accountHolder.language || '').trim()) {
    holderUpdates.language = language;
  }

  if (Object.keys(holderUpdates).length > 0) {
    const columns = Object.keys(holderUpdates);
    const values = columns.map((key) => holderUpdates[key]);
    await query(
      `UPDATE account_holders
       SET ${columns.map((column) => `${column} = ?`).join(', ')}, updated_at = NOW()
       WHERE user_id = ?`,
      [...values, userId],
    );
  }

  if (Object.keys(userUpdates).length > 0) {
    const columns = Object.keys(userUpdates);
    const values = columns.map((key) => userUpdates[key]);
    await query(
      `UPDATE users
       SET ${columns.map((column) => `${column} = ?`).join(', ')}, updated_at = NOW()
       WHERE id = ?`,
      [...values, userId],
    );
  }

  return getUserProfile(userId);
}
