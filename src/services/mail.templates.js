import fs from 'node:fs';
import path from 'node:path';
import { formatCustomerRejectReason } from '../constants/rejectReasons.js';
import { env } from '../config/env.js';
import { getColomboDateParts, parseDbDateTime } from '../utils/slTime.js';

const EMAIL_ASSET_DIR = path.join(env.projectRoot, 'assets/email');
const EMAIL_INLINE_ASSETS = [
  ['light.png', 'itrustld-logo-light'],
  ['dark.png', 'itrustld-logo-dark'],
  ['icon-email.png', 'itrustld-icon-email'],
  ['icon-support.png', 'itrustld-icon-support'],
  ['icon-chat.png', 'itrustld-icon-chat'],
  ['icon-facebook.png', 'itrustld-icon-facebook'],
  ['icon-whatsapp.png', 'itrustld-icon-whatsapp'],
  ['icon-youtube.png', 'itrustld-icon-youtube'],
];

/** Inline CID images so Gmail/Outlook do not depend on localhost URLs. */
export function getEmailLogoAttachments() {
  return EMAIL_INLINE_ASSETS.flatMap(([filename, cid]) => {
    const filePath = path.join(EMAIL_ASSET_DIR, filename);
    if (!fs.existsSync(filePath)) return [];
    return [{ filename, path: filePath, cid, contentDisposition: 'inline' }];
  });
}

/**
 * Global email chrome — used by every template via wrap().
 * Light + dark (prefers-color-scheme). Inner template copy is unchanged.
 */
function header() {
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td class="logo-cell" align="center" style="padding:10px 12px 16px;text-align:center;">
          <img
            class="logo-light"
            src="cid:itrustld-logo-light"
            width="180"
            height="44"
            alt="iTrustLD"
            style="display:inline-block;height:auto;max-width:180px;border:0;outline:none;text-decoration:none;"
          />
          <!--[if !mso]><!-->
          <img
            class="logo-dark"
            src="cid:itrustld-logo-dark"
            width="180"
            height="44"
            alt="iTrustLD"
            style="display:none;height:0;width:0;max-height:0;max-width:0;overflow:hidden;border:0;outline:none;text-decoration:none;mso-hide:all;"
          />
          <!--<![endif]-->
        </td>
      </tr>
    </table>`;
}

function footer(extra = '') {
  const supportUrl = 'https://www.itrustld.com/support';
  const termsUrl = 'https://www.itrustld.com/terms-and-conditions';
  const extraBlock = extra
    ? `<div class="email-end-extra" style="padding:8px 8px 0;text-align:left;">${extra}</div>`
    : '';
  const iconLink = (href, cid, alt) => `
    <a href="${href}" style="display:inline-block;text-decoration:none;border:0;">
      <img src="cid:${cid}" width="28" height="28" alt="${alt}" style="display:block;border:0;outline:none;text-decoration:none;" />
    </a>`;
  const socialLink = (href, cid, alt) => `
    <a href="${href}" style="display:inline-block;text-decoration:none;border:0;">
      <img src="cid:${cid}" width="32" height="32" alt="${alt}" style="display:block;border:0;outline:none;text-decoration:none;" />
    </a>`;
  return `
    ${extraBlock}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:8px;">
      <tr>
        <td style="padding:8px 8px 0;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr><td height="1" style="height:1px;line-height:1px;font-size:1px;background-color:#e5e7eb;">&nbsp;</td></tr>
          </table>
        </td>
      </tr>
      <tr>
        <td align="center" style="padding:28px 8px 20px;text-align:center;">
          <p class="end-heading" style="font-family:Poppins,Arial,sans-serif;font-size:18px;font-weight:700;line-height:26px;color:#111827;margin:0 0 8px;">Need assistance?</p>
          <p class="email-muted" style="font-family:Poppins,Arial,sans-serif;font-size:14px;line-height:22px;color:#6b7280;margin:0 0 20px;">
            For any questions, check out our <a class="end-link" href="${supportUrl}" style="color:#0f766e;text-decoration:underline;">Help Center</a>, or get in touch via email or live chat.
          </p>
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center">
            <tr>
              <td align="center" style="padding:0 14px;">${iconLink('mailto:support@itrustld.com', 'itrustld-icon-email', 'Email')}</td>
              <td align="center" style="padding:0 14px;">${iconLink('tel:+94117751751', 'itrustld-icon-support', 'Support')}</td>
              <td align="center" style="padding:0 14px;">${iconLink(supportUrl, 'itrustld-icon-chat', 'Live chat')}</td>
            </tr>
          </table>
        </td>
      </tr>
      <tr>
        <td align="center" style="padding:0 8px 20px;text-align:center;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr><td height="1" style="height:1px;line-height:1px;font-size:1px;background-color:#e5e7eb;">&nbsp;</td></tr>
          </table>
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin-top:20px;">
            <tr>
              <td align="center" style="padding:0 8px;">${socialLink('https://facebook.com/SNXcompany', 'itrustld-icon-facebook', 'Facebook')}</td>
              <td align="center" style="padding:0 8px;">${socialLink('https://whatsapp.com/channel/0029Va4BZjl47Xe8lo429m2K', 'itrustld-icon-whatsapp', 'WhatsApp')}</td>
              <td align="center" style="padding:0 8px;">${socialLink('https://youtube.com/@itrustld_official', 'itrustld-icon-youtube', 'YouTube')}</td>
            </tr>
          </table>
        </td>
      </tr>
      <tr>
        <td class="end-legal" align="left" style="padding:0 8px 8px;text-align:left;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr><td height="1" style="height:1px;line-height:1px;font-size:1px;background-color:#e5e7eb;">&nbsp;</td></tr>
          </table>
          <p style="font-family:Poppins,Arial,sans-serif;font-size:12px;line-height:20px;color:#6b7280;margin:20px 0 12px;">
            Our Terms of Use govern the opening, use, and closure of your iTrustLD Account and related payment services. Together with any other referenced terms and conditions, they constitute the agreement between you and iTrustLD.
          </p>
          <p style="font-family:Poppins,Arial,sans-serif;font-size:12px;line-height:20px;color:#6b7280;margin:0 0 12px;">
            iTrustLD electronic money accounts are not considered bank accounts. By accepting these Terms of Use, you acknowledge that Sri Lanka&#39;s Financial Services Compensation Scheme does not cover your iTrustLD Account.
          </p>
          <p style="font-family:Poppins,Arial,sans-serif;font-size:12px;line-height:20px;color:#6b7280;margin:0;">
            ITrustLD provides one-time merchant services only. Please read our <a class="end-link" href="${termsUrl}" style="color:#0f766e;text-decoration:underline;">T&amp;C</a> before using our services.
          </p>
        </td>
      </tr>
    </table>`;
}

function wrap(content, footerExtra = '') {
  const ref = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>iTrustLD</title>
  <style>
    :root { color-scheme: light dark; }
    .logo-light { display: inline-block !important; }
    .logo-dark { display: none !important; max-height: 0 !important; max-width: 0 !important; overflow: hidden !important; }
    @media (prefers-color-scheme: light) {
      .logo-light { display: inline-block !important; max-height: none !important; max-width: 180px !important; overflow: visible !important; }
      .logo-dark { display: none !important; max-height: 0 !important; max-width: 0 !important; overflow: hidden !important; }
    }
    @media (prefers-color-scheme: dark) {
      .logo-light { display: none !important; max-height: 0 !important; max-width: 0 !important; overflow: hidden !important; }
      .logo-dark { display: inline-block !important; height: auto !important; width: 180px !important; max-height: none !important; max-width: 180px !important; overflow: visible !important; }
      .email-bg { background-color: #111111 !important; }
      .email-card { background-color: transparent !important; }
      .email-card h1,
      .email-card h2,
      .email-card h3,
      .email-card p,
      .email-card td,
      .email-card div,
      .email-card span,
      .email-card strong,
      .email-card li { color: #f3f4f6 !important; }
      .email-muted,
      .email-end-extra p,
      .end-legal p { color: #9ca3af !important; }
      .end-heading { color: #ffffff !important; }
      .end-link { color: #86efac !important; }
      .email-card a[style*="background"] { color: #ffffff !important; }
      .logo-cell { background-color: transparent !important; }
    }
    [data-ogsc] .email-bg { background-color: #111111 !important; }
    [data-ogsc] .email-card { background-color: transparent !important; }
    [data-ogsc] .email-card h1,
    [data-ogsc] .email-card p,
    [data-ogsc] .email-card td,
    [data-ogsc] .email-card div { color: #f3f4f6 !important; }
    [data-ogsc] .email-muted { color: #9ca3af !important; }
    [data-ogsc] .end-heading { color: #ffffff !important; }
    [data-ogsc] .logo-light,
    [data-ogsb] .logo-light { display: none !important; max-height: 0 !important; max-width: 0 !important; overflow: hidden !important; }
    [data-ogsc] .logo-dark,
    [data-ogsb] .logo-dark { display: inline-block !important; height: auto !important; width: 180px !important; max-height: none !important; max-width: 180px !important; overflow: visible !important; }
  </style>
</head>
<body class="email-bg" style="margin:0;padding:0;font-family:Poppins,Arial,sans-serif;background-color:#f8f8f8;">
  <div class="email-bg" style="padding:40px 16px;background-color:#f8f8f8;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;margin:0 auto;">
      <tr>
        <td>
      ${header()}
        </td>
      </tr>
      <tr>
        <td style="padding:0 8px 8px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr><td height="1" style="height:1px;line-height:1px;font-size:1px;background-color:#e5e7eb;">&nbsp;</td></tr>
          </table>
        </td>
      </tr>
      <tr>
        <td class="email-card" style="background-color:transparent;text-align:left;">
        ${content}
      ${footer(footerExtra)}
          <div style="font-size:1px;line-height:1px;color:#f8f8f8;">${ref}</div>
        </td>
      </tr>
    </table>
  </div>
</body>
</html>`;
}

export function welcomeEmailHtml(userName) {
  const firstName = String(userName || 'there').split(' ')[0];
  return wrap(`
    <div style="padding:40px 30px;">
      <h1 style="font-size:24px;color:#0E1726;">Welcome ${firstName}!</h1>
      <p style="font-size:16px;line-height:25px;color:#0E1726;">
        We're thrilled to have you join the iTrustLD community. Your registration was successful, and you're now part of a network committed to secure and seamless transactions.
      </p>
      <p style="font-size:16px;line-height:25px;color:#0E1726;margin-top:24px;">
        Next, verify your identity to secure your account and unlock deposits and withdrawals.
      </p>
    </div>`);
}

export function verifyAccountEmailHtml(verificationUrl) {
  return wrap(`
    <div style="padding:40px 30px;text-align:left;">
      <h1 style="font-size:24px;color:#1a1a1a;">Verify Your Account</h1>
      <p style="font-size:16px;line-height:25px;color:#4b5563;">
        Welcome to iTrustLD. Complete identity verification to secure your account and transactions.
      </p>
      <p style="margin:40px 0;">
        <a href="${verificationUrl}" style="display:inline-block;background:#0f766e;color:#fff;text-decoration:none;padding:12px 24px;border-radius:9999px;">Verify Now</a>
      </p>
      <p style="font-size:16px;color:#6b7280;">If you have already verified your account please ignore this email.</p>
    </div>`);
}

export function verificationCodeEmailHtml(code) {
  return wrap(`
    <div style="padding:40px 30px;text-align:left;">
      <h1 style="font-size:24px;color:#1a1a1a;">Verification Code</h1>
      <div style="font-size:36px;font-weight:700;letter-spacing:4px;margin:40px 0;">${code}</div>
      <p style="font-size:16px;color:#6b7280;">Here is your verification code. It will expire in 5 minutes.</p>
    </div>`,
    `<p style="font-family:Poppins,Arial,sans-serif;font-size:16px;color:#6b7280;margin:0;">
      If you didn't try to sign in just now, please change your password to protect your account.
    </p>`);
}

export function accountVerifiedEmailHtml(dashboardUrl) {
  return wrap(`
    <div style="padding:40px 30px;text-align:left;">
      <h1 style="font-size:24px;color:#1a1a1a;">Account Verified</h1>
      <p style="font-size:16px;line-height:25px;color:#4b5563;">
        Your iTrustLD account email has been successfully verified.
      </p>
      <p style="margin:40px 0;">
        <a href="${dashboardUrl}" style="display:inline-block;background:#0f766e;color:#fff;text-decoration:none;padding:12px 24px;border-radius:9999px;">Go to Dashboard</a>
      </p>
    </div>`);
}

export function verificationPendingEmailHtml(userName) {
  const firstName = String(userName || 'there').split(' ')[0];
  return wrap(`
    <div style="padding:40px 30px;text-align:left;">
      <h1 style="font-size:24px;color:#1a1a1a;">Verification Documents Received</h1>
      <p style="font-size:16px;line-height:25px;color:#4b5563;">
        Hi ${firstName}, we have received your verification documents and they are now under review.
      </p>
      <p style="font-size:16px;line-height:25px;color:#4b5563;margin-top:16px;">
        This process may take up to 24 hours. We will notify you once verification is complete.
      </p>
    </div>`);
}

export function passwordResetEmailHtml(resetUrl) {
  return wrap(`
    <div style="padding:40px 30px;text-align:left;">
      <h1 style="font-size:24px;color:#1a1a1a;">Password Reset</h1>
      <p style="font-size:16px;line-height:25px;color:#4b5563;">
        If you have lost your password or wish to reset it, use the link below to get started.
      </p>
      <p style="margin:40px 0;">
        <a href="${resetUrl}" style="display:inline-block;background:#0f766e;color:#fff;text-decoration:none;padding:12px 24px;border-radius:9999px;">Reset Password</a>
      </p>
      <p style="font-size:16px;color:#6b7280;">If you did not request a password reset, you can safely ignore this email.</p>
    </div>`);
}

export function documentsRejectedEmailHtml(uploadUrl, rejectionMessage = '') {
  const reasonBlock = rejectionMessage
    ? `<p style="font-size:16px;line-height:25px;color:#4b5563;margin:0 0 24px;text-align:left;">Reason: ${rejectionMessage}</p>`
    : '';
  return wrap(`
    <div style="padding:40px 30px;text-align:left;">
      <h1 style="font-size:24px;color:#1a1a1a;">Documents Rejected!</h1>
      <p style="font-size:16px;line-height:25px;color:#4b5563;">
        We regret to inform you that the documents you recently submitted for account verification have been rejected. Please review the documents and resubmit them.
      </p>
      ${reasonBlock}
      <p style="margin:40px 0;">
        <a href="${uploadUrl}" style="display:inline-block;background:#22c55e;color:#fff;text-decoration:none;padding:12px 24px;border-radius:9999px;">Resubmit</a>
      </p>
      <p style="font-size:16px;line-height:25px;color:#4b5563;margin-top:16px;">
        Please take a moment to carefully review the submission guidelines and resubmit the corrected documents.
      </p>
    </div>`);
}

export function kycApprovedEmailHtml(label) {
  const title = label === 'identity' ? 'Identity' : 'Address';
  return wrap(`
    <div style="padding:40px 30px;text-align:left;">
      <h1 style="font-size:24px;color:#1a1a1a;">${title} Verification Approved</h1>
      <p style="font-size:16px;line-height:25px;color:#4b5563;">
        Your ${label} document has been successfully verified.
      </p>
    </div>`);
}

export function kycRejectedEmailHtml(label, rejectionMessage) {
  const title = label === 'identity' ? 'Identity' : 'Address';
  const message = rejectionMessage || 'Please resubmit your documents.';
  return wrap(`
    <div style="padding:40px 30px;text-align:left;">
      <h1 style="font-size:24px;color:#1a1a1a;">${title} Verification Rejected</h1>
      <p style="font-size:16px;line-height:25px;color:#4b5563;">
        Your ${label} proof document has been rejected. ${message}
      </p>
      <p style="font-size:16px;line-height:25px;color:#4b5563;margin-top:16px;">
        For more info, please contact us at +94 117 751 751
      </p>
    </div>`);
}

export function adminContactEmailHtml(body) {
  const escaped = String(body || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
  return wrap(`
    <div style="padding:40px 30px;">
      <p style="font-size:16px;line-height:25px;color:#0E1726;">${escaped}</p>
    </div>`);
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
}

export function helpTicketReplyEmailHtml({
  firstName,
  originalSubject,
  originalMessage,
  replyMessage,
}) {
  return wrap(`
    <div style="padding:40px 30px;">
      <p style="font-size:16px;line-height:25px;color:#0E1726;">Hi ${escapeHtml(firstName || 'there')},</p>
      <p style="font-size:16px;line-height:25px;color:#0E1726;margin-top:16px;">${escapeHtml(replyMessage)}</p>
      <div style="margin-top:28px;padding:18px 20px;border-radius:12px;background:#F7F9FC;border:1px solid #E5E7EB;">
        <p style="font-size:12px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#6B7280;margin:0;">Your original request</p>
        <p style="font-size:15px;font-weight:600;color:#111827;margin:10px 0 0;">${escapeHtml(originalSubject)}</p>
        <p style="font-size:14px;line-height:22px;color:#4B5563;margin:10px 0 0;">${escapeHtml(originalMessage)}</p>
      </div>
      <p style="font-size:14px;line-height:22px;color:#6B7280;margin-top:24px;">
        If you need more help, reply to this email or submit a new ticket at iTrustLD Support.
      </p>
    </div>`);
}

function formatDepositDate(value) {
  if (!value) return '—';
  const date = parseDbDateTime(value);
  if (!date) return String(value);
  const pad = (n) => String(n).padStart(2, '0');
  const parts = getColomboDateParts(date);
  return {
    date: `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`,
    time: `${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`,
  };
}

function formatMoney(currency, amount) {
  const n = Number(amount);
  const value = Number.isFinite(n) ? n.toFixed(2) : String(amount ?? '—');
  const code = String(currency || '').trim();
  return code ? `${code} ${value}` : value;
}

function statusValueColor(status) {
  const value = String(status || '');
  if (value === 'Completed') return '#0D9F1B';
  if (value === 'Rejected') return '#FF0000';
  if (value === 'Pending' || value === 'Pending Authorization') return '#FF8329';
  return '#0E1726';
}

function transactionDetailsHtml(rows) {
  const labelTd = 'padding:2px 16px 2px 0;vertical-align:top;white-space:nowrap;';
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:16px;font-size:16px;line-height:25px;color:#0E1726;">
      ${rows
        .map(([label, value, valueColor]) => {
          const display = value == null || value === '' ? '—' : String(value);
          const color = valueColor ? `color:${valueColor};` : '';
          return `<tr>
            <td style="${labelTd}">${escapeHtml(label)}</td>
            <td style="padding:2px 0;vertical-align:top;${color}">: ${escapeHtml(display)}</td>
          </tr>`;
        })
        .join('')}
    </table>`;
}

function depositDetailsTable({ firstName, deposit }) {
  const created = formatDepositDate(deposit.created_at);
  const dateText = typeof created === 'string' ? created : created.date;
  const timeText = typeof created === 'string' ? '' : created.time;
  const amount = formatMoney(deposit.deposit_amount_currency, deposit.deposit_amount);
  const fee = deposit.fee || formatMoney(deposit.deposit_amount_currency || 'USD', 0);
  const status = deposit.transaction_status || 'Pending';
  const rows = [
    ['Type', 'Top-up'],
    ['Method', deposit.topupMethodName || '—'],
    ['Payment Option', deposit.paymentOptionName || '—'],
    ['Status', status, statusValueColor(status)],
    ['Currency', deposit.deposit_amount_currency || 'USD'],
    ['Amount', amount],
    ['Payment Amount', formatMoney(deposit.payment_amount_currency, deposit.payment_amount)],
    ['Fee', fee],
    ['Net amount', deposit.netAmount || amount],
    ['Date', dateText],
    ['Time', timeText],
    ['Account', deposit.topup_account_id || '—'],
    ['Reference', deposit.transaction_id],
    ['Note', deposit.message || '—'],
  ];
  if (status === 'Rejected' && (deposit.rejected_reason_message || deposit.rejected_reason)) {
    rows.push([
      'Rejected Reason',
      formatCustomerRejectReason(deposit.rejected_reason, deposit.rejected_reason_message),
    ]);
  }
  return `
    <div style="padding:40px 30px;">
      <h2 style="font-size:24px;color:#0f172a;">Hi ${firstName},</h2>
      <p style="font-size:16px;line-height:25px;color:#0E1726;">
        ${deposit.transaction_status === 'Completed'
          ? 'Congratulations! Your deposit request has been approved. You can find the deposit information below.'
          : 'Your deposit request has been rejected. You can find the deposit information below.'}
      </p>
      ${transactionDetailsHtml(rows)}
      <p style="font-size:16px;line-height:25px;color:#0E1726;margin-top:16px;">
        If you have any questions or need assistance, please contact our support team.
      </p>
    </div>`;
}

export function depositApprovedEmailHtml({ firstName, deposit }) {
  return wrap(depositDetailsTable({ firstName, deposit: { ...deposit, transaction_status: 'Completed' } }));
}

export function depositRejectedEmailHtml({ firstName, deposit }) {
  return wrap(depositDetailsTable({ firstName, deposit: { ...deposit, transaction_status: 'Rejected' } }));
}

function withdrawalDetailsTable({ firstName, withdrawal }) {
  const created = formatDepositDate(withdrawal.created_at);
  const dateText = typeof created === 'string' ? created : created.date;
  const timeText = typeof created === 'string' ? '' : created.time;
  const amount = formatMoney(withdrawal.cashout_amount_currency, withdrawal.cashout_amount);
  const fee = withdrawal.fee || formatMoney(withdrawal.cashout_amount_currency || 'USD', 0);
  const status = withdrawal.transaction_status || 'Pending';
  const rows = [
    ['Type', 'Cash-out'],
    ['Method', withdrawal.cashoutMethodName || '—'],
    ['Payment Option', withdrawal.receivingOptionName || '—'],
    ['Status', status, statusValueColor(status)],
    ['Currency', withdrawal.cashout_amount_currency || 'USD'],
    ['Amount', amount],
    ['Receiving Amount', formatMoney(withdrawal.receiving_amount_currency, withdrawal.receiving_amount)],
    ['Fee', fee],
    ['Net amount', withdrawal.netAmount || amount],
    ['Date', dateText],
    ['Time', timeText],
    ['Account', withdrawal.cashout_account_id || '—'],
    ['Reference', withdrawal.transaction_id],
    ['Note', withdrawal.message || '—'],
  ];
  if (status === 'Rejected' && (withdrawal.rejected_reason_message || withdrawal.rejected_reason)) {
    rows.push([
      'Rejected Reason',
      formatCustomerRejectReason(withdrawal.rejected_reason, withdrawal.rejected_reason_message),
    ]);
  }
  return `
    <div style="padding:40px 30px;">
      <h2 style="font-size:24px;color:#0f172a;">Hi ${firstName},</h2>
      <p style="font-size:16px;line-height:25px;color:#0E1726;">
        ${withdrawal.transaction_status === 'Completed'
          ? 'Congratulations! Your withdrawal request has been approved. You can find the withdrawal information below.'
          : 'Your withdrawal request has been rejected. You can find the withdrawal information below.'}
      </p>
      ${transactionDetailsHtml(rows)}
      <p style="font-size:16px;line-height:25px;color:#0E1726;margin-top:16px;">
        If you have any questions or need assistance, please contact our support team.
      </p>
    </div>`;
}

export function withdrawalApprovedEmailHtml({ firstName, withdrawal }) {
  return wrap(
    withdrawalDetailsTable({ firstName, withdrawal: { ...withdrawal, transaction_status: 'Completed' } }),
  );
}

export function withdrawalRejectedEmailHtml({ firstName, withdrawal }) {
  return wrap(
    withdrawalDetailsTable({ firstName, withdrawal: { ...withdrawal, transaction_status: 'Rejected' } }),
  );
}

export function loyaltyLevelUpgradeEmailHtml({ levelName, loyaltyPoints, featureUrl }) {
  const formattedPoints = Math.round(Number(loyaltyPoints) || 0).toLocaleString();
  return wrap(`
    <div style="padding:40px 30px;text-align:left;">
      <h1 style="font-size:24px;color:#0E1726;margin:0 0 24px;">Congratulations!</h1>
      <p style="font-size:16px;line-height:25px;color:#0E1726;margin:0 0 12px;">
        You've just unlocked ${levelName} Trust Level by reaching ${formattedPoints} Loyalty Points!
      </p>
      <p style="font-size:16px;line-height:25px;color:#0E1726;margin:0 0 32px;">
        We've unlocked some awesome benefits just for you.
      </p>
      <a href="${featureUrl}" style="display:inline-block;background:#0f766e;color:#fff;text-decoration:none;padding:12px 24px;border-radius:9999px;font-size:16px;font-weight:500;">
        Check Now
      </a>
    </div>`);
}

export function loyaltyRedemptionApprovedEmailHtml({ firstName, balanceUrl }) {
  const name = firstName || 'Customer';
  return wrap(`
    <div style="padding:40px 30px;text-align:left;">
      <h1 style="font-size:24px;color:#0E1726;margin:0 0 24px;">Redemption approved</h1>
      <p style="font-size:16px;line-height:25px;color:#0E1726;margin:0 0 12px;">
        Hi ${name}, your loyalty bonus redemption request has been approved.
      </p>
      <p style="font-size:16px;line-height:25px;color:#0E1726;margin:0 0 32px;">
        Congratulations! Your loyalty points have been successfully redeemed.
      </p>
      <a href="${balanceUrl}" style="display:inline-block;background:#0f766e;color:#fff;text-decoration:none;padding:12px 24px;border-radius:9999px;font-size:16px;font-weight:500;">
        View loyalty balance
      </a>
    </div>`);
}

export function loyaltyRedemptionRejectedEmailHtml({ firstName, balanceUrl, reason }) {
  const name = firstName || 'Customer';
  const reasonText = String(reason || '').trim();
  return wrap(`
    <div style="padding:40px 30px;text-align:left;">
      <h1 style="font-size:24px;color:#0E1726;margin:0 0 24px;">Redemption rejected</h1>
      <p style="font-size:16px;line-height:25px;color:#0E1726;margin:0 0 12px;">
        Hi ${escapeHtml(name)}, your loyalty bonus redemption request has been rejected.
      </p>
      ${
        reasonText
          ? `<p style="font-size:16px;line-height:25px;color:#0E1726;margin:0 0 12px;">
        Reason: <strong>${escapeHtml(reasonText)}</strong>
      </p>`
          : ''
      }
      <p style="font-size:16px;line-height:25px;color:#0E1726;margin:0 0 32px;">
        Please contact support if you need more information.
      </p>
      <a href="${balanceUrl}" style="display:inline-block;background:#0f766e;color:#fff;text-decoration:none;padding:12px 24px;border-radius:9999px;font-size:16px;font-weight:500;">
        View loyalty balance
      </a>
    </div>`);
}

export function clientBonusVoucherEmailHtml({ firstName, platformId, validUntil, amount, voucherUrl }) {
  const name = String(firstName || 'there').split(' ')[0];
  const formattedAmount = Number(amount || 0).toFixed(2);
  return wrap(`
    <div style="padding:40px 30px;">
      <h1 style="font-size:24px;color:#0E1726;">Client Bonus Voucher</h1>
      <p style="font-size:16px;line-height:25px;color:#0E1726;margin:0 0 12px;">
        Hi ${name}, your client bonus voucher for USD ${formattedAmount} has been issued.
      </p>
      <p style="font-size:16px;line-height:25px;color:#0E1726;margin:0 0 12px;">
        Platform ID: <strong>${platformId || '—'}</strong>
      </p>
      <p style="font-size:16px;line-height:25px;color:#0E1726;margin:0 0 32px;">
        Valid until ${validUntil || '30 days from issue'}. Share the printable voucher with your client for deposit redemption.
      </p>
      <a href="${voucherUrl}" style="display:inline-block;background:#0f766e;color:#fff;text-decoration:none;padding:12px 24px;border-radius:9999px;font-size:16px;font-weight:500;">
        View vouchers
      </a>
    </div>`);
}

export function loyaltyRedemptionPendingEmailHtml({ firstName, balanceUrl }) {
  const name = firstName || 'Customer';
  return wrap(`
    <div style="padding:40px 30px;text-align:left;">
      <h1 style="font-size:24px;color:#0E1726;margin:0 0 24px;">Bonus claim submitted</h1>
      <p style="font-size:16px;line-height:25px;color:#0E1726;margin:0 0 12px;">
        Hi ${name}, your loyalty bonus claim has been submitted successfully.
      </p>
      <p style="font-size:16px;line-height:25px;color:#0E1726;margin:0 0 32px;">
        Your request is being reviewed. We will notify you once it is processed.
      </p>
      <a href="${balanceUrl}" style="display:inline-block;background:#0f766e;color:#fff;text-decoration:none;padding:12px 24px;border-radius:9999px;font-size:16px;font-weight:500;">
        View loyalty balance
      </a>
    </div>`);
}

export function rateChangeEmailHtml({
  firstName,
  paymentOptionName,
  walletName,
  currency,
  depositRate,
  withdrawalRate,
  isUpdate,
  dashboardUrl,
}) {
  const name = String(firstName || 'Customer').split(' ')[0];
  const method = paymentOptionName || 'payment';
  const wallet = walletName || 'selected method';
  const unit = currency || 'USD';
  const title = isUpdate ? 'Rates updated' : 'New rates available';
  const intro = isUpdate
    ? `Hi ${name}, our ${method} rates for ${wallet} have been updated.`
    : `Hi ${name}, new ${method} rates for ${wallet} are now available.`;

  const rateRows = [];
  if (depositRate != null && depositRate !== '') {
    rateRows.push(
      `<p style="font-size:16px;line-height:25px;color:#0E1726;margin:0 0 8px;">Deposit rate: <strong>${depositRate} ${unit}</strong></p>`,
    );
  }
  if (withdrawalRate != null && withdrawalRate !== '') {
    rateRows.push(
      `<p style="font-size:16px;line-height:25px;color:#0E1726;margin:0 0 8px;">Withdrawal rate: <strong>${withdrawalRate} ${unit}</strong></p>`,
    );
  }

  return wrap(`
    <div style="padding:40px 30px;text-align:left;">
      <h1 style="font-size:24px;color:#0E1726;margin:0 0 24px;">${title}</h1>
      <p style="font-size:16px;line-height:25px;color:#0E1726;margin:0 0 16px;">
        ${intro}
      </p>
      ${rateRows.join('')}
      <p style="font-size:16px;line-height:25px;color:#0E1726;margin:16px 0 32px;">
        Log in to your account to view the latest rates before your next top-up or cash-out.
      </p>
      <a href="${dashboardUrl}" style="display:inline-block;background:#0f766e;color:#fff;text-decoration:none;padding:12px 24px;border-radius:9999px;font-size:16px;font-weight:500;">
        Go to dashboard
      </a>
    </div>`);
}

export function loyaltyCatalogNotifyEmailHtml({
  firstName,
  headline,
  intro,
  detailLines = [],
  dashboardUrl,
}) {
  const name = String(firstName || 'Customer').split(' ')[0];
  const details = (detailLines || [])
    .filter(Boolean)
    .map(
      (line) =>
        `<p style="font-size:16px;line-height:25px;color:#0E1726;margin:0 0 8px;">${line}</p>`,
    )
    .join('');

  return wrap(`
    <div style="padding:40px 30px;text-align:left;">
      <h1 style="font-size:24px;color:#0E1726;margin:0 0 24px;">${headline || 'Loyalty update'}</h1>
      <p style="font-size:16px;line-height:25px;color:#0E1726;margin:0 0 12px;">
        Hi ${name},
      </p>
      <p style="font-size:16px;line-height:25px;color:#0E1726;margin:0 0 16px;">
        ${intro || 'Your loyalty benefits have been updated.'}
      </p>
      ${details}
      <p style="font-size:16px;line-height:25px;color:#0E1726;margin:16px 0 32px;">
        Log in to Loyalty to view the details.
      </p>
      <a href="${dashboardUrl}" style="display:inline-block;background:#0f766e;color:#fff;text-decoration:none;padding:12px 24px;border-radius:9999px;font-size:16px;font-weight:500;">
        View loyalty
      </a>
    </div>`);
}

export function newClientJoinedEmailHtml(clientsUrl) {
  return wrap(`
    <div style="padding:40px 30px;">
      <p style="font-size:16px;line-height:25px;color:#0E1726;">
        A new client has joined with you. <a href="${clientsUrl}" style="color:#0f766e;">View your clients</a>.
      </p>
    </div>`);
}

export function accountBannedEmailHtml() {
  return wrap(`
    <div style="padding:40px 30px;">
      <p style="font-size:16px;line-height:25px;color:#0E1726;">
        Your iTrustLD account has been banned. Please contact support for assistance.
      </p>
    </div>`);
}

export function partnerAccountCreatedEmailHtml(userName, profileUrl) {
  const name = String(userName || 'there').split(' ')[0];
  return wrap(`
    <div style="padding:40px 30px;">
      <p style="font-size:16px;line-height:25px;color:#0E1726;">
        Hi ${name}, your partner account has been successfully created. <a href="${profileUrl}" style="color:#0f766e;">Open your dashboard</a> to get started.
      </p>
    </div>`);
}
