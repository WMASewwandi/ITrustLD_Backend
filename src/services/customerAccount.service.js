import { query } from '../config/database.js';
import { sendEmailAndSms } from './notification.service.js';
import {
  documentsRejectedEmailHtml,
  kycApprovedEmailHtml,
  kycRejectedEmailHtml,
} from './mail.templates.js';
import {
  deriveBackDocumentFilename,
  documentExists,
  formatFileSize,
  getDocumentFileStats,
} from './documentStorage.service.js';
import {
  logSystemUserAction,
  SYSTEM_USER_ACTIONS,
} from './systemUserActionLog.service.js';
import { findUserById } from './user.service.js';
import { env } from '../config/env.js';
import {
  getLevelIdFromThresholds,
  getMembershipTierThresholds,
} from './loyaltyMembershipTier.service.js';

export const ACCOUNT_HOLDER_ID_OFFSET = 126872;

const SELECT_COLUMNS = `
  account_holders.id, account_holders.user_id, account_holders.first_name, account_holders.last_name,
  account_holders.date_of_birth, account_holders.address_number, account_holders.street,
  account_holders.city, account_holders.country,
  account_holders.email, account_holders.mobile_number, account_holders.account_number,
  account_holders.email_verification, account_holders.mobile_number_verification,
  account_holders.identity_verification, account_holders.address_verification,
  account_holders.identity_document_status, account_holders.address_document_status,
  account_holders.account_status, account_holders.is_patner, account_holders.banned_reason,
  account_holders.identity_verification_rejection_message,
  account_holders.address_verification_rejection_message,
  account_holders.identity_document_name, account_holders.identity_document_type,
  account_holders.address_document_name, account_holders.address_document_type,
  account_holders.updated_at
`;

const FILTER_WHERE = {
  // Matches Laravel loadAllPendingUsers — "All Pending Users" in admin nav.
  pending: `
    email_verification = 'VERIFIED'
    AND mobile_number_verification = 'VERIFIED'
    AND identity_document_status = 'RECEIVED'
    AND (address_verification = 'NOT_VERIFIED' OR identity_verification = 'NOT_VERIFIED')
  `,
  'address-pending': `
    email_verification = 'VERIFIED'
    AND mobile_number_verification = 'VERIFIED'
    AND identity_document_status = 'RECEIVED'
    AND address_document_status = 'RECEIVED'
    AND address_verification = 'NOT_VERIFIED'
  `,
  'nic-pending': `
    email_verification = 'VERIFIED'
    AND mobile_number_verification = 'VERIFIED'
    AND identity_document_status = 'RECEIVED'
    AND identity_verification = 'NOT_VERIFIED'
  `,
  'self-verified': `
    email_verification = 'VERIFIED'
    AND mobile_number_verification = 'VERIFIED'
    AND identity_document_status = 'NOT_RECEIVED'
  `,
  'not-confirmed': `
    email_verification = 'NOT_VERIFIED'
    AND mobile_number_verification = 'NOT_VERIFIED'
  `,
  'only-address': `
    email_verification = 'VERIFIED'
    AND mobile_number_verification = 'VERIFIED'
    AND identity_document_status = 'RECEIVED'
    AND address_verification = 'VERIFIED'
    AND identity_verification != 'VERIFIED'
  `,
  'only-nic': `
    email_verification = 'VERIFIED'
    AND mobile_number_verification = 'VERIFIED'
    AND identity_document_status = 'RECEIVED'
    AND identity_verification = 'VERIFIED'
    AND address_verification != 'VERIFIED'
  `,
  banned: `account_status = 'BANNED'`,
  // Matches Laravel loadAllUsers — email + mobile verified customers.
  all: `
    email_verification = 'VERIFIED'
    AND mobile_number_verification = 'VERIFIED'
  `,
};

function mapKycStatus(verification, documentStatus) {
  if (documentStatus !== 'RECEIVED') return 'Pending';
  switch (verification) {
    case 'VERIFIED':
      return 'Verified';
    case 'REJECTED':
      return 'Rejected';
    default:
      return 'Pending';
  }
}

function mapPartner(isPartner) {
  return isPartner === 'YES' ? 'Yes' : 'No';
}

function deriveStatus(row) {
  if (row.account_status === 'BANNED') return 'Banned';
  if (row.email_verification !== 'VERIFIED' || row.mobile_number_verification !== 'VERIFIED') {
    return 'Not Confirmed';
  }
  if (row.identity_document_status === 'NOT_RECEIVED') {
    return 'Self Verified';
  }

  const nic = mapKycStatus(row.identity_verification, row.identity_document_status);
  const address = mapKycStatus(row.address_verification, row.address_document_status);

  if (nic === 'Verified' && address === 'Verified') return 'Self Verified';
  if (nic === 'Verified' && address !== 'Verified') return 'Only NIC Verified';
  if (address === 'Verified' && nic !== 'Verified') return 'Only Address Verified';
  if (address === 'Pending' && nic === 'Verified') return 'Address Pending';
  return 'Pending';
}

export function toCustomerRow(row) {
  const firstName = row.first_name || '';
  const lastName = row.last_name || '';
  const obfuscatedId = row.id + ACCOUNT_HOLDER_ID_OFFSET;

  return {
    id: String(obfuscatedId),
    accountHolderId: row.id,
    userId: row.user_id,
    accountId: row.account_number,
    firstName,
    lastName,
    dateOfBirth: row.date_of_birth || '',
    addressNumber: row.address_number || '',
    street: row.street || '',
    city: row.city || '',
    country: row.country || '',
    name: `${firstName} ${lastName}`.trim(),
    email: row.email,
    mobile: row.mobile_number || '',
    partner: mapPartner(row.is_patner),
    userType: row.is_patner === 'YES' ? 'Affluent' : 'Normal',
    loyaltyTier: 'Normal',
    nic: mapKycStatus(row.identity_verification, row.identity_document_status),
    address: mapKycStatus(row.address_verification, row.address_document_status),
    status: deriveStatus(row),
    banned: row.account_status === 'BANNED',
    banReason: row.banned_reason || undefined,
    nicRejectReason: row.identity_verification_rejection_message || undefined,
    addressRejectReason: row.address_verification_rejection_message || undefined,
  };
}

function buildSearchClause(search = {}) {
  const conditions = [];
  const values = [];

  if (search.email) {
    conditions.push('LOWER(account_holders.email) LIKE ?');
    values.push(`%${String(search.email).trim().toLowerCase()}%`);
  }
  if (search.account_id) {
    const raw = String(search.account_id).trim();
    const numeric = Number(raw);
    if (Number.isFinite(numeric) && numeric > ACCOUNT_HOLDER_ID_OFFSET) {
      conditions.push('(account_holders.account_number LIKE ? OR account_holders.id = ?)');
      values.push(`%${raw}%`, numeric - ACCOUNT_HOLDER_ID_OFFSET);
    } else {
      conditions.push('account_holders.account_number LIKE ?');
      values.push(`%${raw}%`);
    }
  }
  if (search.primary_id) {
    conditions.push('account_holders.user_id = ?');
    values.push(search.primary_id);
  }
  if (search.first_name) {
    conditions.push('LOWER(account_holders.first_name) LIKE ?');
    values.push(`%${String(search.first_name).trim().toLowerCase()}%`);
  }
  if (search.last_name) {
    conditions.push('LOWER(account_holders.last_name) LIKE ?');
    values.push(`%${String(search.last_name).trim().toLowerCase()}%`);
  }

  const partnerFlag = resolvePartnerFlag(search);
  if (partnerFlag === 'CONFLICT') {
    return { conditions: ['1 = 0'], values: [] };
  }
  if (partnerFlag) {
    conditions.push('account_holders.is_patner = ?');
    values.push(partnerFlag);
  }

  return { conditions, values };
}

function resolvePartnerFlag(search = {}) {
  const partner = String(search.is_partner ?? search.isPartner ?? '')
    .trim()
    .toLowerCase();
  const userType = String(search.user_type ?? search.userType ?? '')
    .trim()
    .toLowerCase();

  let fromPartner = null;
  if (partner === 'yes') fromPartner = 'YES';
  if (partner === 'no') fromPartner = 'NO';

  let fromType = null;
  if (userType === 'affluent') fromType = 'YES';
  if (userType === 'normal') fromType = 'NO';

  if (fromPartner && fromType && fromPartner !== fromType) {
    return 'CONFLICT';
  }
  return fromPartner || fromType;
}

function getYearlyTierRange(thresholds, slug) {
  const normalized = String(slug || '')
    .trim()
    .toLowerCase();
  if (!normalized || normalized === 'all') return null;
  const sorted = [...thresholds].sort(
    (a, b) => (Number(a.points) || 0) - (Number(b.points) || 0),
  );
  const index = sorted.findIndex(
    (tier) =>
      String(tier.slug || '').toLowerCase() === normalized ||
      String(tier.name || '').toLowerCase() === normalized,
  );
  if (index < 0) return null;
  const next = sorted[index + 1];
  return {
    min: Number(sorted[index].points) || 0,
    maxExclusive: next ? Number(next.points) || 0 : null,
  };
}

async function attachLoyaltyFields(customers = []) {
  if (!customers.length) return customers;

  const userIds = [...new Set(customers.map((row) => row.userId).filter(Boolean))];
  if (!userIds.length) return customers;

  const thresholds = await getMembershipTierThresholds();
  const placeholders = userIds.map(() => '?').join(', ');
  const rows = await query(
    `SELECT user_id, COALESCE(SUM(point_earning_amount), 0) AS total
     FROM point_earnings
     WHERE user_id IN (${placeholders})
       AND created_at > DATE_SUB(NOW(), INTERVAL 365 DAY)
     GROUP BY user_id`,
    userIds,
  );
  const pointsByUser = Object.fromEntries(
    rows.map((row) => [row.user_id, Number(row.total) || 0]),
  );

  return customers.map((customer) => {
    const yearlyPoints = pointsByUser[customer.userId] || 0;
    const levelId = getLevelIdFromThresholds(yearlyPoints, thresholds);
    const tier = thresholds.find((item) => item.levelId === levelId);
    return {
      ...customer,
      userType: customer.partner === 'Yes' ? 'Affluent' : 'Normal',
      loyaltyTier: tier?.name || 'Normal',
      yearlyPoints,
    };
  });
}

export async function listCustomerAccounts(filter = 'pending', search = {}) {
  const filterWhere = FILTER_WHERE[filter];
  if (!filterWhere) {
    throw customerValidationError(`Unknown filter: ${filter}`);
  }
  const { conditions, values } = buildSearchClause(search);
  const whereParts = [`(${filterWhere})`, ...conditions];

  const loyaltyTier = String(search.loyalty_tier ?? search.loyaltyTier ?? '')
    .trim()
    .toLowerCase();
  let joinSql = '';
  if (loyaltyTier && loyaltyTier !== 'all') {
    const thresholds = await getMembershipTierThresholds();
    const range = getYearlyTierRange(thresholds, loyaltyTier);
    if (!range) {
      return [];
    }
    joinSql = `
      LEFT JOIN (
        SELECT user_id, SUM(point_earning_amount) AS yearly_points
        FROM point_earnings
        WHERE created_at > DATE_SUB(NOW(), INTERVAL 365 DAY)
        GROUP BY user_id
      ) pe_year ON pe_year.user_id = account_holders.user_id
    `;
    whereParts.push('COALESCE(pe_year.yearly_points, 0) >= ?');
    values.push(range.min);
    if (range.maxExclusive != null) {
      whereParts.push('COALESCE(pe_year.yearly_points, 0) < ?');
      values.push(range.maxExclusive);
    }
  }

  const sql = `
    SELECT ${SELECT_COLUMNS}
    FROM account_holders
    ${joinSql}
    WHERE ${whereParts.join(' AND ')}
    ORDER BY account_holders.id DESC
    LIMIT 1000
  `;

  const rows = await query(sql, values);
  return attachLoyaltyFields(rows.map(toCustomerRow));
}

export async function countCustomerAccounts(filter) {
  const filterWhere = FILTER_WHERE[filter];
  if (!filterWhere) return 0;

  const rows = await query(
    `SELECT COUNT(*) AS total FROM account_holders WHERE (${filterWhere})`,
    [],
  );
  return Number(rows[0]?.total ?? 0);
}

function customerValidationError(message, status = 422) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export async function findCustomerAccountById(accountHolderId) {
  const rows = await query(
    `SELECT ${SELECT_COLUMNS}
     FROM account_holders
     WHERE id = ?
     LIMIT 1`,
    [accountHolderId],
  );
  return rows[0] ? (await attachLoyaltyFields([toCustomerRow(rows[0])]))[0] : null;
}

export async function updateCustomerEmail(accountHolderId, newEmail) {
  const normalizedEmail = String(newEmail || '').trim().toLowerCase();
  if (!normalizedEmail || !normalizedEmail.includes('@')) {
    throw customerValidationError('A valid email address is required.');
  }

  const holders = await query(
    `SELECT id, user_id, email FROM account_holders WHERE id = ? LIMIT 1`,
    [accountHolderId],
  );
  const holder = holders[0];
  if (!holder) {
    throw customerValidationError('Customer not found.', 404);
  }

  if (normalizedEmail === String(holder.email || '').toLowerCase()) {
    return findCustomerAccountById(accountHolderId);
  }

  const duplicates = await query(
    `SELECT id FROM users WHERE LOWER(email) = ? AND id != ? LIMIT 1`,
    [normalizedEmail, holder.user_id],
  );
  if (duplicates[0]) {
    throw customerValidationError('This email is already registered.');
  }

  await query('UPDATE users SET email = ?, updated_at = NOW() WHERE id = ?', [
    normalizedEmail,
    holder.user_id,
  ]);
  await query('UPDATE account_holders SET email = ?, updated_at = NOW() WHERE id = ?', [
    normalizedEmail,
    accountHolderId,
  ]);

  return findCustomerAccountById(accountHolderId);
}

function formatEnumLabel(value) {
  return String(value || '')
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatTimestamp(value) {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

async function buildDocumentEntry(filename, kind, uploadedAt) {
  let stats = null;
  try {
    stats = await getDocumentFileStats(filename);
  } catch {
    stats = null;
  }
  return {
    id: filename,
    name: String(filename || '').replace(/\\/g, '/').split('/').pop() || filename,
    kind,
    filename,
    size: stats ? formatFileSize(stats.size) : 'Unavailable',
    uploadedAt: formatTimestamp(uploadedAt || stats?.mtime),
    missing: !stats,
  };
}

function identityDocumentKind(documentType) {
  if (documentType === 'NIC') return 'NIC front';
  if (documentType === 'DL') return 'Driver license';
  if (documentType === 'PASSPORT') return 'Passport';
  return formatEnumLabel(documentType) || 'NIC front';
}

export async function getCustomerKycDocuments(accountHolderId, field) {
  const normalizedField = String(field || '').toLowerCase();
  if (!['nic', 'address'].includes(normalizedField)) {
    throw customerValidationError('Invalid document type.');
  }

  const rows = await query(
    `SELECT id, identity_document_name, identity_document_type, identity_document_status,
            address_document_name, address_document_type, address_document_status, updated_at
     FROM account_holders
     WHERE id = ?
     LIMIT 1`,
    [accountHolderId],
  );
  const row = rows[0];
  if (!row) {
    throw customerValidationError('Customer not found.', 404);
  }

  const documents = [];

  if (normalizedField === 'nic' && row.identity_document_name) {
    documents.push(
      await buildDocumentEntry(
        row.identity_document_name,
        identityDocumentKind(row.identity_document_type),
        row.updated_at,
      ),
    );

    const backFilename = deriveBackDocumentFilename(row.identity_document_name);
    let hasBack = false;
    try {
      hasBack = Boolean(backFilename && (await documentExists(backFilename)));
    } catch {
      hasBack = false;
    }
    if (hasBack) {
      documents.push(
        await buildDocumentEntry(backFilename, 'NIC back', row.updated_at),
      );
    }
  }

  if (normalizedField === 'address' && row.address_document_name) {
    documents.push(
      await buildDocumentEntry(
        row.address_document_name,
        formatEnumLabel(row.address_document_type) || 'Proof of address',
        row.updated_at,
      ),
    );
  }

  return {
    documents,
    customer: await findCustomerAccountById(accountHolderId),
  };
}

async function notifyKycDecision(accountHolder, field, status, rejectionMessage) {
  const label = field === 'nic' ? 'identity' : 'address';
  const uploadUrl = `${env.userAppUrl}/verify`;
  try {
    if (status === 'VERIFIED') {
      await sendEmailAndSms({
        email: accountHolder.email,
        subject: `${label} verification approved`,
        html: kycApprovedEmailHtml(label),
        smsMessage: `Your ${label} verification has been approved.`,
        msisdn: accountHolder.mobile_number,
        userId: accountHolder.user_id,
        smsType: field === 'nic' ? 'ID_APPROVED' : 'ADDRESS_APPROVED',
      });
    } else if (status === 'REJECTED') {
      const message = rejectionMessage || 'Please resubmit your documents.';
      await sendEmailAndSms({
        email: accountHolder.email,
        subject: `${label} verification rejected`,
        html: kycRejectedEmailHtml(label, message),
        smsMessage: `Your ${label} verification has been rejected: ${message}`,
        msisdn: accountHolder.mobile_number,
        userId: accountHolder.user_id,
        smsType: field === 'nic' ? 'ID_REJECTED' : 'ADDRESS_REJECTED',
      });
      await sendEmailAndSms({
        email: accountHolder.email,
        subject: 'Documents Rejected!',
        html: documentsRejectedEmailHtml(uploadUrl, message),
        smsMessage: 'Your verification documents have been rejected. Please resubmit.',
        msisdn: accountHolder.mobile_number,
        userId: accountHolder.user_id,
        smsType: 'DOCUMENTS_REJECTED',
      });
    }
  } catch (error) {
    console.error('[kyc] notification failed:', error.message);
  }
}

export async function updateCustomerKycVerification(
  accountHolderId,
  field,
  status,
  { rejectionReason, rejectionMessage, adminUserId } = {},
) {
  const normalizedField = String(field || '').toLowerCase();
  const normalizedStatus = String(status || '').toUpperCase();

  if (!['nic', 'address'].includes(normalizedField)) {
    throw customerValidationError('Invalid document type.');
  }
  if (!['VERIFIED', 'REJECTED'].includes(normalizedStatus)) {
    throw customerValidationError('Invalid verification status.');
  }

  const holders = await query(
    `SELECT id, user_id, email, mobile_number
     FROM account_holders
     WHERE id = ?
     LIMIT 1`,
    [accountHolderId],
  );
  const holder = holders[0];
  if (!holder) {
    throw customerValidationError('Customer not found.', 404);
  }

  if (normalizedField === 'nic') {
    if (normalizedStatus === 'REJECTED') {
      const reason = String(rejectionReason || rejectionMessage || 'Rejected').trim();
      const message = String(rejectionMessage || rejectionReason || reason).trim();
      await query(
        `UPDATE account_holders
         SET identity_verification = 'REJECTED',
             identity_verification_rejection_title = ?,
             identity_verification_rejection_message = ?,
             updated_at = NOW()
         WHERE id = ?`,
        [reason, message, accountHolderId],
      );
      await notifyKycDecision(holder, 'nic', 'REJECTED', message);
      await logSystemUserAction(adminUserId, SYSTEM_USER_ACTIONS.IDENTITY_REJECT);
    } else {
      await query(
        `UPDATE account_holders
         SET identity_verification = 'VERIFIED',
             identity_verification_rejection_title = NULL,
             identity_verification_rejection_message = NULL,
             updated_at = NOW()
         WHERE id = ?`,
        [accountHolderId],
      );
      await notifyKycDecision(holder, 'nic', 'VERIFIED');
      await logSystemUserAction(adminUserId, SYSTEM_USER_ACTIONS.IDENTITY_APPROVE);
    }
  } else if (normalizedStatus === 'REJECTED') {
    const reason = String(rejectionReason || rejectionMessage || 'Rejected').trim();
    const message = String(rejectionMessage || rejectionReason || reason).trim();
    await query(
      `UPDATE account_holders
       SET address_verification = 'REJECTED',
           address_verification_rejection_title = ?,
           address_verification_rejection_message = ?,
           updated_at = NOW()
       WHERE id = ?`,
      [reason, message, accountHolderId],
    );
    await notifyKycDecision(holder, 'address', 'REJECTED', message);
    await logSystemUserAction(adminUserId, SYSTEM_USER_ACTIONS.ADDRESS_REJECT);
  } else {
    await query(
      `UPDATE account_holders
       SET address_verification = 'VERIFIED',
           address_verification_rejection_title = NULL,
           address_verification_rejection_message = NULL,
           updated_at = NOW()
       WHERE id = ?`,
      [accountHolderId],
    );
    await notifyKycDecision(holder, 'address', 'VERIFIED');
    await logSystemUserAction(adminUserId, SYSTEM_USER_ACTIONS.ADDRESS_APPROVE);
  }

  return findCustomerAccountById(accountHolderId);
}

function allocateUniqueAffiliateCode(length = 8) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < length; i += 1) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return code;
}

async function generateUniqueAffiliateCode() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const code = allocateUniqueAffiliateCode();
    const rows = await query(
      `SELECT id FROM account_holders WHERE affiliate_code = ? LIMIT 1`,
      [code],
    );
    if (!rows[0]) return code;
  }
  throw customerValidationError('Could not allocate affiliate code. Please try again.');
}

async function notifyAccountBanned(accountHolder) {
  try {
    await sendEmailAndSms({
      email: accountHolder.email,
      subject: 'Account banned',
      html: '<p>Your iTrustLD account has been banned. Please contact support for assistance.</p>',
      smsMessage: 'Your iTrustLD account has been banned. Please contact support for assistance.',
      msisdn: accountHolder.mobile_number,
      userId: accountHolder.user_id,
      smsType: 'ACCOUNT_BANNED',
    });
  } catch (error) {
    console.error('[ban] notification failed:', error.message);
  }
}

async function notifyPartnerAccountCreated(accountHolder) {
  try {
    const user = await findUserById(accountHolder.user_id);
    const profileUrl = `${env.userAppUrl}/dashboard`;
    await sendEmailAndSms({
      email: accountHolder.email,
      subject: 'Partner account created',
      html: `<p>Hi ${user?.name || 'there'}, your partner account has been successfully created. <a href="${profileUrl}">Open your dashboard</a> to get started.</p>`,
      smsMessage:
        'Your partner account has been successfully created! Start earning commissions with your audience.',
      msisdn: accountHolder.mobile_number,
      userId: accountHolder.user_id,
      smsType: 'PARTNER_ACCOUNT_CREATED',
    });
  } catch (error) {
    console.error('[partner] notification failed:', error.message);
  }
}

/**
 * Promote a normal account holder to affiliate/partner and allocate an affiliate code.
 * No-op if already a partner. Returns true when status changed.
 */
export async function promoteUserToPartnerByUserId(userId, { notify = true } = {}) {
  const holders = await query(
    `SELECT id, user_id, email, mobile_number, affiliate_code, is_patner
     FROM account_holders
     WHERE user_id = ?
     LIMIT 1`,
    [userId],
  );
  const holder = holders[0];
  if (!holder) return false;
  if (String(holder.is_patner || '').toUpperCase() === 'YES') return false;

  let affiliateCode = holder.affiliate_code;
  if (!affiliateCode) {
    affiliateCode = await generateUniqueAffiliateCode();
  }

  await query(
    `UPDATE account_holders
     SET is_patner = 'YES', affiliate_code = ?, updated_at = NOW()
     WHERE id = ?`,
    [affiliateCode, holder.id],
  );

  if (notify) {
    await notifyPartnerAccountCreated({ ...holder, affiliate_code: affiliateCode });
  }

  return true;
}

export async function updateCustomerAccountStatus(
  accountHolderId,
  accountStatus,
  { bannedReason } = {},
) {
  const normalizedStatus = String(accountStatus || '').toUpperCase();
  if (!['ACTIVE', 'BANNED'].includes(normalizedStatus)) {
    throw customerValidationError('Invalid account status.');
  }

  if (normalizedStatus === 'BANNED' && !String(bannedReason || '').trim()) {
    throw customerValidationError('A reason for ban is required.');
  }

  const holders = await query(
    `SELECT id, user_id, email, mobile_number, account_status
     FROM account_holders
     WHERE id = ?
     LIMIT 1`,
    [accountHolderId],
  );
  const holder = holders[0];
  if (!holder) {
    throw customerValidationError('Customer not found.', 404);
  }

  const oldStatus = holder.account_status;
  await query(
    `UPDATE account_holders
     SET account_status = ?,
         banned_reason = ?,
         updated_at = NOW()
     WHERE id = ?`,
    [
      normalizedStatus,
      normalizedStatus === 'BANNED' ? String(bannedReason || '').trim() || null : null,
      accountHolderId,
    ],
  );

  if (normalizedStatus === 'BANNED' && oldStatus !== 'BANNED') {
    await notifyAccountBanned(holder);
  }

  return findCustomerAccountById(accountHolderId);
}

export async function updateMultipleCustomerAccountStatus(
  accountHolderIds,
  accountStatus,
  { bannedReason } = {},
) {
  const ids = Array.isArray(accountHolderIds) ? accountHolderIds : [];
  if (!ids.length) {
    throw customerValidationError('No account holders selected.');
  }

  const results = [];
  for (const accountHolderId of ids) {
    const customer = await updateCustomerAccountStatus(Number(accountHolderId), accountStatus, {
      bannedReason,
    });
    if (customer) results.push(customer);
  }

  return results;
}

export async function updateCustomerPartnerStatus(accountHolderId, isPartner) {
  const holders = await query(
    `SELECT id, user_id, email, mobile_number, affiliate_code, is_patner
     FROM account_holders
     WHERE id = ?
     LIMIT 1`,
    [accountHolderId],
  );
  const holder = holders[0];
  if (!holder) {
    throw customerValidationError('Customer not found.', 404);
  }

  if (isPartner) {
    await promoteUserToPartnerByUserId(holder.user_id, { notify: true });
  } else {
    await query(
      `UPDATE account_holders SET is_patner = 'NO', updated_at = NOW() WHERE id = ?`,
      [accountHolderId],
    );
  }

  return findCustomerAccountById(accountHolderId);
}

export { FILTER_WHERE as CUSTOMER_FILTER_WHERE };
