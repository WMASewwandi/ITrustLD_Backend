import nodemailer from 'nodemailer';
import { env } from '../config/env.js';
import { getEmailLogoAttachments } from './mail.templates.js';

let smtpTransporter;
let localTransporter;

function buildFrom() {
  const name = env.mail.fromName.replace(/\$\{APP_NAME\}/g, 'iTrustLD');
  return `"${name}" <${env.mail.fromAddress}>`;
}

function getSmtpTransporter() {
  if (!smtpTransporter) {
    smtpTransporter = nodemailer.createTransport({
      host: env.mail.host,
      port: env.mail.port,
      secure: env.mail.secure,
      requireTLS: env.mail.requireTls,
      auth: env.mail.user ? { user: env.mail.user, pass: env.mail.pass } : undefined,
      connectionTimeout: 8000,
      greetingTimeout: 8000,
    });
  }
  return smtpTransporter;
}

/** Mailpit / MailHog — typical Laravel local dev on 127.0.0.1:2525 */
function getLocalTransporter() {
  if (!localTransporter) {
    localTransporter = nodemailer.createTransport({
      host: env.mail.host || '127.0.0.1',
      port: env.mail.port || 2525,
      secure: false,
      tls: { rejectUnauthorized: false },
    });
  }
  return localTransporter;
}

function extractCodePreview(html = '') {
  const match = String(html).match(/letter-spacing:4px[^>]*>(\d{4,8})</);
  return match?.[1] || null;
}

async function deliver(transport, payload) {
  await transport.sendMail(payload);
}

export async function sendMail({ to, subject, html, text, attachments }) {
  const logoAttachments = getEmailLogoAttachments();
  const allAttachments = [...logoAttachments, ...(attachments || [])];
  const payload = {
    from: buildFrom(),
    to,
    subject,
    html,
    text: text || undefined,
    attachments: allAttachments.length ? allAttachments : undefined,
  };

  const hasSmtpCredentials = Boolean(env.mail.user && env.mail.pass);
  const useRealSmtp = !env.mail.logOnly || env.mail.forceSmtp || hasSmtpCredentials;

  if (useRealSmtp) {
    try {
      await deliver(getSmtpTransporter(), payload);
      console.info('[mail:sent]', { to, subject, via: 'smtp' });
      return { ok: true, delivered: true, via: 'smtp' };
    } catch (error) {
      console.error('[mail:smtp failed]', error.message);
      if (!env.mail.logOnly) {
        throw error;
      }
    }
  }

  // Laravel MAIL_MAILER=log — try local Mailpit/MailHog before console-only fallback
  try {
    await deliver(getLocalTransporter(), payload);
    console.info('[mail:sent]', {
      to,
      subject,
      via: 'local-catcher',
      hint: `Open http://${env.mail.host === '127.0.0.1' ? 'localhost' : env.mail.host}:8025 to read the email`,
    });
    return { ok: true, delivered: true, via: 'local-catcher', code: extractCodePreview(html) };
  } catch (error) {
    const code = extractCodePreview(html);
    console.warn('[mail:local-catcher unavailable]', error.message);
    console.info('[mail:log]', {
      to,
      subject,
      code: code || '(see html)',
      text: text || undefined,
      hint: 'Start Mailpit/MailHog on port 2525, or set MAIL_MAILER=smtp with real credentials in ITrustLD_Existing/.env',
    });
    return { ok: true, logged: true, code, via: 'console' };
  }
}
