import { getDbDriver, query } from '../config/database.js';
import { addColomboDays, formatTimestampSl, parseDbDateTime } from '../utils/slTime.js';
import {
  DEFAULT_MEMBERSHIP_TIERS,
  getTierByPointsFromList,
  getMembershipTierThresholds,
} from './loyaltyMembershipTier.service.js';
import { scheduleBonusNotify, scheduleVoucherLevelNotify } from './loyaltyNotify.service.js';

const VALID_IDENTIFIERS = [
  'POINT-COLLECTION',
  'POINT-COLLECTION-AFFILIATE',
  'BONUS',
  'BONUS-AFFILIATE',
  'SILVER-BONUS',
  'GOLD-BONUS',
  'DIAMOND-BONUS',
  'VIP-BONUS',
  'VVIP-BONUS',
];

const VALID_LOYALTY_LEVELS = ['SILVER', 'GOLD', 'DIAMOND', 'VIP', 'VVIP'];
/** Level client-bonus configs expire this many days after creation. */
export const LEVEL_BONUS_VALIDITY_DAYS = 30;
export const POINT_COLLECTION_TIERS = ['NORMAL', 'SILVER', 'GOLD', 'DIAMOND', 'VIP', 'VVIP'];
const POINT_COLLECTION_TIER_LABELS = {
  NORMAL: 'Normal',
  SILVER: 'Silver',
  GOLD: 'Gold',
  DIAMOND: 'Diamond',
  VIP: 'VIP',
  VVIP: 'VVIP',
};

let pointCollectionTierSchemaReady = false;
let bonusTierSchemaReady = false;

function validationError(message, status = 422) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function normalizeAudience(audience) {
  const value = String(audience || 'standard').trim().toLowerCase();
  if (value === 'partner' || value === 'affiliate') return 'partner';
  return 'standard';
}

function formatYmdHis(value) {
  const formatted = formatTimestampSl(value);
  if (!formatted) return '—';
  return formatted;
}

function normalizePointCollectionTier(value) {
  const raw = String(value || '').trim().toUpperCase();
  if (!raw || raw === 'ALL') return '';
  return POINT_COLLECTION_TIERS.includes(raw) ? raw : '';
}

function requirePointCollectionTier(value) {
  const tier = normalizePointCollectionTier(value);
  if (!tier) {
    throw validationError('Select a membership tier.');
  }
  return tier;
}

async function tableHasColumn(tableName, columnName) {
  if (getDbDriver() === 'sqlite') {
    const rows = await query(`PRAGMA table_info(${tableName})`);
    return rows.some((row) => String(row.name).toLowerCase() === String(columnName).toLowerCase());
  }
  const rows = await query(
    `SELECT COLUMN_NAME AS name
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
       AND COLUMN_NAME = ?
     LIMIT 1`,
    [tableName, columnName],
  );
  return Boolean(rows[0]);
}

export async function ensureBonusTierSchema() {
  if (bonusTierSchemaReady) return;

  const exists = await tableHasColumn('loyalty_management_bonuses', 'membership_tier');
  if (!exists) {
    if (getDbDriver() === 'sqlite') {
      await query(`ALTER TABLE loyalty_management_bonuses ADD COLUMN membership_tier TEXT NULL`);
    } else {
      await query(
        `ALTER TABLE loyalty_management_bonuses
         ADD COLUMN membership_tier VARCHAR(32) NULL AFTER is_affiliate`,
      );
    }
  }

  bonusTierSchemaReady = true;
}

export async function ensurePointCollectionTierSchema() {
  if (pointCollectionTierSchemaReady) return;

  const exists = await tableHasColumn('loyalty_management_point_collections', 'membership_tier');
  if (!exists) {
    if (getDbDriver() === 'sqlite') {
      await query(
        `ALTER TABLE loyalty_management_point_collections ADD COLUMN membership_tier TEXT NULL`,
      );
    } else {
      await query(
        `ALTER TABLE loyalty_management_point_collections
         ADD COLUMN membership_tier VARCHAR(32) NULL AFTER is_affiliate`,
      );
    }
  }

  if (getDbDriver() !== 'sqlite') {
    const typeRows = await query(
      `SELECT DATA_TYPE FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'loyalty_management_point_collections'
         AND COLUMN_NAME = 'cal_amount'
       LIMIT 1`,
    );
    const dataType = String(typeRows[0]?.DATA_TYPE || '').toLowerCase();
    if (dataType && dataType !== 'decimal' && dataType !== 'numeric') {
      await query(
        `ALTER TABLE loyalty_management_point_collections
         MODIFY cal_amount DECIMAL(12,4) NOT NULL`,
      );
    }
  }

  pointCollectionTierSchemaReady = true;
}

function takeLatestPerGroup(rows, keyFn, limitPerGroup = 5) {
  const counts = {};
  const out = [];
  for (const row of rows) {
    const key = keyFn(row);
    counts[key] = (counts[key] || 0) + 1;
    if (counts[key] <= limitPerGroup) out.push(row);
  }
  return out;
}

function mapPointCollectionRow(row) {
  const membershipTier = normalizePointCollectionTier(row.membership_tier);
  return {
    id: row.id,
    display_id: row.display_id,
    admin_id: row.admin_user_id,
    cal_amount: Number(row.cal_amount),
    membership_tier: membershipTier || null,
    membership_tier_label: membershipTier
      ? POINT_COLLECTION_TIER_LABELS[membershipTier]
      : 'All Tiers',
    is_active: Boolean(row.is_active),
    changed_date: formatYmdHis(row.updated_at),
  };
}

function mapBonusRow(row) {
  const membershipTier = normalizePointCollectionTier(row.membership_tier);
  return {
    id: row.id,
    display_id: row.display_id,
    admin_id: row.admin_user_id,
    bonus_amount: Number(row.bonus_amount),
    membership_tier: membershipTier || null,
    membership_tier_label: membershipTier
      ? POINT_COLLECTION_TIER_LABELS[membershipTier]
      : 'All Tiers',
    is_active: Boolean(row.is_active),
    changed_date: formatYmdHis(row.updated_at),
  };
}

function mapLevelRow(row) {
  const createdAtRaw = row.created_at || row.updated_at;
  const createdAt = parseDbDateTime(createdAtRaw);
  const expiresAt = createdAt ? addColomboDays(createdAt, LEVEL_BONUS_VALIDITY_DAYS) : null;
  const isExpired = Boolean(expiresAt && expiresAt.getTime() <= Date.now());

  return {
    id: row.id,
    display_id: row.display_id,
    admin_id: row.admin_user_id,
    client_bonus_amount: Number(row.client_bonus_amount),
    client_count: Number(row.client_count),
    loyalty_level: row.loyalty_level,
    is_active: Boolean(row.is_active),
    changed_date: formatYmdHis(row.updated_at),
    created_at: createdAt ? createdAt.toISOString() : null,
    expires_at: expiresAt ? expiresAt.toISOString() : null,
    expires_at_label: expiresAt ? formatYmdHis(expiresAt) : null,
    is_expired: isExpired,
    validity_days: LEVEL_BONUS_VALIDITY_DAYS,
  };
}

/** Sum client_bonus_amount per level from non-expired, non-deleted rows. */
export async function getNonExpiredClientBonusTotalsByLevel() {
  const rows = await query(
    `SELECT id, client_bonus_amount, loyalty_level, is_deleted, created_at, updated_at
     FROM loyalty_management_levels
     WHERE loyalty_level IN ('SILVER', 'GOLD', 'DIAMOND', 'VIP', 'VVIP')
       AND (is_deleted = 0 OR is_deleted IS NULL OR is_deleted = FALSE)`,
  );

  const totals = {
    silver: 0,
    gold: 0,
    diamond: 0,
    vip: 0,
    vvip: 0,
  };

  for (const row of rows) {
    if (mapLevelRow(row).is_expired) continue;
    const key = String(row.loyalty_level || '').trim().toLowerCase();
    if (key in totals) {
      totals[key] += Number(row.client_bonus_amount) || 0;
    }
  }

  return totals;
}

async function assertLevelBonusMutable(loyaltyLevelId, { allowExpired = false } = {}) {
  const rows = await query(
    `SELECT id, created_at, updated_at
     FROM loyalty_management_levels
     WHERE id = ?
     LIMIT 1`,
    [loyaltyLevelId],
  );
  const row = rows[0];
  if (!row) {
    throw validationError('Invalid loyalty management level reference.');
  }
  if (!allowExpired && mapLevelRow(row).is_expired) {
    throw validationError('This level bonus has expired and can no longer be changed.');
  }
  return row;
}

function mapConfigRow(row) {
  return {
    identifier: row.identifier,
    is_active: Boolean(row.is_active),
    date_activated: row.date_activated,
    date_deactivated: row.date_deactivated,
  };
}

async function fetchMasterConfigs() {
  const rows = await query(
    `SELECT identifier, is_active, date_activated, date_deactivated
     FROM loyalty_management_configs`,
  );
  const map = {};
  for (const row of rows) {
    map[row.identifier] = mapConfigRow(row);
  }
  return map;
}

function mapMembershipTierSummary(tier) {
  return {
    slug: tier.slug,
    name: tier.name,
    points: Number(tier.points) || 0,
    color: tier.color || '#64969A',
    ring: tier.ring || tier.color || '#64969A',
  };
}

function getTierPointRange(tiers, slug) {
  const normalized = String(slug || '').trim().toLowerCase();
  if (!normalized || normalized === 'all') return null;
  const sorted = [...tiers].sort((a, b) => (Number(a.points) || 0) - (Number(b.points) || 0));
  const index = sorted.findIndex((tier) => String(tier.slug || '').toLowerCase() === normalized);
  if (index < 0) return null;
  const min = Number(sorted[index].points) || 0;
  const next = sorted[index + 1];
  return {
    slug: sorted[index].slug,
    min,
    maxExclusive: next ? Number(next.points) || 0 : null,
  };
}

function mapEarnerTier(totalPoints) {
  const tier = getTierByPointsFromList(totalPoints, DEFAULT_MEMBERSHIP_TIERS);
  if (!tier) return null;
  return mapMembershipTierSummary(tier);
}

async function fetchTopPointEarners(isPartner, tierSlug) {
  const thresholds = await getMembershipTierThresholds();
  const membershipTiers = thresholds.map((tier) => ({
    slug: tier.slug,
    name: tier.name,
    points: tier.points,
  }));
  const partnerFlag = isPartner ? 'YES' : 'NO';
  const range = getTierPointRange(membershipTiers, tierSlug);
  const params = [partnerFlag];
  const havingParts = [];

  if (range) {
    havingParts.push('SUM(pe.point_earning_amount) >= ?');
    params.push(range.min);
    if (range.maxExclusive != null) {
      havingParts.push('SUM(pe.point_earning_amount) < ?');
      params.push(range.maxExclusive);
    }
  }

  const havingSql = havingParts.length ? `HAVING ${havingParts.join(' AND ')}` : '';
  const rows = await query(
    `SELECT
       ah.id AS account_holder_id,
       ah.account_number,
       ah.first_name,
       ah.last_name,
       ah.email,
       ah.mobile_number,
       ranked.total_points
     FROM (
       SELECT pe.user_id, SUM(pe.point_earning_amount) AS total_points
       FROM point_earnings pe
       INNER JOIN account_holders ah2 ON pe.user_id = ah2.user_id
       WHERE ah2.is_patner = ?
         AND pe.created_at > DATE_SUB(NOW(), INTERVAL 365 DAY)
       GROUP BY pe.user_id
       ${havingSql}
       ORDER BY total_points DESC
       LIMIT 50
     ) ranked
     INNER JOIN account_holders ah ON ah.user_id = ranked.user_id
     ORDER BY ranked.total_points DESC`,
    params,
  );

  return rows.map((row) => {
    const totalPoints = Number(row.total_points) || 0;
    const tier = getTierByPointsFromList(totalPoints, membershipTiers);
    return {
      account_holder_id: row.account_holder_id,
      user_id: row.account_number,
      name: [row.first_name, row.last_name].filter(Boolean).join(' ').trim() || '—',
      email: row.email || '—',
      mobile_number: row.mobile_number || '—',
      total_points: totalPoints,
      total_points_display: totalPoints.toLocaleString('en-US'),
      tier: tier ? mapMembershipTierSummary(tier) : null,
    };
  });
}

export async function getLoyaltyManagementData(audience, tier) {
  const normalizedAudience = normalizeAudience(audience);
  const isAffiliate = normalizedAudience === 'partner';
  const thresholds = await getMembershipTierThresholds();
  const membershipTiers = thresholds.map((item) =>
    mapMembershipTierSummary({
      slug: item.slug,
      name: item.name,
      points: item.points,
    }),
  );
  const appliedTier = getTierPointRange(membershipTiers, tier);
  await Promise.all([ensurePointCollectionTierSchema(), ensureBonusTierSchema()]);

  const [masterConfigs, pointRowsRaw, bonusRowsRaw] = await Promise.all([
    fetchMasterConfigs(),
    query(
      `SELECT id, display_id, cal_amount, is_affiliate, membership_tier, is_active, is_deleted, admin_user_id, updated_at
       FROM loyalty_management_point_collections
       WHERE is_affiliate = ?
         AND (is_deleted = 0 OR is_deleted IS NULL OR is_deleted = FALSE)
       ORDER BY CASE UPPER(COALESCE(membership_tier, ''))
         WHEN 'NORMAL' THEN 1
         WHEN 'SILVER' THEN 2
         WHEN 'GOLD' THEN 3
         WHEN 'DIAMOND' THEN 4
         WHEN 'VIP' THEN 5
         WHEN 'VVIP' THEN 6
         ELSE 99
       END, display_id DESC`,
      [isAffiliate ? 1 : 0],
    ),
    query(
      `SELECT id, display_id, bonus_amount, is_affiliate, membership_tier, is_active, is_deleted, admin_user_id, updated_at
       FROM loyalty_management_bonuses
       WHERE is_affiliate = ?
         AND (is_deleted = 0 OR is_deleted IS NULL OR is_deleted = FALSE)
       ORDER BY CASE UPPER(COALESCE(membership_tier, ''))
         WHEN 'NORMAL' THEN 1
         WHEN 'SILVER' THEN 2
         WHEN 'GOLD' THEN 3
         WHEN 'DIAMOND' THEN 4
         WHEN 'VIP' THEN 5
         WHEN 'VVIP' THEN 6
         ELSE 99
       END, display_id DESC`,
      [isAffiliate ? 1 : 0],
    ),
  ]);

  const pointRows = takeLatestPerGroup(
    pointRowsRaw,
    (row) => String(row.membership_tier || '').toUpperCase() || 'UNSET',
    5,
  );
  const bonusRows = takeLatestPerGroup(
    bonusRowsRaw,
    (row) => String(row.membership_tier || '').toUpperCase() || 'UNSET',
    5,
  );

  let loyaltyLevels = null;
  if (isAffiliate) {
    const levelRows = await query(
      `SELECT id, display_id, client_bonus_amount, client_count, is_active, loyalty_level, is_deleted, admin_user_id, created_at, updated_at
       FROM loyalty_management_levels
       WHERE loyalty_level IN ('SILVER', 'GOLD', 'DIAMOND', 'VIP', 'VVIP')
         AND (is_deleted = 0 OR is_deleted IS NULL OR is_deleted = FALSE)
       ORDER BY FIELD(loyalty_level, 'SILVER', 'GOLD', 'DIAMOND', 'VIP', 'VVIP'), display_id DESC`,
    );

    loyaltyLevels = {
      SILVER: [],
      GOLD: [],
      DIAMOND: [],
      VIP: [],
      VVIP: [],
    };

    for (const row of levelRows) {
      const key = String(row.loyalty_level || '').trim().toUpperCase();
      if (!loyaltyLevels[key]) continue;
      if (loyaltyLevels[key].length >= 5) continue;
      loyaltyLevels[key].push(mapLevelRow({ ...row, loyalty_level: key }));
    }
  }

  const topEarners = await fetchTopPointEarners(isAffiliate, appliedTier?.slug);

  return {
    audience: normalizedAudience,
    membership_tiers: membershipTiers,
    tier: appliedTier?.slug || 'all',
    configs: {
      point_collection: masterConfigs[isAffiliate ? 'POINT-COLLECTION-AFFILIATE' : 'POINT-COLLECTION'] || null,
      bonus: masterConfigs[isAffiliate ? 'BONUS-AFFILIATE' : 'BONUS'] || null,
      silver_bonus: masterConfigs['SILVER-BONUS'] || null,
      gold_bonus: masterConfigs['GOLD-BONUS'] || null,
      diamond_bonus: masterConfigs['DIAMOND-BONUS'] || null,
      vip_bonus: masterConfigs['VIP-BONUS'] || null,
      vvip_bonus: masterConfigs['VVIP-BONUS'] || null,
    },
    point_collections: pointRows.map(mapPointCollectionRow),
    bonuses: bonusRows.map(mapBonusRow),
    loyalty_levels: loyaltyLevels,
    top_earners: topEarners,
    ranking_criteria: {
      evaluation_period_days: 365,
      evaluation_period_label: 'Previous 12 months of Trust Points',
      user_types: ['Normal', 'Affiliate'],
    },
  };
}

export async function updateMasterConfigActivationState({ identifier, activationState }) {
  const configIdentifier = String(identifier || '').trim();
  if (!VALID_IDENTIFIERS.includes(configIdentifier)) {
    throw validationError('Invalid loyalty management config identifier.');
  }

  const active = Boolean(activationState);
  const rows = await query(
    `SELECT id FROM loyalty_management_configs WHERE identifier = ? LIMIT 1`,
    [configIdentifier],
  );
  if (!rows[0]) {
    throw validationError('Invalid loyalty management config identifier.');
  }

  if (active) {
    await query(
      `UPDATE loyalty_management_configs
       SET is_active = 1, date_activated = NOW(), updated_at = NOW()
       WHERE identifier = ?`,
      [configIdentifier],
    );
  } else {
    await query(
      `UPDATE loyalty_management_configs
       SET is_active = 0, date_deactivated = NOW(), updated_at = NOW()
       WHERE identifier = ?`,
      [configIdentifier],
    );
  }

  return {
    ok: true,
    error: false,
    message: active
      ? `Loyalty management config ${configIdentifier} activated successfully.`
      : `Loyalty management config ${configIdentifier} de-activated successfully.`,
  };
}

async function assertUniqueAudienceTier({
  table,
  isAffiliate,
  membershipTier,
  excludeId = null,
  entityName = 'amount',
}) {
  const params = [isAffiliate ? 1 : 0, membershipTier];
  let sql = `
    SELECT id
    FROM ${table}
    WHERE is_affiliate = ?
      AND UPPER(membership_tier) = ?
      AND (is_deleted = 0 OR is_deleted IS NULL OR is_deleted = FALSE)
  `;
  if (excludeId) {
    sql += ' AND id != ?';
    params.push(excludeId);
  }
  sql += ' LIMIT 1';

  const rows = await query(sql, params);
  if (rows[0]) {
    const label = POINT_COLLECTION_TIER_LABELS[membershipTier] || membershipTier;
    throw validationError(`A ${entityName} already exists for the ${label} tier.`);
  }
}

async function getNextDisplayId(table, extraWhere = '', params = []) {
  const rows = await query(
    `SELECT display_id
     FROM ${table}
     ${extraWhere}
     ORDER BY display_id DESC
     LIMIT 1`,
    params,
  );
  return rows[0] ? Number(rows[0].display_id) + 1 : 1;
}

function requireCalAmount(calAmount) {
  const amount = Number(calAmount);
  if (!Number.isFinite(amount) || amount < 0) {
    throw validationError('Cal amount must be a valid number.');
  }
  return amount;
}

export async function createPointCollection(adminUserId, { calAmount, isAffiliate, membershipTier }) {
  await ensurePointCollectionTierSchema();
  const amount = requireCalAmount(calAmount);
  const tier = requirePointCollectionTier(membershipTier);

  const affiliate = Boolean(isAffiliate);
  await assertUniqueAudienceTier({
    table: 'loyalty_management_point_collections',
    isAffiliate: affiliate,
    membershipTier: tier,
    entityName: 'cal amount',
  });
  const displayId = await getNextDisplayId(
    'loyalty_management_point_collections',
    'WHERE is_affiliate = ?',
    [affiliate ? 1 : 0],
  );

  const result = await query(
    `INSERT INTO loyalty_management_point_collections
       (display_id, cal_amount, is_affiliate, membership_tier, is_active, is_deleted, admin_user_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, 0, ?, NOW(), NOW())`,
    [displayId, amount, affiliate ? 1 : 0, tier, adminUserId],
  );

  const rows = await query(
    `SELECT id, display_id, cal_amount, is_affiliate, membership_tier, is_active, is_deleted, admin_user_id, updated_at
     FROM loyalty_management_point_collections
     WHERE id = ?
     LIMIT 1`,
    [result.insertId],
  );

  return {
    ok: true,
    error: false,
    point_collection: mapPointCollectionRow(rows[0]),
  };
}

export async function updatePointCollectionAmount({ pointCollectionId, calAmount, membershipTier }) {
  await ensurePointCollectionTierSchema();
  const id = Number(pointCollectionId);
  const amount = requireCalAmount(calAmount);
  if (!Number.isInteger(id) || id <= 0) {
    throw validationError('Invalid loyalty management point collection id.');
  }
  const tier = requirePointCollectionTier(membershipTier);

  const rows = await query(
    `SELECT id, is_affiliate FROM loyalty_management_point_collections WHERE id = ? LIMIT 1`,
    [id],
  );
  if (!rows[0]) {
    throw validationError('Invalid loyalty management point collection id.');
  }

  await assertUniqueAudienceTier({
    table: 'loyalty_management_point_collections',
    isAffiliate: Boolean(rows[0].is_affiliate),
    membershipTier: tier,
    excludeId: id,
    entityName: 'cal amount',
  });

  await query(
    `UPDATE loyalty_management_point_collections
     SET cal_amount = ?, membership_tier = ?, updated_at = NOW()
     WHERE id = ?`,
    [amount, tier, id],
  );

  return {
    ok: true,
    error: false,
    message: 'Loyalty management point collection cal amount is updated successfully.',
  };
}

export async function updatePointCollectionActivationState({ pointCollectionId, activationState }) {
  const id = Number(pointCollectionId);
  if (!Number.isInteger(id) || id <= 0) {
    throw validationError('Invalid loyalty management point collection id.');
  }

  const rows = await query(
    `SELECT id FROM loyalty_management_point_collections WHERE id = ? LIMIT 1`,
    [id],
  );
  if (!rows[0]) {
    throw validationError('Invalid loyalty management point collection id.');
  }

  const active = Boolean(activationState);
  await query(
    `UPDATE loyalty_management_point_collections
     SET is_active = ?, updated_at = NOW()
     WHERE id = ?`,
    [active ? 1 : 0, id],
  );

  return {
    ok: true,
    error: false,
    message: active
      ? 'Loyalty management point collection activated successfully.'
      : 'Loyalty management point collection de-activated successfully.',
  };
}

export async function deletePointCollection({ pointCollectionId }) {
  const id = Number(pointCollectionId);
  if (!Number.isInteger(id) || id <= 0) {
    throw validationError('Invalid loyalty management point collection id.');
  }

  const rows = await query(
    `SELECT id FROM loyalty_management_point_collections WHERE id = ? LIMIT 1`,
    [id],
  );
  if (!rows[0]) {
    throw validationError('Invalid loyalty management point collection id.');
  }

  await query(
    `UPDATE loyalty_management_point_collections
     SET is_deleted = 1, updated_at = NOW()
     WHERE id = ?`,
    [id],
  );

  return {
    ok: true,
    error: false,
    message: 'Loyalty management point collection deleted successfully.',
  };
}

export async function createBonus(adminUserId, { bonusAmount, isAffiliate, membershipTier, notifyUsersByEmail }) {
  await ensureBonusTierSchema();
  const amount = Number(bonusAmount);
  if (!Number.isInteger(amount) || amount < 0) {
    throw validationError('Bonus amount must be a valid integer.');
  }
  const tier = requirePointCollectionTier(membershipTier);

  const affiliate = Boolean(isAffiliate);
  await assertUniqueAudienceTier({
    table: 'loyalty_management_bonuses',
    isAffiliate: affiliate,
    membershipTier: tier,
    entityName: 'bonus amount',
  });
  const displayId = await getNextDisplayId(
    'loyalty_management_bonuses',
    'WHERE is_affiliate = ?',
    [affiliate ? 1 : 0],
  );

  const result = await query(
    `INSERT INTO loyalty_management_bonuses
       (display_id, bonus_amount, is_affiliate, membership_tier, is_active, is_deleted, admin_user_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, 0, ?, NOW(), NOW())`,
    [displayId, amount, affiliate ? 1 : 0, tier, adminUserId],
  );

  const rows = await query(
    `SELECT id, display_id, bonus_amount, is_affiliate, membership_tier, is_active, is_deleted, admin_user_id, updated_at
     FROM loyalty_management_bonuses
     WHERE id = ?
     LIMIT 1`,
    [result.insertId],
  );

  scheduleBonusNotify({
    notifyUsersByEmail,
    bonusAmount: amount,
    isAffiliate: affiliate,
    membershipTier: tier,
    isUpdate: false,
  });

  return {
    ok: true,
    error: false,
    bonus: mapBonusRow(rows[0]),
  };
}

export async function updateBonusAmount({ bonusId, bonusAmount, membershipTier, notifyUsersByEmail }) {
  await ensureBonusTierSchema();
  const id = Number(bonusId);
  const amount = Number(bonusAmount);
  if (!Number.isInteger(id) || id <= 0) {
    throw validationError('Invalid loyalty management bonus id.');
  }
  if (!Number.isInteger(amount) || amount < 0) {
    throw validationError('Bonus amount must be a valid integer.');
  }
  const tier = requirePointCollectionTier(membershipTier);

  const rows = await query(
    `SELECT id, is_affiliate FROM loyalty_management_bonuses WHERE id = ? LIMIT 1`,
    [id],
  );
  if (!rows[0]) {
    throw validationError('Invalid loyalty management bonus id.');
  }

  const affiliate = Boolean(rows[0].is_affiliate);

  await assertUniqueAudienceTier({
    table: 'loyalty_management_bonuses',
    isAffiliate: affiliate,
    membershipTier: tier,
    excludeId: id,
    entityName: 'bonus amount',
  });

  await query(
    `UPDATE loyalty_management_bonuses
     SET bonus_amount = ?, membership_tier = ?, updated_at = NOW()
     WHERE id = ?`,
    [amount, tier, id],
  );

  scheduleBonusNotify({
    notifyUsersByEmail,
    bonusAmount: amount,
    isAffiliate: affiliate,
    membershipTier: tier,
    isUpdate: true,
  });

  return {
    ok: true,
    error: false,
    message: 'Loyalty management bonus amount is updated successfully.',
  };
}

export async function updateBonusActivationState({ bonusId, activationState }) {
  const id = Number(bonusId);
  if (!Number.isInteger(id) || id <= 0) {
    throw validationError('Invalid loyalty management bonus id.');
  }

  const rows = await query(
    `SELECT id FROM loyalty_management_bonuses WHERE id = ? LIMIT 1`,
    [id],
  );
  if (!rows[0]) {
    throw validationError('Invalid loyalty management bonus id.');
  }

  const active = Boolean(activationState);
  await query(
    `UPDATE loyalty_management_bonuses
     SET is_active = ?, updated_at = NOW()
     WHERE id = ?`,
    [active ? 1 : 0, id],
  );

  return {
    ok: true,
    error: false,
    message: active
      ? 'Loyalty management bonus activated successfully.'
      : 'Loyalty management bonus de-activated successfully.',
  };
}

export async function deleteBonus({ bonusId }) {
  const id = Number(bonusId);
  if (!Number.isInteger(id) || id <= 0) {
    throw validationError('Invalid loyalty management bonus id.');
  }

  const rows = await query(
    `SELECT id FROM loyalty_management_bonuses WHERE id = ? LIMIT 1`,
    [id],
  );
  if (!rows[0]) {
    throw validationError('Invalid loyalty management bonus id.');
  }

  await query(
    `UPDATE loyalty_management_bonuses
     SET is_deleted = 1, updated_at = NOW()
     WHERE id = ?`,
    [id],
  );

  return {
    ok: true,
    error: false,
    message: 'Loyalty management bonus deleted successfully.',
  };
}

export async function createLoyaltyLevel(adminUserId, { clientBonusAmount, clientCount, loyaltyLevel, notifyUsersByEmail }) {
  const bonusAmount = Number(clientBonusAmount);
  const count = Number(clientCount);
  const level = String(loyaltyLevel || '').trim().toUpperCase();

  if (!Number.isInteger(bonusAmount) || bonusAmount < 0) {
    throw validationError('Client bonus amount must be a valid integer.');
  }
  if (!Number.isInteger(count) || count < 0) {
    throw validationError('Client count must be a valid integer.');
  }
  if (!VALID_LOYALTY_LEVELS.includes(level)) {
    throw validationError('Invalid loyalty level.');
  }

  const displayId = await getNextDisplayId(
    'loyalty_management_levels',
    'WHERE loyalty_level = ?',
    [level],
  );

  const result = await query(
    `INSERT INTO loyalty_management_levels
       (display_id, client_bonus_amount, client_count, is_active, loyalty_level, is_deleted, admin_user_id, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, 0, ?, NOW(), NOW())`,
    [displayId, bonusAmount, count, level, adminUserId],
  );

  const rows = await query(
    `SELECT id, display_id, client_bonus_amount, client_count, is_active, loyalty_level, is_deleted, admin_user_id, created_at, updated_at
     FROM loyalty_management_levels
     WHERE id = ?
     LIMIT 1`,
    [result.insertId],
  );

  scheduleVoucherLevelNotify({
    notifyUsersByEmail,
    loyaltyLevel: level,
    clientBonusAmount: bonusAmount,
    clientCount: count,
    isUpdate: false,
  });

  return {
    ok: true,
    error: false,
    loyalty_level: mapLevelRow(rows[0]),
  };
}

export async function updateLoyaltyLevel({ loyaltyLevelId, clientBonusAmount, clientCount, notifyUsersByEmail }) {
  const id = Number(loyaltyLevelId);
  const bonusAmount = Number(clientBonusAmount);
  const count = Number(clientCount);

  if (!Number.isInteger(id) || id <= 0) {
    throw validationError('Invalid loyalty management level reference.');
  }
  if (!Number.isInteger(bonusAmount) || bonusAmount < 0) {
    throw validationError('Client bonus amount must be a valid integer.');
  }
  if (!Number.isInteger(count) || count < 0) {
    throw validationError('Client count must be a valid integer.');
  }

  await assertLevelBonusMutable(id);

  const existing = await query(
    `SELECT id, loyalty_level FROM loyalty_management_levels WHERE id = ? LIMIT 1`,
    [id],
  );
  if (!existing[0]) {
    throw validationError('Invalid loyalty management level reference.');
  }

  await query(
    `UPDATE loyalty_management_levels
     SET client_bonus_amount = ?, client_count = ?, updated_at = NOW()
     WHERE id = ?`,
    [bonusAmount, count, id],
  );

  scheduleVoucherLevelNotify({
    notifyUsersByEmail,
    loyaltyLevel: existing[0].loyalty_level,
    clientBonusAmount: bonusAmount,
    clientCount: count,
    isUpdate: true,
  });

  return {
    ok: true,
    error: false,
    message: 'Loyalty management level is updated successfully.',
  };
}

export async function updateLoyaltyLevelActivationState({ loyaltyLevelId, activationState }) {
  const id = Number(loyaltyLevelId);
  if (!Number.isInteger(id) || id <= 0) {
    throw validationError('Invalid loyalty management level reference.');
  }

  await assertLevelBonusMutable(id);

  const active = Boolean(activationState);
  await query(
    `UPDATE loyalty_management_levels
     SET is_active = ?, updated_at = NOW()
     WHERE id = ?`,
    [active ? 1 : 0, id],
  );

  return {
    ok: true,
    error: false,
    message: active
      ? 'Loyalty management level activated successfully.'
      : 'Loyalty management level de-activated successfully.',
  };
}

export async function deleteLoyaltyLevel({ loyaltyLevelId }) {
  const id = Number(loyaltyLevelId);
  if (!Number.isInteger(id) || id <= 0) {
    throw validationError('Invalid loyalty management level id.');
  }

  const row = await assertLevelBonusMutable(id, { allowExpired: true });
  if (!mapLevelRow(row).is_expired) {
    throw validationError('Only expired level bonuses can be deleted.');
  }

  await query(
    `UPDATE loyalty_management_levels
     SET is_deleted = 1, updated_at = NOW()
     WHERE id = ?`,
    [id],
  );

  return {
    ok: true,
    error: false,
    message: 'Loyalty management level deleted successfully.',
  };
}
