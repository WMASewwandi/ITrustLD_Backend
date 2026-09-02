import crypto from 'node:crypto';
import { query } from '../config/database.js';
import { env } from '../config/env.js';
import { hashLaravelPassword, verifyLaravelPassword } from '../utils/laravelPassword.js';
import { nowSqlDateTime, parseDbDateTime } from '../utils/slTime.js';
import { isStrongPassword, STRONG_PASSWORD_MESSAGE } from '../utils/passwordPolicy.js';
import { sendMail } from './mail.service.js';
import { passwordResetEmailHtml } from './mail.templates.js';
import { resolveEmailContent } from './messageTemplateRuntime.service.js';
import { MESSAGE_TEMPLATE_KEYS } from './messageTemplateKeys.js';

const TOKEN_EXPIRY_MINUTES = 60;
const REQUEST_THROTTLE_SECONDS = 60;

function validationError(message, status = 422) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function buildResetUrl(plainToken, normalizedEmail) {
  return `${env.userAppUrl}/reset-password/${encodeURIComponent(plainToken)}?email=${encodeURIComponent(normalizedEmail)}`;
}

function hashResetTokenSha256(plainToken) {
  return crypto.createHash('sha256').update(String(plainToken)).digest('hex');
}

async function verifyResetToken(plainToken, stored) {
  const storedHash = String(stored || '').trim();
  if (!plainToken || !storedHash) return false;

  if (storedHash.startsWith('$2y$') || storedHash.startsWith('$2a$') || storedHash.startsWith('$2b$')) {
    return verifyLaravelPassword(plainToken, storedHash);
  }

  const sha256 = hashResetTokenSha256(plainToken);
  const left = Buffer.from(sha256, 'utf8');
  const right = Buffer.from(storedHash, 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

async function findUserByEmail(normalizedEmail) {
  const rows = await query(
    `SELECT id, email, name FROM users WHERE LOWER(TRIM(email)) = ? LIMIT 1`,
    [normalizedEmail],
  );
  return rows[0] || null;
}

async function findResetRecord(normalizedEmail) {
  const rows = await query(
    `SELECT email, token, created_at FROM password_reset_tokens WHERE LOWER(TRIM(email)) = ? LIMIT 1`,
    [normalizedEmail],
  );
  return rows[0] || null;
}

async function deleteResetRecord(normalizedEmail, storedEmail = null) {
  if (storedEmail) {
    await query(`DELETE FROM password_reset_tokens WHERE email = ? OR LOWER(TRIM(email)) = ?`, [
      storedEmail,
      normalizedEmail,
    ]);
    return;
  }
  await query(`DELETE FROM password_reset_tokens WHERE LOWER(TRIM(email)) = ?`, [normalizedEmail]);
}

function tokenAgeMinutes(createdAtRaw) {
  const createdAt = parseDbDateTime(createdAtRaw);
  if (!createdAt) return Infinity;
  return (Date.now() - createdAt.getTime()) / 60000;
}

async function assertNotThrottled(normalizedEmail) {
  const record = await findResetRecord(normalizedEmail);
  if (!record?.created_at) return;

  const ageSeconds = tokenAgeMinutes(record.created_at) * 60;
  if (ageSeconds >= 0 && ageSeconds < REQUEST_THROTTLE_SECONDS) {
    throw validationError(
      'Too many password reset attempts. Please wait before trying again.',
      429,
    );
  }
}

export async function requestPasswordReset(email) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    throw validationError('Please enter a valid email address.');
  }

  const user = await findUserByEmail(normalizedEmail);
  if (!user) {
    throw validationError('We could not find a user with that email address.', 404);
  }

  await assertNotThrottled(normalizedEmail);

  const plainToken = crypto.randomBytes(32).toString('hex');
  const hashedToken = hashResetTokenSha256(plainToken);
  const createdAt = nowSqlDateTime();
  const existing = await findResetRecord(normalizedEmail);

  if (existing?.email) {
    await query(`UPDATE password_reset_tokens SET token = ?, created_at = ? WHERE email = ?`, [
      hashedToken,
      createdAt,
      existing.email,
    ]);
  } else {
    await query(
      `INSERT INTO password_reset_tokens (email, token, created_at)
       VALUES (?, ?, ?)`,
      [normalizedEmail, hashedToken, createdAt],
    );
  }

  const resetUrl = buildResetUrl(plainToken, normalizedEmail);
  const emailContent = await resolveEmailContent({
    key: MESSAGE_TEMPLATE_KEYS.PASSWORD_RESET_EMAIL,
    variables: { reset_url: resetUrl },
    fallback: {
      subject: 'Password reset',
      html: passwordResetEmailHtml(resetUrl),
      text: `Reset your password: ${resetUrl}`,
    },
  });
  await sendMail({
    to: user.email || normalizedEmail,
    subject: emailContent.subject,
    html: emailContent.html,
    text: emailContent.text,
  });

  return {
    ok: true,
    message: 'We have emailed your password reset link!',
  };
}

export async function resetPassword({ email, token, password, password_confirmation: passwordConfirmation }) {
  const normalizedEmail = normalizeEmail(email);
  const plainToken = String(token || '').trim();
  const nextPassword = String(password || '');
  const confirmPassword = String(passwordConfirmation || '');

  if (!normalizedEmail || !plainToken) {
    throw validationError('This password reset token is invalid.');
  }
  if (!nextPassword || !isStrongPassword(nextPassword)) {
    throw validationError(STRONG_PASSWORD_MESSAGE);
  }
  if (nextPassword !== confirmPassword) {
    throw validationError('Password confirmation does not match.');
  }

  const record = await findResetRecord(normalizedEmail);
  if (!record) {
    throw validationError('This password reset token is invalid.');
  }

  const ageMinutes = tokenAgeMinutes(record.created_at);
  if (ageMinutes > TOKEN_EXPIRY_MINUTES) {
    await deleteResetRecord(normalizedEmail, record.email);
    throw validationError('This password reset link has expired. Request a new one.');
  }

  const tokenValid = await verifyResetToken(plainToken, record.token);
  if (!tokenValid) {
    throw validationError('This password reset token is invalid.');
  }

  const user = await findUserByEmail(normalizedEmail);
  if (!user) {
    throw validationError('We could not find a user with that email address.', 404);
  }

  const hashedPassword = await hashLaravelPassword(nextPassword);
  const rememberToken = crypto.randomBytes(30).toString('hex');

  await query(
    `UPDATE users SET password = ?, remember_token = ?, updated_at = ? WHERE id = ?`,
    [hashedPassword, rememberToken, nowSqlDateTime(), user.id],
  );
  await deleteResetRecord(normalizedEmail, record.email);

  return {
    ok: true,
    message: 'Your password has been reset.',
  };
}
