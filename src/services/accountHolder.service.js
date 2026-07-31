import { query } from '../config/database.js';

export function generateAccountNumber(userId) {
  const paddedUserId = String(userId).padStart(2, '0');
  const randomDigits = 12 - paddedUserId.length;
  const max = 10 ** randomDigits - 1;
  const randomPart = String(Math.floor(Math.random() * (max + 1))).padStart(randomDigits, '0');
  return `${paddedUserId}${randomPart}`;
}

export async function findAccountHolderByUserId(userId) {
  const rows = await query(
    `SELECT id, user_id, first_name, last_name, language, email, mobile_number,
            date_of_birth, address_number, street, city, country, zip_code, account_number,
            email_verification, address_verification, mobile_number_verification,
            identity_verification, account_status, is_patner, affiliate_code,
            identity_document_type, identity_document_name, identity_document_status,
            address_document_type, address_document_name, address_document_status,
            created_at, updated_at
     FROM account_holders
     WHERE user_id = ?
     LIMIT 1`,
    [userId],
  );
  return rows[0] ?? null;
}

export async function findAccountHolderByEmail(email) {
  const rows = await query(
    `SELECT id, user_id, email
     FROM account_holders
     WHERE LOWER(email) = ?
     LIMIT 1`,
    [email],
  );
  return rows[0] ?? null;
}

export async function findAccountHolderByMobile(mobileNumber, excludeUserId = null) {
  const mobile = String(mobileNumber || '').trim();
  if (!mobile) return null;

  const rows = await query(
    `SELECT id, user_id, mobile_number
     FROM account_holders
     WHERE mobile_number = ?
     ${excludeUserId ? 'AND user_id != ?' : ''}
     LIMIT 1`,
    excludeUserId ? [mobile, excludeUserId] : [mobile],
  );
  return rows[0] ?? null;
}

export async function findPartnerByAffiliateCode(affiliateCode) {
  const rows = await query(
    `SELECT id, user_id, affiliate_code
     FROM account_holders
     WHERE affiliate_code = ?
     LIMIT 1`,
    [affiliateCode],
  );
  return rows[0] ?? null;
}

export function isAccountBanned(accountHolder) {
  return accountHolder?.account_status === 'BANNED';
}

export function needsVerification(accountHolder) {
  if (!accountHolder) return true;
  return (
    accountHolder.email_verification !== 'VERIFIED' ||
    accountHolder.mobile_number_verification !== 'VERIFIED' ||
    accountHolder.identity_verification !== 'VERIFIED' ||
    accountHolder.address_verification !== 'VERIFIED'
  );
}

export function toPublicAccountHolder(accountHolder) {
  if (!accountHolder) return null;
  return {
    id: accountHolder.id,
    first_name: accountHolder.first_name,
    last_name: accountHolder.last_name,
    email: accountHolder.email,
    mobile_number: accountHolder.mobile_number,
    language: accountHolder.language,
    date_of_birth: accountHolder.date_of_birth,
    address_number: accountHolder.address_number,
    street: accountHolder.street,
    city: accountHolder.city,
    country: accountHolder.country,
    zip_code: accountHolder.zip_code,
    account_number: accountHolder.account_number,
    email_verification: accountHolder.email_verification,
    mobile_number_verification: accountHolder.mobile_number_verification,
    identity_verification: accountHolder.identity_verification,
    address_verification: accountHolder.address_verification,
    identity_document_type: accountHolder.identity_document_type,
    identity_document_name: accountHolder.identity_document_name,
    identity_document_status: accountHolder.identity_document_status,
    address_document_type: accountHolder.address_document_type,
    address_document_name: accountHolder.address_document_name,
    address_document_status: accountHolder.address_document_status,
    account_status: accountHolder.account_status,
    is_patner: accountHolder.is_patner,
    affiliate_code: accountHolder.affiliate_code,
  };
}

export async function createAccountHolder({
  userId,
  firstName,
  lastName,
  email,
  language,
  mobileNumber,
  dateOfBirth,
  addressNumber,
  street,
  city,
  country,
  zipCode,
  accountNumber,
}) {
  const result = await query(
    `INSERT INTO account_holders (
      user_id, first_name, last_name, language, email, mobile_number, date_of_birth,
      address_number, street, city, country, zip_code, account_number,
      email_verification, address_verification, mobile_number_verification,
      identity_verification, account_status, is_patner,
      identity_document_status, address_document_status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'NOT_VERIFIED', 'NOT_VERIFIED', 'NOT_VERIFIED', 'NOT_VERIFIED', 'ACTIVE', 'NO', 'NOT_RECEIVED', 'NOT_RECEIVED', NOW(), NOW())`,
    [
      userId,
      firstName,
      lastName,
      language ?? null,
      email,
      mobileNumber ?? null,
      dateOfBirth ?? null,
      addressNumber ?? null,
      street ?? null,
      city ?? null,
      country ?? null,
      zipCode ?? null,
      accountNumber,
    ],
  );
  return result.insertId;
}

export async function linkPartnerClient(partnerAccountHolderId, clientAccountHolderId) {
  await query(
    `INSERT INTO partner_clients (partner_ah_id, client_ah_id, created_at, updated_at)
     VALUES (?, ?, NOW(), NOW())`,
    [partnerAccountHolderId, clientAccountHolderId],
  );
}
