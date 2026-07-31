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
