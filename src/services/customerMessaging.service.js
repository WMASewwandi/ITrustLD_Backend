import { sendMail } from './mail.service.js';
import { adminContactEmailHtml } from './mail.templates.js';
import { queueSmsMessage } from './notification.service.js';

function validationError(message, status = 422) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function parseEmailList(value) {
  return String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseMobileList(value) {
  return String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export async function sendEmailToCustomers({
  receivers,
  subject,
  body,
  attachment,
}) {
  const emails = parseEmailList(receivers);
  const emailSubject = String(subject || '').trim();
  const emailBody = String(body || '').trim();

  if (!emails.length) {
    throw validationError('At least one recipient email is required.');
  }
  if (!emailSubject) {
    throw validationError('Email subject is required.');
  }
  if (!emailBody) {
    throw validationError('Email body is required.');
  }

  const invalid = emails.filter((email) => !isValidEmail(email));
  if (invalid.length) {
    throw validationError(`Invalid email address: ${invalid[0]}`);
  }

  const html = adminContactEmailHtml(emailBody);
  const attachments = attachment
    ? [
        {
          filename: attachment.originalname || 'attachment',
          content: attachment.buffer,
          contentType: attachment.mimetype,
        },
      ]
    : undefined;

  let successCount = 0;
  let failureCount = 0;

  for (const email of emails) {
    try {
      await sendMail({
        to: email,
        subject: emailSubject,
        html,
        text: emailBody,
        attachments,
      });
      successCount += 1;
    } catch (error) {
      console.error('[admin-email] failed for', email, error.message);
      failureCount += 1;
    }
  }

  if (successCount === 0) {
    throw validationError(
      'None of the emails sent successfully. Please check the validity of the email addresses.',
      500,
    );
  }

  const message =
    emails.length === 1
      ? `Email sent successfully to ${emails[0]}`
      : `Emails sent to multiple users. Success: ${successCount}, Failure: ${failureCount}`;

  return { ok: true, message, successCount, failureCount };
}

export async function sendSmsToCustomers({ mobileNumbers, message, adminUserId = null }) {
  const numbers = parseMobileList(mobileNumbers);
  const smsBody = String(message || '').trim();

  if (!numbers.length) {
    throw validationError('At least one mobile number is required.');
  }
  if (!smsBody) {
    throw validationError('SMS message is required.');
  }

  for (const msisdn of numbers) {
    await queueSmsMessage({
      message: smsBody,
      msisdn,
      userId: adminUserId,
      smsType: 'ADMIN_BULK',
    });
  }

  return {
    ok: true,
    message: `SMS sent to ${numbers.length} number(s).`,
    count: numbers.length,
  };
}
