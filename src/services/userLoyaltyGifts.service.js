import { query } from '../config/database.js';
import { findAccountHolderByUserId } from './accountHolder.service.js';
import { getLevelLabel, getUserPointLevel } from './pointEarning.service.js';
import { ensureLoyaltyGiftSchema } from './loyaltyGiftSchema.service.js';
import { formatTimestampSl } from '../utils/slTime.js';

function giftMatchesUserAudience(audienceType, isPartner) {
  const type = normalizeAudienceType(audienceType);
  if (type === 'both') return true;
  if (isPartner) return type === 'affiliate';
  return type === 'normal';
}

function normalizeAudienceType(value) {
  const normalized = String(value || 'normal').trim().toLowerCase();
  if (normalized === 'standard') return 'normal';
  if (normalized === 'partner') return 'affiliate';
  if (['normal', 'affiliate', 'both'].includes(normalized)) return normalized;
  return 'normal';
}

const PARTNER_TIER_THRESHOLDS = [
  { id: 'normal', name: 'Normal', levelPoints: 0 },
  { id: 'silver', name: 'Silver', levelPoints: 10000 },
  { id: 'gold', name: 'Gold', levelPoints: 50000 },
  { id: 'diamond', name: 'Diamond', levelPoints: 100000 },
  { id: 'vip', name: 'VIP', levelPoints: 500000 },
  { id: 'vvip', name: 'VVIP', levelPoints: 1000000 },
];

function validationError(message, status = 422) {
  const error = new Error(message);
  error.status = status;
  return error;
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

function formatYmdHis(value) {
  const formatted = formatTimestampSl(value);
  if (!formatted) return '—';
  return formatted.slice(0, 16);
}

async function getPartnerTierName(userId) {
  const rows = await query(
    `SELECT COALESCE(SUM(point_earning_amount), 0) AS earned_for_year
     FROM point_earnings
     WHERE user_id = ?
       AND created_at >= DATE_SUB(NOW(), INTERVAL 1 YEAR)`,
    [userId],
  );
  const earned = Number(rows[0]?.earned_for_year ?? 0);
  let tier = PARTNER_TIER_THRESHOLDS[0];
  for (const candidate of PARTNER_TIER_THRESHOLDS) {
    if (earned >= candidate.levelPoints) tier = candidate;
  }
  return tier.name.toUpperCase();
}

async function resolveUserLevelLabel(userId, isPartner) {
  if (isPartner) {
    return getPartnerTierName(userId);
  }
  const pointLevel = await getUserPointLevel(userId);
  const levelId = Number(pointLevel?.point_level_id) || 1;
  return getLevelLabel(levelId);
}

function mapGiftRow(row, userLevel, existingClaim) {
  const allowedLevels = parseAllowedLevels(row.allowed_levels);
  const levelAllowed = allowedLevels.includes(userLevel);
  const alreadyClaimed = Boolean(existingClaim);
  const claimStatus = existingClaim?.status || null;

  return {
    id: row.id,
    title: row.title,
    description: row.description || '',
    allowed_levels: allowedLevels,
    is_eligible: levelAllowed && !alreadyClaimed,
    already_claimed: alreadyClaimed,
    claim_status: claimStatus,
    claim_id: existingClaim?.id || null,
  };
}

export async function listAvailableGiftsForUser(userId) {
  await ensureLoyaltyGiftSchema();

  const accountHolder = await findAccountHolderByUserId(userId);
  if (!accountHolder) throw validationError('Account not found.', 404);

  const isPartner = String(accountHolder.is_patner || '').toUpperCase() === 'YES';
  const userLevel = await resolveUserLevelLabel(userId, isPartner);

  const giftRows = await query(
    `SELECT *
     FROM loyalty_gifts
     WHERE is_deleted = 0
       AND is_active = 1
       AND (
         audience_type = 'both'
         OR audience_type = ?
         OR (audience_type IS NULL AND is_affiliate = ?)
       )
     ORDER BY id DESC`,
    [isPartner ? 'affiliate' : 'normal', isPartner ? 1 : 0],
  );

  const claimRows = await query(
    `SELECT lgc.*
     FROM loyalty_gift_claims lgc
     INNER JOIN loyalty_gifts lg ON lg.id = lgc.gift_id
     WHERE lgc.user_id = ?`,
    [userId],
  );

  const claimsByGiftId = new Map(claimRows.map((row) => [row.gift_id, row]));

  return {
    user_level: userLevel,
    is_partner: isPartner,
    gifts: giftRows.map((row) => mapGiftRow(row, userLevel, claimsByGiftId.get(row.id))),
  };
}

export async function createGiftClaim(userId, payload = {}) {
  await ensureLoyaltyGiftSchema();

  const giftId = Number(payload.gift_id ?? payload.giftId);
  if (!giftId) throw validationError('Gift is required.');

  const deliveryAddress = String(payload.delivery_address ?? payload.deliveryAddress ?? '').trim();
  if (!deliveryAddress || deliveryAddress.length < 10) {
    throw validationError('Please enter a complete delivery address.');
  }

  const contactPhone = String(payload.contact_phone ?? payload.contactPhone ?? '').trim();

  const accountHolder = await findAccountHolderByUserId(userId);
  if (!accountHolder) throw validationError('Account not found.', 404);

  const isPartner = String(accountHolder.is_patner || '').toUpperCase() === 'YES';
  const userLevel = await resolveUserLevelLabel(userId, isPartner);

  const giftRows = await query(
    `SELECT * FROM loyalty_gifts WHERE id = ? AND is_deleted = 0 AND is_active = 1 LIMIT 1`,
    [giftId],
  );
  const gift = giftRows[0];
  if (!gift) throw validationError('Gift not found or no longer available.', 404);

  const giftAudience = gift.audience_type ?? (gift.is_affiliate ? 'affiliate' : 'normal');
  if (!giftMatchesUserAudience(giftAudience, isPartner)) {
    throw validationError('This gift is not available for your account type.');
  }

  const allowedLevels = parseAllowedLevels(gift.allowed_levels);
  if (!allowedLevels.includes(userLevel)) {
    throw validationError(`Your current level (${userLevel}) is not eligible for this gift.`);
  }

  const existingRows = await query(
    `SELECT id, status FROM loyalty_gift_claims WHERE gift_id = ? AND user_id = ? LIMIT 1`,
    [giftId, userId],
  );
  if (existingRows.length) {
    throw validationError('You have already claimed this gift.');
  }

  const result = await query(
    `INSERT INTO loyalty_gift_claims (gift_id, user_id, delivery_address, contact_phone, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'Pending', NOW(), NOW())`,
    [giftId, userId, deliveryAddress, contactPhone || null],
  );

  return {
    ok: true,
    claim_id: result.insertId,
    message: 'Gift claim submitted. Our team will review your delivery details.',
  };
}

export async function listUserGiftClaims(userId) {
  await ensureLoyaltyGiftSchema();

  const rows = await query(
    `SELECT lgc.*, lg.title AS gift_title, lg.allowed_levels
     FROM loyalty_gift_claims lgc
     INNER JOIN loyalty_gifts lg ON lg.id = lgc.gift_id
     WHERE lgc.user_id = ?
     ORDER BY lgc.id DESC`,
    [userId],
  );

  return {
    claims: rows.map((row) => ({
      id: row.id,
      gift_id: row.gift_id,
      gift_title: row.gift_title,
      delivery_address: row.delivery_address,
      contact_phone: row.contact_phone || '',
      status: row.status,
      rejection_reason: row.rejection_reason || '',
      date: formatYmdHis(row.created_at),
      processed_at: row.processed_at ? formatYmdHis(row.processed_at) : '',
    })),
  };
}
