import crypto from 'node:crypto';
import { query } from '../config/database.js';
import { env } from '../config/env.js';
import { hashLaravelPassword, verifyLaravelPassword } from '../utils/laravelPassword.js';
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

async function assertNotThrottled(normalizedEmail) {
  const rows = await query(
    `SELECT created_at FROM password_reset_tokens WHERE email = ? LIMIT 1`,
    [normalizedEmail],
  );
  const record = rows[0];
  if (!record?.created_at) return;

  const ageSeconds = (Date.now() - new Date(record.created_at).getTime()) / 1000;
  if (ageSeconds < REQUEST_THROTTLE_SECONDS) {
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

  const users = await query(
    `SELECT id, email, name FROM users WHERE email = ? LIMIT 1`,
    [normalizedEmail],
  );
  const user = users[0];
  if (!user) {
    throw validationError('We could not find a user with that email address.', 404);
  }

  await assertNotThrottled(normalizedEmail);

  const plainToken = crypto.randomBytes(32).toString('hex');
  const hashedToken = await hashLaravelPassword(plainToken);

  await query(
    `INSERT INTO password_reset_tokens (email, token, created_at)
     VALUES (?, ?, NOW())
     ON DUPLICATE KEY UPDATE token = VALUES(token), created_at = VALUES(created_at)`,
    [normalizedEmail, hashedToken],
  );

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
    to: normalizedEmail,
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

  const rows = await query(
    `SELECT email, token, created_at FROM password_reset_tokens WHERE email = ? LIMIT 1`,
    [normalizedEmail],
  );
  const record = rows[0];
  if (!record) {
    throw validationError('This password reset token is invalid.');
  }

  const createdAt = new Date(record.created_at);
  const ageMinutes = (Date.now() - createdAt.getTime()) / 60000;
  if (ageMinutes > TOKEN_EXPIRY_MINUTES) {
    await query(`DELETE FROM password_reset_tokens WHERE email = ?`, [normalizedEmail]);
    throw validationError('This password reset token is invalid.');
  }

  const tokenValid = await verifyLaravelPassword(plainToken, record.token);
  if (!tokenValid) {
    throw validationError('This password reset token is invalid.');
  }

  const users = await query(`SELECT id FROM users WHERE email = ? LIMIT 1`, [normalizedEmail]);
  const user = users[0];
  if (!user) {
    throw validationError('We could not find a user with that email address.', 404);
  }

  const hashedPassword = await hashLaravelPassword(nextPassword);
  const rememberToken = crypto.randomBytes(30).toString('hex');

  await query(
    `UPDATE users SET password = ?, remember_token = ?, updated_at = NOW() WHERE id = ?`,
    [hashedPassword, rememberToken, user.id],
  );
  await query(`DELETE FROM password_reset_tokens WHERE email = ?`, [normalizedEmail]);

  return {
    ok: true,
    message: 'Your password has been reset.',
  };
}
