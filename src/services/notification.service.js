import { sendMail } from './mail.service.js';
import { isInternationalSmsConfigured, parseLkMobileNumber, sendDialogSms, sendInternationalSms } from './sms.service.js';
import { resolveEmailContent, resolveSmsContent } from './messageTemplateRuntime.service.js';

const SMS_FOOTER = '\n\nFor more info, please contact us at +94 117 751 751';

export async function sendEmailAndSms({
  email,
  subject,
  html,
  text,
  smsMessage,
  msisdn = null,
  userId = null,
  smsType = 'GENERAL',
}) {
  const mailResult = await sendMail({ to: email, subject, html, text });

  if (smsMessage) {
    const body = `${String(smsMessage).trim()}${SMS_FOOTER}`;
    await sendSms({
      message: body,
      msisdn,
      userId,
      smsType,
    });
  }

  return mailResult;
}

export async function sendTemplatedEmailAndSms({
  email,
  msisdn = null,
  userId = null,
  smsType = 'GENERAL',
  emailKey = null,
  smsKey = null,
  variables = {},
  fallback = {},
}) {
  const emailContent = await resolveEmailContent({
    key: emailKey,
    variables,
    fallback: {
      subject: fallback.subject,
      html: fallback.html,
      text: fallback.text,
    },
  });

  const smsContent = await resolveSmsContent({
    key: smsKey,
    variables,
    fallback: fallback.smsMessage || '',
  });

  if (email) {
    return sendEmailAndSms({
      email,
      subject: emailContent.subject,
      html: emailContent.html,
      text: emailContent.text,
      smsMessage: smsContent.message || null,
      msisdn,
      userId,
      smsType,
    });
  }

  if (smsContent.message && msisdn) {
    await queueSmsMessage({
      message: smsContent.message,
      msisdn,
      userId,
      smsType,
    });
  }

  return { ok: true };
}

export async function sendTemplatedSmsOnly({
  msisdn,
  userId = null,
  smsType = 'GENERAL',
  smsKey = null,
  variables = {},
  fallback = '',
}) {
  const smsContent = await resolveSmsContent({
    key: smsKey,
    variables,
    fallback,
  });

  if (!smsContent.message || !msisdn) {
    return { ok: false };
  }

  await queueSmsMessage({
    message: smsContent.message,
    msisdn,
    userId,
    smsType,
  });
  return { ok: true };
}

export async function queueSmsMessage({ message, msisdn, userId, smsType }) {
  return sendSms({ message, msisdn, userId, smsType });
}

async function sendSms({ message, msisdn, userId, smsType }) {
  if (!msisdn) return;

  const isLk = Boolean(parseLkMobileNumber(msisdn));

  try {
    if (isLk) {
      await sendDialogSms({ message, msisdn, userId, smsType });
      return;
    }

    if (isInternationalSmsConfigured()) {
      await sendInternationalSms({ message, msisdn, userId, smsType });
      return;
    }

    console.info('[sms:skip] International SMS not configured for', msisdn);
  } catch (error) {
    console.error('[sms:error]', error.message);
  }
}
