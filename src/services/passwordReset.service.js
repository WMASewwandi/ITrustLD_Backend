import crypto from 'node:crypto';
import { query } from '../config/database.js';
import { env } from '../config/env.js';
import { hashLaravelPassword, verifyLaravelPassword } from '../utils/laravelPassword.js';
import { sendMail } from './mail.service.js';
import { passwordResetEmailHtml } from './mail.templates.js';

const TOKEN_EXPIRY_MINUTES = 60;

function validationError(message, status = 422) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

export async function requestPasswordReset(email) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    throw validationError('Enter a valid email address.');
  }

  const users = await query(
    `SELECT id, email, name FROM users WHERE email = ? LIMIT 1`,
    [normalizedEmail],
  );
  const user = users[0];
  if (!user) {
    throw validationError('We could not find a user with that email address.', 404);
  }

  const plainToken = crypto.randomBytes(32).toString('hex');
  const hashedToken = await hashLaravelPassword(plainToken);

  await query(
    `INSERT INTO password_reset_tokens (email, token, created_at)
     VALUES (?, ?, NOW())
     ON DUPLICATE KEY UPDATE token = VALUES(token), created_at = VALUES(created_at)`,
    [normalizedEmail, hashedToken],
  );

  const resetUrl = `${env.userAppUrl}/reset-password?token=${encodeURIComponent(plainToken)}&email=${encodeURIComponent(normalizedEmail)}`;
  const mailResult = await sendMail({
    to: normalizedEmail,
    subject: 'Password reset',
    html: passwordResetEmailHtml(resetUrl),
    text: `Reset your password: ${resetUrl}`,
  });

  return {
    ok: true,
    message: 'We have emailed your password reset link!',
    mail: mailResult,
  };
}

export async function resetPassword({ email, token, password, password_confirmation: passwordConfirmation }) {
  const normalizedEmail = normalizeEmail(email);
  const plainToken = String(token || '').trim();
  const nextPassword = String(password || '');
  const confirmPassword = String(passwordConfirmation || '');

  if (!normalizedEmail || !plainToken) {
    throw validationError('Invalid password reset link.');
  }
  if (!nextPassword || nextPassword.length < 8) {
    throw validationError('Password must be at least 8 characters.');
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
    throw validationError('This password reset link is invalid or has expired.');
  }

  const createdAt = new Date(record.created_at);
  const ageMinutes = (Date.now() - createdAt.getTime()) / 60000;
  if (ageMinutes > TOKEN_EXPIRY_MINUTES) {
    await query(`DELETE FROM password_reset_tokens WHERE email = ?`, [normalizedEmail]);
    throw validationError('This password reset link has expired. Please request a new one.');
  }

  const tokenValid = await verifyLaravelPassword(plainToken, record.token);
  if (!tokenValid) {
    throw validationError('This password reset link is invalid or has expired.');
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
    message: 'Your password has been reset. You can now sign in.',
  };
}
