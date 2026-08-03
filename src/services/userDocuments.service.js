import {
  ADDRESS_TYPE_FROM_API,
  IDENTITY_TYPE_FROM_API,
} from '../shared/verificationDocumentTypes.js';
import { getVerificationStep } from './verification.service.js';
import {
  deriveBackDocumentFilename,
  documentExists,
} from './documentStorage.service.js';

function formatYmd(value) {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function mapVerificationStatus(verification, documentStatus) {
  if (verification === 'VERIFIED') return 'Completed';
  if (verification === 'REJECTED') return 'Rejected';
  if (documentStatus === 'RECEIVED') return 'In-Progress';
  return 'Pending';
}

function formatDocTypeLabel(apiType, fallback = '—') {
  if (!apiType) return fallback;
  const identity = IDENTITY_TYPE_FROM_API[apiType];
  if (identity) return identity;
  const address = ADDRESS_TYPE_FROM_API[apiType];
  if (address) return address;
  return String(apiType)
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export async function buildDocumentRows(accountHolder) {
  if (!accountHolder) return [];

  const docs = [];
  const identityType = accountHolder.identity_document_type;
  const isNic = String(identityType || '').toUpperCase() === 'NIC';
  const identityUpdated =
    accountHolder.identity_document_status === 'RECEIVED' ? formatYmd(accountHolder.updated_at) : '—';
  const addressUpdated =
    accountHolder.address_document_status === 'RECEIVED' ? formatYmd(accountHolder.updated_at) : '—';
  const identityReason =
    accountHolder.identity_verification === 'REJECTED'
      ? accountHolder.identity_verification_rejection_message ||
        accountHolder.identity_verification_rejection_title ||
        'Identity document was rejected. Please re-upload.'
      : null;
  const addressReason =
    accountHolder.address_verification === 'REJECTED'
      ? accountHolder.address_verification_rejection_message ||
        accountHolder.address_verification_rejection_title ||
        'Address document was rejected. Please re-upload.'
      : null;

  docs.push({
    id: 'identity_front',
    key: 'identity_front',
    name: isNic ? 'National ID (Front)' : 'Identity Document',
    type: 'Identity',
    document_type: formatDocTypeLabel(identityType, '—'),
    status: mapVerificationStatus(
      accountHolder.identity_verification,
      accountHolder.identity_document_status,
    ),
    updated: identityUpdated,
    reason: identityReason,
  });

  if (isNic) {
    let backStatus = 'Pending';
    if (accountHolder.identity_document_name) {
      const backFilename = deriveBackDocumentFilename(accountHolder.identity_document_name);
      const hasBack = backFilename ? await documentExists(backFilename) : false;
      if (hasBack) {
        backStatus = mapVerificationStatus(
          accountHolder.identity_verification,
          accountHolder.identity_document_status,
        );
      }
    }
    docs.push({
      id: 'identity_back',
      key: 'identity_back',
      name: 'National ID (Back)',
      type: 'Identity',
      document_type: 'National Identity Card (Both sides)',
      status: backStatus,
      updated: backStatus === 'Pending' ? '—' : identityUpdated,
      reason: identityReason,
    });
  }

  docs.push({
    id: 'address',
    key: 'address',
    name: 'Proof of Address',
    type: 'Residential',
    document_type: formatDocTypeLabel(accountHolder.address_document_type, '—'),
    status: mapVerificationStatus(
      accountHolder.address_verification,
      accountHolder.address_document_status,
    ),
    updated: addressUpdated,
    reason: addressReason,
  });

  return docs;
}

async function loadAccountHolderForDocuments(userId) {
  const { query } = await import('../config/database.js');
  const rows = await query(
    `SELECT id, user_id, first_name, last_name, email, mobile_number,
            email_verification, mobile_number_verification,
            identity_verification, address_verification,
            identity_document_type, identity_document_name, identity_document_status,
            address_document_type, address_document_name, address_document_status,
            identity_verification_rejection_title, identity_verification_rejection_message,
            address_verification_rejection_title, address_verification_rejection_message,
            updated_at, created_at
     FROM account_holders
     WHERE user_id = ?
     LIMIT 1`,
    [userId],
  );
  return rows[0] ?? null;
}

function canUploadIdentity(accountHolder) {
  if (!accountHolder) return false;
  return (
    accountHolder.identity_document_status !== 'RECEIVED' ||
    accountHolder.identity_verification === 'REJECTED'
  );
}

function canUploadAddress(accountHolder) {
  if (!accountHolder) return false;
  return (
    accountHolder.address_document_status !== 'RECEIVED' ||
    accountHolder.address_verification === 'REJECTED'
  );
}

export async function getUserVerificationDocuments(userId) {
  const accountHolder = await loadAccountHolderForDocuments(userId);
  const documents = await buildDocumentRows(accountHolder);

  const summary = {
    pending: documents.filter((doc) => doc.status === 'Pending').length,
    in_progress: documents.filter((doc) => doc.status === 'In-Progress').length,
    completed: documents.filter((doc) => doc.status === 'Completed').length,
    rejected: documents.filter((doc) => doc.status === 'Rejected').length,
  };

  const verificationComplete =
    accountHolder?.email_verification === 'VERIFIED' &&
    accountHolder?.mobile_number_verification === 'VERIFIED' &&
    accountHolder?.identity_verification === 'VERIFIED' &&
    accountHolder?.address_verification === 'VERIFIED';

  return {
    ok: true,
    verification_complete: verificationComplete,
    verification_step: getVerificationStep(accountHolder),
    email_verified: accountHolder?.email_verification === 'VERIFIED',
    phone_verified: accountHolder?.mobile_number_verification === 'VERIFIED',
    can_upload_documents:
      accountHolder?.email_verification === 'VERIFIED' &&
      accountHolder?.mobile_number_verification === 'VERIFIED',
    can_upload_identity: canUploadIdentity(accountHolder),
    can_upload_address: canUploadAddress(accountHolder),
    identity_document_type: accountHolder?.identity_document_type || null,
    address_document_type: accountHolder?.address_document_type || null,
    documents,
    summary,
  };
}
