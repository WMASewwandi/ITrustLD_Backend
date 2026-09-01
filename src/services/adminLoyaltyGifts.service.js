import { query } from '../config/database.js';
import { formatTimestampSl, formatYmdColombo, nowSqlDateTime, parseDbDateTime } from '../utils/slTime.js';
import { ensureLoyaltyGiftSchema } from './loyaltyGiftSchema.service.js';
import { scheduleGiftNotify } from './loyaltyNotify.service.js';
import {
  logSystemUserAction,
  SYSTEM_USER_ACTIONS,
} from './systemUserActionLog.service.js';

const VALID_LEVELS = ['NORMAL', 'SILVER', 'GOLD', 'DIAMOND', 'VIP', 'VVIP'];
const VALID_AUDIENCE_TYPES = ['normal', 'affiliate', 'both'];

function normalizeAudienceType(value) {
  const normalized = String(value || 'normal').trim().toLowerCase();
  if (normalized === 'standard') return 'normal';
  if (normalized === 'partner') return 'affiliate';
  if (VALID_AUDIENCE_TYPES.includes(normalized)) return normalized;
  return 'normal';
}

function audienceTypeLabel(value) {
  const type = normalizeAudienceType(value);
  if (type === 'affiliate') return 'Affiliate';
  if (type === 'both') return 'Both';
  return 'Normal';
}

function legacyIsAffiliate(audienceType) {
  return normalizeAudienceType(audienceType) === 'affiliate' ? 1 : 0;
}

function validationError(message, status = 422) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function formatYmd(value) {
  const date = parseDbDateTime(value);
  if (!date) return null;
  return formatYmdColombo(date);
}

function formatYmdHis(value) {
  const formatted = formatTimestampSl(value);
  if (!formatted) return '—';
  return formatted.slice(0, 16);
}

function parseAllowedLevels(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || '').trim().toUpperCase()).filter(Boolean);
  }
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed.map((item) => String(item || '').trim().toUpperCase()).filter(Boolean);
      }
    } catch {
      return value
        .split(',')
        .map((item) => item.trim().toUpperCase())
        .filter(Boolean);
    }
  }
  return [];
}

function serializeAllowedLevels(levels) {
  const normalized = levels
    .map((item) => String(item || '').trim().toUpperCase())
    .filter((item) => VALID_LEVELS.includes(item));
  return JSON.stringify(normalized);
}

function parseExpiresAtInput(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return parseDbDateTime(`${raw} 23:59:59`);
  }

  return parseDbDateTime(raw);
}

function toExpiresAtSql(value) {
  const date = parseExpiresAtInput(value);
  if (!date) return null;
  return formatTimestampSl(date) || null;
}

function mapGiftRow(row) {
  const levels = parseAllowedLevels(row.allowed_levels);
  const audienceType = normalizeAudienceType(row.audience_type ?? (row.is_affiliate ? 'affiliate' : 'normal'));
  const expiresAt = parseDbDateTime(row.expires_at);
  const createdAt = parseDbDateTime(row.created_at);
  const isExpired = Boolean(expiresAt && expiresAt.getTime() <= Date.now());

  return {
    id: row.id,
    title: row.title,
    description: row.description || '',
    audience_type: audienceType,
    audience: audienceType,
    audience_label: audienceTypeLabel(audienceType),
    is_affiliate: audienceType === 'affiliate',
    allowed_levels: levels,
    is_active: Boolean(row.is_active),
    created_at: createdAt ? createdAt.toISOString() : null,
    created_at_label: formatYmdHis(row.created_at),
    updated_at: formatYmdHis(row.updated_at),
    expires_at: expiresAt ? expiresAt.toISOString() : null,
    expires_at_date: expiresAt ? formatYmd(expiresAt) : '',
    expires_at_label: expiresAt ? formatYmdHis(expiresAt) : null,
    is_expired: isExpired,
  };
}

function mapClaimRow(row) {
  const levels = parseAllowedLevels(row.gift_allowed_levels);
  return {
    id: row.id,
    gift_id: row.gift_id,
    gift_title: row.gift_title || '—',
    user_id: row.user_id,
    customer: row.customer_name || '—',
    account_id: row.account_id || '—',
    delivery_address: row.delivery_address || '',
    contact_phone: row.contact_phone || '',
    status: row.status || 'Pending',
    rejection_reason: row.rejection_reason || '',
    date: formatYmdHis(row.created_at),
    processed_at: row.processed_at ? formatYmdHis(row.processed_at) : '',
    admin: row.admin_name || '',
    allowed_levels: levels,
    audience: audienceTypeLabel(row.audience_type ?? (row.is_affiliate ? 'affiliate' : 'normal')),
  };
}

function buildAdminDateFilter(filter, fromDate, toDate) {
  const normalized = String(filter || '').trim().toLowerCase();
  const today = new Date();
  const end = formatYmd(today);

  switch (normalized) {
    case 'today':
      return { fromDate: end, toDate: end };
    case 'yesterday': {
      const y = new Date(today);
      y.setDate(y.getDate() - 1);
      const day = formatYmd(y);
      return { fromDate: day, toDate: day };
    }
    case 'last7days': {
      const from = new Date(today);
      from.setDate(from.getDate() - 7);
      return { fromDate: formatYmd(from), toDate: end };
    }
    case 'lastmonth': {
      const from = new Date(today);
      from.setMonth(from.getMonth() - 1);
      return { fromDate: formatYmd(from), toDate: end };
    }
    case 'last6months': {
      const from = new Date(today);
      from.setMonth(from.getMonth() - 6);
      return { fromDate: formatYmd(from), toDate: end };
    }
    case 'currentyear':
      return { fromDate: `${today.getFullYear()}-01-01`, toDate: end };
    case 'lastyear':
      return {
        fromDate: `${today.getFullYear() - 1}-01-01`,
        toDate: `${today.getFullYear() - 1}-12-31`,
      };
    case 'customdate':
      return { fromDate: fromDate || null, toDate: toDate || null };
    default:
      return { fromDate: null, toDate: null };
  }
}

export async function listGiftsForAdmin(audience = 'all') {
  await ensureLoyaltyGiftSchema();

  const normalized = String(audience).trim().toLowerCase();
  const conditions = ['is_deleted = 0'];
  const values = [];

  if (normalized === 'standard' || normalized === 'normal') {
    conditions.push(`(audience_type IN ('normal', 'both') OR (audience_type IS NULL AND is_affiliate = 0))`);
  } else if (normalized === 'affiliate' || normalized === 'partner') {
    conditions.push(`(audience_type IN ('affiliate', 'both') OR (audience_type IS NULL AND is_affiliate = 1))`);
  } else if (normalized === 'both') {
    conditions.push(`audience_type = 'both'`);
  }

  const rows = await query(
    `SELECT *
     FROM loyalty_gifts
     WHERE ${conditions.join(' AND ')}
     ORDER BY id DESC`,
    values,
  );

  return { gifts: rows.map(mapGiftRow) };
}

export async function createGift(adminUserId, payload = {}) {
  await ensureLoyaltyGiftSchema();

  const title = String(payload.title || '').trim();
  if (!title) throw validationError('Gift title is required.');

  const audienceType = normalizeAudienceType(
    payload.audience_type ?? payload.audienceType ?? payload.audience ??
      (payload.is_affiliate ?? payload.isAffiliate ? 'affiliate' : 'normal'),
  );
  const allowedLevels = parseAllowedLevels(payload.allowed_levels ?? payload.allowedLevels);
  const validLevels = allowedLevels.filter((level) => VALID_LEVELS.includes(level));
  if (!validLevels.length) {
    throw validationError('Select at least one allowed loyalty level.');
  }

  const description = String(payload.description || '').trim();
  const expiresAtSql = toExpiresAtSql(payload.expires_at ?? payload.expiresAt ?? payload.expiry_date);
  if (!expiresAtSql) {
    throw validationError('Expiration date is required.');
  }
  if (parseDbDateTime(expiresAtSql).getTime() <= Date.now()) {
    throw validationError('Expiration date must be in the future.');
  }

  const result = await query(
    `INSERT INTO loyalty_gifts (title, description, audience_type, is_affiliate, allowed_levels, expires_at, is_active, is_deleted, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?, NOW(), NOW())`,
    [
      title,
      description || null,
      audienceType,
      legacyIsAffiliate(audienceType),
      serializeAllowedLevels(validLevels),
      expiresAtSql,
      adminUserId,
    ],
  );

  scheduleGiftNotify({
    notifyUsersByEmail: payload.notifyUsersByEmail ?? payload.notify_users ?? payload.notifyUsers,
    title,
    audienceType,
    allowedLevels: validLevels,
    isUpdate: false,
  });

  return { ok: true, id: result.insertId };
}

export async function updateGift(payload = {}) {
  await ensureLoyaltyGiftSchema();

  const giftId = Number(payload.gift_id ?? payload.id);
  if (!giftId) throw validationError('Gift id is required.');

  const title = String(payload.title || '').trim();
  if (!title) throw validationError('Gift title is required.');

  const allowedLevels = parseAllowedLevels(payload.allowed_levels ?? payload.allowedLevels);
  const validLevels = allowedLevels.filter((level) => VALID_LEVELS.includes(level));
  if (!validLevels.length) {
    throw validationError('Select at least one allowed loyalty level.');
  }

  const description = String(payload.description || '').trim();
  const audienceType = normalizeAudienceType(
    payload.audience_type ?? payload.audienceType ?? payload.audience,
  );
  const expiresAtSql = toExpiresAtSql(payload.expires_at ?? payload.expiresAt ?? payload.expiry_date);
  if (!expiresAtSql) {
    throw validationError('Expiration date is required.');
  }

  const existing = await query(
    `SELECT id FROM loyalty_gifts WHERE id = ? AND is_deleted = 0 LIMIT 1`,
    [giftId],
  );
  if (!existing[0]) throw validationError('Gift not found.', 404);

  await query(
    `UPDATE loyalty_gifts
     SET title = ?, description = ?, audience_type = ?, is_affiliate = ?, allowed_levels = ?, expires_at = ?, updated_at = NOW()
     WHERE id = ? AND is_deleted = 0`,
    [
      title,
      description || null,
      audienceType,
      legacyIsAffiliate(audienceType),
      serializeAllowedLevels(validLevels),
      expiresAtSql,
      giftId,
    ],
  );

  scheduleGiftNotify({
    notifyUsersByEmail: payload.notifyUsersByEmail ?? payload.notify_users ?? payload.notifyUsers,
    title,
    audienceType,
    allowedLevels: validLevels,
    isUpdate: true,
  });

  return { ok: true };
}

export async function updateGiftState(payload = {}) {
  await ensureLoyaltyGiftSchema();

  const giftId = Number(payload.gift_id ?? payload.id);
  if (!giftId) throw validationError('Gift id is required.');

  const existing = await query(
    `SELECT id FROM loyalty_gifts WHERE id = ? AND is_deleted = 0 LIMIT 1`,
    [giftId],
  );
  if (!existing[0]) throw validationError('Gift not found.', 404);

  const isActive = Boolean(payload.is_active ?? payload.isActive ?? payload.activation_state ?? payload.activationState);
  await query(
    `UPDATE loyalty_gifts SET is_active = ?, updated_at = NOW() WHERE id = ? AND is_deleted = 0`,
    [isActive ? 1 : 0, giftId],
  );

  return { ok: true };
}

export async function deleteGift(payload = {}) {
  await ensureLoyaltyGiftSchema();

  const giftId = Number(payload.gift_id ?? payload.id);
  if (!giftId) throw validationError('Gift id is required.');

  await query(
    `UPDATE loyalty_gifts SET is_deleted = 1, is_active = 0, updated_at = NOW() WHERE id = ?`,
    [giftId],
  );

  return { ok: true };
}

export async function listGiftClaimsForAdmin(params = {}) {
  await ensureLoyaltyGiftSchema();

  const page = Math.max(1, Number(params.page) || 1);
  const perPage = Math.min(100, Math.max(1, Number(params.per_page ?? params.perPage) || 20));
  const offset = (page - 1) * perPage;
  const status = String(params.status || 'Pending').trim();
  const keyword = String(params.keyword || params.search || '').trim();
  const { fromDate, toDate } = buildAdminDateFilter(
    params.filter ?? params.duration,
    params.from_date ?? params.fromDate ?? params.from,
    params.to_date ?? params.toDate ?? params.to,
  );

  const conditions = ['1=1'];
  const values = [];

  if (status && status !== 'All') {
    conditions.push('lgc.status = ?');
    values.push(status);
  }

  if (keyword) {
    conditions.push(`(
      CAST(lgc.id AS CHAR) LIKE ?
      OR ah.account_number LIKE ?
      OR CONCAT(ah.first_name, ' ', ah.last_name) LIKE ?
      OR lg.title LIKE ?
      OR lgc.delivery_address LIKE ?
    )`);
    const like = `%${keyword}%`;
    values.push(like, like, like, like, like);
  }

  if (fromDate) {
    conditions.push('DATE(lgc.created_at) >= ?');
    values.push(fromDate);
  }
  if (toDate) {
    conditions.push('DATE(lgc.created_at) <= ?');
    values.push(toDate);
  }

  const where = conditions.join(' AND ');
  const countRows = await query(
    `SELECT COUNT(*) AS total
     FROM loyalty_gift_claims lgc
     INNER JOIN loyalty_gifts lg ON lg.id = lgc.gift_id
     LEFT JOIN account_holders ah ON ah.user_id = lgc.user_id
     WHERE ${where}`,
    values,
  );
  const total = Number(countRows[0]?.total ?? 0);

  const rows = await query(
    `SELECT lgc.*,
            lg.title AS gift_title,
            lg.allowed_levels AS gift_allowed_levels,
            lg.audience_type,
            lg.is_affiliate,
            ah.account_number AS account_id,
            CONCAT(COALESCE(ah.first_name, ''), ' ', COALESCE(ah.last_name, '')) AS customer_name,
            u.name AS admin_name
     FROM loyalty_gift_claims lgc
     INNER JOIN loyalty_gifts lg ON lg.id = lgc.gift_id
     LEFT JOIN account_holders ah ON ah.user_id = lgc.user_id
     LEFT JOIN users u ON u.id = lgc.processed_by
     WHERE ${where}
     ORDER BY lgc.id DESC
     LIMIT ? OFFSET ?`,
    [...values, perPage, offset],
  );

  return {
    claims: rows.map(mapClaimRow),
    pagination: {
      page,
      per_page: perPage,
      total,
      total_pages: Math.max(1, Math.ceil(total / perPage)),
    },
  };
}

export async function approveGiftClaim(adminUserId, payload = {}) {
  await ensureLoyaltyGiftSchema();

  const claimId = Number(payload.claim_id ?? payload.id);
  if (!claimId) throw validationError('Claim id is required.');

  const rows = await query(`SELECT * FROM loyalty_gift_claims WHERE id = ? LIMIT 1`, [claimId]);
  const claim = rows[0];
  if (!claim) throw validationError('Gift claim not found.', 404);
  if (claim.status !== 'Pending') throw validationError('Only pending claims can be approved.');

  const processedAtSl = nowSqlDateTime();
  await query(
    `UPDATE loyalty_gift_claims
     SET status = 'Approved', processed_by = ?, processed_at = ?, updated_at = ?
     WHERE id = ?`,
    [adminUserId, processedAtSl, processedAtSl, claimId],
  );

  await logSystemUserAction(adminUserId, SYSTEM_USER_ACTIONS.VOUCHER_CLAIM_APPROVE);

  return { ok: true };
}

export async function rejectGiftClaim(adminUserId, payload = {}) {
  await ensureLoyaltyGiftSchema();

  const claimId = Number(payload.claim_id ?? payload.id);
  if (!claimId) throw validationError('Claim id is required.');

  const reason = String(payload.rejection_reason ?? payload.rejectionReason ?? '').trim();
  if (!reason) throw validationError('Rejection reason is required.');

  const rows = await query(`SELECT * FROM loyalty_gift_claims WHERE id = ? LIMIT 1`, [claimId]);
  const claim = rows[0];
  if (!claim) throw validationError('Gift claim not found.', 404);
  if (claim.status !== 'Pending') throw validationError('Only pending claims can be rejected.');

  const processedAtSl = nowSqlDateTime();
  await query(
    `UPDATE loyalty_gift_claims
     SET status = 'Rejected', rejection_reason = ?, processed_by = ?, processed_at = ?, updated_at = ?
     WHERE id = ?`,
    [reason, adminUserId, processedAtSl, processedAtSl, claimId],
  );

  await logSystemUserAction(adminUserId, SYSTEM_USER_ACTIONS.VOUCHER_CLAIM_REJECT);

  return { ok: true };
}

export async function markGiftClaimDelivered(adminUserId, payload = {}) {
  await ensureLoyaltyGiftSchema();

  const claimId = Number(payload.claim_id ?? payload.id);
  if (!claimId) throw validationError('Claim id is required.');

  const rows = await query(`SELECT * FROM loyalty_gift_claims WHERE id = ? LIMIT 1`, [claimId]);
  const claim = rows[0];
  if (!claim) throw validationError('Gift claim not found.', 404);
  if (claim.status !== 'Approved') throw validationError('Only approved claims can be marked delivered.');

  const processedAtSl = nowSqlDateTime();
  await query(
    `UPDATE loyalty_gift_claims
     SET status = 'Delivered', processed_by = ?, processed_at = ?, updated_at = ?
     WHERE id = ?`,
    [adminUserId, processedAtSl, processedAtSl, claimId],
  );

  return { ok: true };
}

export async function countPendingGiftClaims() {
  await ensureLoyaltyGiftSchema();
  const rows = await query(
    `SELECT COUNT(*) AS total FROM loyalty_gift_claims WHERE status = 'Pending'`,
    [],
  );
  return Number(rows[0]?.total ?? 0);
}
