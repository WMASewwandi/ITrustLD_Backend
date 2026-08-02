function header() {
  return `
    <div style="background-color:#F8F8F8;padding:20px;text-align:left;">
      <span style="font-family:Poppins,Arial,sans-serif;font-size:16px;font-weight:600;">iTrustLD</span>
    </div>`;
}

function footer(extra = '') {
  return `
    <div style="background-color:#f8f9fa;padding:30px;text-align:center;border-top:1px solid #e5e7eb;">
      ${extra}
      <p style="font-family:Poppins,Arial,sans-serif;font-size:16px;color:#6b7280;margin:20px 0 0;">
        For more info, please contact us at +94 117 751 751
      </p>
    </div>`;
}

function wrap(content, footerExtra = '') {
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;font-family:Poppins,Arial,sans-serif;background:#f8f9fa;">
    <div style="max-width:842px;margin:0 auto;background:#fff;">${header()}${content}${footer(footerExtra)}</div>
  </body></html>`;
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
    <div style="padding:40px 30px;text-align:center;">
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
    <div style="padding:40px 30px;text-align:center;">
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
    <div style="padding:40px 30px;text-align:center;">
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
    <div style="padding:40px 30px;text-align:center;">
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
    <div style="padding:40px 30px;text-align:center;">
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
    ? `<p style="font-size:16px;line-height:25px;color:#4b5563;margin:0 0 24px;text-align:center;">Reason: ${rejectionMessage}</p>`
    : '';
  return wrap(`
    <div style="padding:40px 30px;text-align:center;">
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
    <div style="padding:40px 30px;text-align:center;">
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
    <div style="padding:40px 30px;text-align:center;">
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
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const pad = (n) => String(n).padStart(2, '0');
  return {
    date: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    time: `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
  };
}

function depositDetailsTable({ firstName, deposit }) {
  const created = formatDepositDate(deposit.created_at);
  const dateText = typeof created === 'string' ? created : created.date;
  const timeText = typeof created === 'string' ? '' : created.time;
  return `
    <div style="padding:40px 30px;">
      <h2 style="font-size:24px;color:#0f172a;">Hi ${firstName},</h2>
      <p style="font-size:16px;line-height:25px;color:#0E1726;">
        ${deposit.transaction_status === 'Completed'
          ? 'Congratulations! Your deposit request has been approved. You can find the deposit information below.'
          : 'Your deposit request has been rejected. You can find the deposit information below.'}
      </p>
      <table style="margin-top:16px;font-size:16px;line-height:25px;color:#0E1726;">
        <tr><td>Transaction ID</td><td>- ${deposit.transaction_id}</td></tr>
        <tr><td>Payment Amount</td><td>- ${deposit.payment_amount_currency} ${deposit.payment_amount}</td></tr>
        <tr><td>Payment Method</td><td>- ${deposit.paymentOptionName || '—'}</td></tr>
        <tr><td>Topup Amount</td><td>- ${deposit.deposit_amount_currency} ${deposit.deposit_amount}</td></tr>
        <tr><td>Transaction Date</td><td>- ${dateText}</td></tr>
        <tr><td>Transaction Time</td><td>- ${timeText}</td></tr>
        <tr><td>Top Up Method</td><td>- ${deposit.topupMethodName || '—'}</td></tr>
        <tr><td>Topup Account</td><td>- ${deposit.topup_account_id || '—'}</td></tr>
        <tr><td>Status</td><td>- ${deposit.transaction_status}</td></tr>
        <tr><td>Message</td><td>- ${deposit.message || '—'}</td></tr>
      </table>
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
  return `
    <div style="padding:40px 30px;">
      <h2 style="font-size:24px;color:#0f172a;">Hi ${firstName},</h2>
      <p style="font-size:16px;line-height:25px;color:#0E1726;">
        ${withdrawal.transaction_status === 'Completed'
          ? 'Congratulations! Your withdrawal request has been approved. You can find the withdrawal information below.'
          : 'Your withdrawal request has been rejected. You can find the withdrawal information below.'}
      </p>
      <table style="margin-top:16px;font-size:16px;line-height:25px;color:#0E1726;">
        <tr><td>Transaction ID</td><td>- ${withdrawal.transaction_id}</td></tr>
        <tr><td>Cashout Amount</td><td>- ${withdrawal.cashout_amount_currency} ${withdrawal.cashout_amount}</td></tr>
        <tr><td>Receiving Amount</td><td>- ${withdrawal.receiving_amount_currency} ${withdrawal.receiving_amount}</td></tr>
        <tr><td>Receiving Method</td><td>- ${withdrawal.receivingOptionName || '—'}</td></tr>
        <tr><td>Transaction Date</td><td>- ${dateText}</td></tr>
        <tr><td>Transaction Time</td><td>- ${timeText}</td></tr>
        <tr><td>Cashout Method</td><td>- ${withdrawal.cashoutMethodName || '—'}</td></tr>
        <tr><td>Cashout Account</td><td>- ${withdrawal.cashout_account_id || '—'}</td></tr>
        <tr><td>Status</td><td>- ${withdrawal.transaction_status}</td></tr>
        <tr><td>Message</td><td>- ${withdrawal.message || '—'}</td></tr>
      </table>
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
    <div style="padding:40px 30px;text-align:center;">
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
    <div style="padding:40px 30px;text-align:center;">
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

export function loyaltyRedemptionRejectedEmailHtml({ firstName, balanceUrl }) {
  const name = firstName || 'Customer';
  return wrap(`
    <div style="padding:40px 30px;text-align:center;">
      <h1 style="font-size:24px;color:#0E1726;margin:0 0 24px;">Redemption rejected</h1>
      <p style="font-size:16px;line-height:25px;color:#0E1726;margin:0 0 12px;">
        Hi ${name}, your loyalty bonus redemption request has been rejected.
      </p>
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
    <div style="padding:40px 30px;text-align:center;">
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
