import { query } from '../config/database.js';
import { findAccountHolderByUserId } from './accountHolder.service.js';
import { findUserByEmail, findUserById } from './user.service.js';
import { sendTemplatedEmailAndSms, sendEmailAndSms } from './notification.service.js';
import {
  accountVerifiedEmailHtml,
  verificationCodeEmailHtml,
  verificationPendingEmailHtml,
  verifyAccountEmailHtml,
  welcomeEmailHtml,
} from './mail.templates.js';
import { MESSAGE_TEMPLATE_KEYS } from './messageTemplateKeys.js';
import {
  storePairedBackDocument,
  storeVerificationDocument,
  validateDocumentUpload,
} from './documentStorage.service.js';
import { toPublicUser } from './userAuth.service.js';
import { getUserRoles } from './user.service.js';
import { env } from '../config/env.js';

const IDENTITY_DOCUMENT_TYPES = new Set(['NIC', 'DL', 'PASSPORT']);
const ADDRESS_DOCUMENT_TYPES = new Set([
  'ELECTRICITY_BILL',
  'WATER_BILL',
  'TELEPHONE_BILL',
  'UTILITY_BILL',
  'OTHER',
]);

function validationError(message, status = 422) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function devDeliveryPayload(mailResult, code) {
  if (env.nodeEnv === 'production') {
    return {};
  }
  if (mailResult?.delivered && mailResult?.via === 'smtp') {
    return {};
  }

  const devCode = mailResult?.code || code;
  if (!devCode) return {};

  let hint =
    'Email was not sent to your inbox (MAIL_MAILER=log). Use the code below or configure SMTP in ITrustLD_Existing/.env.';
  if (mailResult?.via === 'local-catcher') {
    hint = 'Email captured locally. Open http://localhost:8025 (Mailpit) or use the code below.';
  }

  return {
    dev_code: devCode,
    delivery: mailResult?.via || 'console',
    hint,
  };
}

export function generateVerificationCode(length = 6) {
  let code = '';
  for (let i = 0; i < length; i += 1) {
    code += Math.floor(Math.random() * 10);
  }
  return code;
}

async function createVerificationCode(userId) {
  const code = generateVerificationCode();
  await query(
    `INSERT INTO verification_codes (code, user_id, status, created_at, updated_at)
     VALUES (?, ?, 'ACTIVE', NOW(), NOW())`,
    [code, userId],
  );
  return code;
}

async function getLatestActiveCode(userId) {
  const rows = await query(
    `SELECT id, code, status FROM verification_codes
     WHERE user_id = ?
     ORDER BY id DESC
     LIMIT 1`,
    [userId],
  );
  return rows[0] ?? null;
}

async function checkAccountHolderByMobile(mobileNumber, excludeUserId = null) {
  const rows = await query(
    `SELECT ah.id, ah.user_id
     FROM account_holders ah
     WHERE ah.mobile_number = ?
     ${excludeUserId ? 'AND ah.user_id != ?' : ''}
     LIMIT 1`,
    excludeUserId ? [mobileNumber, excludeUserId] : [mobileNumber],
  );
  return rows[0] ?? null;
}

export async function sendRegistrationEmails(user, accountHolder = null) {
  const verificationUrl = `${env.userAppUrl}/verify`;
  const holder = accountHolder ?? (await findAccountHolderByUserId(user.id));
  const msisdn = holder?.mobile_number || null;
  const firstName = String(user.name || 'there').split(' ')[0];
  const variables = {
    username: user.name || 'Customer',
    first_name: firstName,
    verification_url: verificationUrl,
  };

  try {
    await sendTemplatedEmailAndSms({
      email: user.email,
      msisdn,
      userId: user.id,
      smsType: 'WELCOME',
      emailKey: MESSAGE_TEMPLATE_KEYS.WELCOME_EMAIL,
      smsKey: MESSAGE_TEMPLATE_KEYS.WELCOME_SMS,
      variables,
      fallback: {
        subject: 'Register Successful',
        html: welcomeEmailHtml(user.name),
        smsMessage: 'Welcome to iTrustLD. Your account is registered successfully.',
      },
    });
  } catch (error) {
    console.error('[register] welcome email failed:', error.message);
  }

  try {
    await sendTemplatedEmailAndSms({
      email: user.email,
      msisdn,
      userId: user.id,
      smsType: 'ACCOUNT_VERIFICATION',
      emailKey: MESSAGE_TEMPLATE_KEYS.ACCOUNT_VERIFICATION_EMAIL,
      smsKey: MESSAGE_TEMPLATE_KEYS.ACCOUNT_VERIFICATION_SMS,
      variables,
      fallback: {
        subject: 'Account verification',
        html: verifyAccountEmailHtml(verificationUrl),
        smsMessage: 'Please verify your iTrustLD account to get started.',
      },
    });
  } catch (error) {
    console.error('[register] verification email failed:', error.message);
  }
}

export async function sendVerificationEmail(userId, email) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail) {
    throw validationError('Email is required.');
  }

  const user = await findUserById(userId);
  if (!user) throw validationError('User not found.', 404);

  const accountHolder = await findAccountHolderByUserId(userId);
  if (!accountHolder) throw validationError('Account holder not found.', 404);

  if (normalizedEmail !== user.email.toLowerCase()) {
    const duplicate = await findUserByEmail(normalizedEmail);
    if (duplicate && duplicate.id !== userId) {
      throw validationError(`The email ${normalizedEmail} is already in use.`);
    }
    await query('UPDATE users SET email = ?, updated_at = NOW() WHERE id = ?', [
      normalizedEmail,
      userId,
    ]);
    await query('UPDATE account_holders SET email = ?, updated_at = NOW() WHERE user_id = ?', [
      normalizedEmail,
      userId,
    ]);
  }

  const code = await createVerificationCode(userId);

  try {
    await sendEmailAndSms({
      email: normalizedEmail,
      subject: 'OTP',
      html: verificationCodeEmailHtml(code),
      text: `Your iTrustLD verification code is ${code}. It expires in 5 minutes.`,
      smsMessage: `Your iTrustLD verification code is ${code}.`,
      msisdn: accountHolder.mobile_number,
      userId,
      smsType: 'VERIFICATION_CODE',
    });
    // Temporary: do not return OTP to the UI for email verification (code is only in email/SMS).
    return {
      ok: true,
      message: 'Verification code sent.',
    };
  } catch (error) {
    console.error('[verify] email send failed:', error.message);
    throw validationError('Failed to send verification email. Please try again.');
  }
}

export async function verifyEmailCode(userId, email, verificationCode) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const code = String(verificationCode || '').trim();

  if (!normalizedEmail || !code) {
    throw validationError('Email and verification code are required.');
  }

  const user = await findUserById(userId);
  if (!user) throw validationError('User not found.', 404);

  if (normalizedEmail !== user.email.toLowerCase()) {
    throw validationError('Provided email is not registered.');
  }

  const codeRow = await getLatestActiveCode(userId);
  if (!codeRow || codeRow.status !== 'ACTIVE' || String(codeRow.code) !== code) {
    throw validationError('Invalid verification code. Please try again.');
  }

  await query('UPDATE verification_codes SET status = ?, updated_at = NOW() WHERE id = ?', [
    'USED',
    codeRow.id,
  ]);
  await query(
    `UPDATE account_holders SET email_verification = 'VERIFIED', updated_at = NOW() WHERE user_id = ?`,
    [userId],
  );
  await query('UPDATE users SET email_verified_at = NOW(), updated_at = NOW() WHERE id = ?', [
    userId,
  ]);

  const accountHolder = await findAccountHolderByUserId(userId);
  const dashboardUrl = `${env.userAppUrl}/dashboard`;

  try {
    await sendEmailAndSms({
      email: user.email,
      subject: 'Account verification successful',
      html: accountVerifiedEmailHtml(dashboardUrl),
      smsMessage: 'Your iTrustLD account has been successfully verified! Get started now.',
      msisdn: accountHolder?.mobile_number,
      userId,
      smsType: 'ACCOUNT_VERIFICATION_SUCCESS',
    });
  } catch (error) {
    console.error('[verify] success email failed:', error.message);
  }

  return { ok: true, message: 'Email verified successfully.' };
}

export async function sendVerificationSms(userId, mobileNumber) {
  const mobile = String(mobileNumber || '').trim();
  if (!mobile) throw validationError('Mobile number is required.');

  const accountHolder = await findAccountHolderByUserId(userId);
  if (!accountHolder) throw validationError('Account holder not found.', 404);

  if (accountHolder.email_verification !== 'VERIFIED') {
    throw validationError('Verify your email before verifying your mobile number.');
  }

  if (mobile !== accountHolder.mobile_number) {
    const duplicate = await checkAccountHolderByMobile(mobile, userId);
    if (duplicate) {
      throw validationError(`The mobile number ${mobile} is already in use.`);
    }
    await query(
      'UPDATE account_holders SET mobile_number = ?, updated_at = NOW() WHERE user_id = ?',
      [mobile, userId],
    );
  }

  const code = await createVerificationCode(userId);
  const user = await findUserById(userId);

  const message = `Your ITrustLD mobile number verification code is: ${code}. Do not share this code with anyone. - For more info: +94 117 751 751 ,iTrustLD`;

  try {
    const mailResult = await sendEmailAndSms({
      email: user.email,
      subject: 'Mobile verification code',
      html: verificationCodeEmailHtml(code),
      text: `Your iTrustLD mobile verification code is ${code}.`,
      smsMessage: message,
      msisdn: mobile,
      userId,
      smsType: 'verification code',
    });
    return {
      ok: true,
      message: 'Verification code sent.',
      ...devDeliveryPayload(mailResult, code),
    };
  } catch (error) {
    console.error('[verify] sms send failed:', error.message);
    throw validationError('Failed to send verification SMS. Please try again.');
  }
}

export async function verifyMobileCode(userId, mobileNumber, verificationCode) {
  const mobile = String(mobileNumber || '').trim();
  const code = String(verificationCode || '').trim();

  if (!mobile || !code) {
    throw validationError('Mobile number and verification code are required.');
  }

  const accountHolder = await findAccountHolderByUserId(userId);
  if (!accountHolder) throw validationError('Account holder not found.', 404);

  if (mobile !== accountHolder.mobile_number) {
    throw validationError('Provided mobile number is not registered.');
  }

  const codeRow = await getLatestActiveCode(userId);
  if (!codeRow || codeRow.status !== 'ACTIVE' || String(codeRow.code) !== code) {
    throw validationError('Invalid verification code. Please try again.');
  }

  await query('UPDATE verification_codes SET status = ?, updated_at = NOW() WHERE id = ?', [
    'USED',
    codeRow.id,
  ]);
  await query(
    `UPDATE account_holders SET mobile_number_verification = 'VERIFIED', updated_at = NOW() WHERE user_id = ?`,
    [userId],
  );

  return { ok: true, message: 'Mobile number verified successfully.' };
}

export function getVerificationStep(accountHolder) {
  if (!accountHolder) return 'email';
  if (accountHolder.email_verification !== 'VERIFIED') return 'email';
  if (accountHolder.mobile_number_verification !== 'VERIFIED') return 'phone';
  if (
    accountHolder.identity_verification === 'VERIFIED' &&
    accountHolder.address_verification === 'VERIFIED'
  ) {
    return 'complete';
  }

  // Rejected docs must re-open the upload form (dashboard stays gated until verified).
  if (
    accountHolder.identity_verification === 'REJECTED' ||
    accountHolder.address_verification === 'REJECTED'
  ) {
    return 'documents';
  }

  const bothDocsReceived =
    accountHolder.identity_document_status === 'RECEIVED' &&
    accountHolder.address_document_status === 'RECEIVED';

  return bothDocsReceived ? 'pending' : 'documents';
}

export async function saveVerificationDocuments(
  userId,
  { identityDocumentType, addressDocumentType, identityFile, identityBackFile, addressFile },
) {
  const accountHolder = await findAccountHolderByUserId(userId);
  if (!accountHolder) throw validationError('Account holder not found.', 404);

  if (accountHolder.email_verification !== 'VERIFIED') {
    throw validationError('Verify your email before uploading documents.');
  }
  if (accountHolder.mobile_number_verification !== 'VERIFIED') {
    throw validationError('Verify your mobile number before uploading documents.');
  }

  const identityType = String(identityDocumentType || '').trim().toUpperCase();
  const addressType = String(addressDocumentType || '').trim().toUpperCase();
  let identityUploaded = false;
  let addressUploaded = false;

  if (identityFile) {
    const fileError = validateDocumentUpload(identityFile);
    if (fileError) throw validationError(fileError);
    if (!identityType || !IDENTITY_DOCUMENT_TYPES.has(identityType)) {
      throw validationError('Select a valid identity document type.');
    }

    if (identityType === 'NIC') {
      if (!identityBackFile) {
        throw validationError('Upload both front and back of your National ID.');
      }
      const backError = validateDocumentUpload(identityBackFile);
      if (backError) throw validationError(backError);
    }

    const identityDocumentName = await storeVerificationDocument(identityFile, 'identity_');
    if (identityType === 'NIC' && identityBackFile) {
      await storePairedBackDocument(identityBackFile, identityDocumentName);
    }
    await query(
      `UPDATE account_holders
       SET identity_document_type = ?,
           identity_document_name = ?,
           identity_document_status = 'RECEIVED',
           identity_verification = 'NOT_VERIFIED',
           identity_verification_rejection_title = NULL,
           identity_verification_rejection_message = NULL,
           updated_at = NOW()
       WHERE user_id = ?`,
      [identityType, identityDocumentName, userId],
    );
    identityUploaded = true;
  }

  if (addressFile) {
    const fileError = validateDocumentUpload(addressFile);
    if (fileError) throw validationError(fileError);
    if (!addressType || !ADDRESS_DOCUMENT_TYPES.has(addressType)) {
      throw validationError('Select a valid address document type.');
    }

    const addressDocumentName = await storeVerificationDocument(addressFile, 'address_');
    await query(
      `UPDATE account_holders
       SET address_document_type = ?,
           address_document_name = ?,
           address_document_status = 'RECEIVED',
           address_verification = 'NOT_VERIFIED',
           address_verification_rejection_title = NULL,
           address_verification_rejection_message = NULL,
           updated_at = NOW()
       WHERE user_id = ?`,
      [addressType, addressDocumentName, userId],
    );
    addressUploaded = true;
  }

  if (!identityUploaded && !addressUploaded) {
    throw validationError('Upload at least one document.');
  }

  const user = await findUserById(userId);
  const updatedAccountHolder = await findAccountHolderByUserId(userId);

  if (
    updatedAccountHolder.identity_document_status === 'RECEIVED' &&
    updatedAccountHolder.address_document_status === 'RECEIVED'
  ) {
    try {
      await sendEmailAndSms({
        email: user.email,
        subject: 'Verification documents received',
        html: verificationPendingEmailHtml(user.name),
        smsMessage: 'Your verification documents have been received and are under review.',
        msisdn: updatedAccountHolder.mobile_number,
        userId,
        smsType: 'VERIFICATION_PENDING',
      });
    } catch (error) {
      console.error('[verify] pending email failed:', error.message);
    }
  }

  const roles = await getUserRoles(userId);
  const sessionUser = toPublicUser(user, roles, updatedAccountHolder);
  return {
    ok: true,
    message: 'Documents uploaded successfully.',
    user: sessionUser,
    step: getVerificationStep(updatedAccountHolder),
  };
}
