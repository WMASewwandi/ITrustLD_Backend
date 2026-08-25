import { getDbDriver, query } from '../config/database.js';

let schemaReady = false;

/**
 * Canonical membership ladder (Normal → VVIP).
 * Tier id/name/points/styling come from this mock; benefits (and active) are stored in DB.
 * Points match the user-facing MEMBERSHIP_TIERS ladder.
 */
export const DEFAULT_MEMBERSHIP_TIERS = [
  {
    slug: 'normal',
    name: 'Normal',
    points: 0,
    icon: 'star',
    color: '#64969A',
    ring: '#64969A',
    filled: false,
    benefits: [
      'Access to Trust Points program',
      'Earn points from eligible top-ups and referrals',
    ],
  },
  {
    slug: 'silver',
    name: 'Silver',
    points: 10000,
    icon: 'star',
    color: '#8A9399',
    ring: '#C0C0C0',
    filled: false,
    benefits: [
      '$20 Welcome Bonus',
      'Earn $50 cashback for every 10 clients referred',
    ],
  },
  {
    slug: 'gold',
    name: 'Gold',
    points: 50000,
    icon: 'star',
    color: '#B8860B',
    ring: '#D4AF37',
    filled: false,
    benefits: [
      '$50 Welcome Bonus',
      'Earn $150 cashback for every 10 clients referred, with each client receiving a $15 voucher for iTrustLD.',
    ],
  },
  {
    slug: 'diamond',
    name: 'Diamond',
    points: 100000,
    icon: 'gem',
    color: '#3D8FA8',
    ring: '#7EC8E3',
    filled: false,
    benefits: [
      '$100 Welcome Bonus',
      'Earn $250 cashback for every 10 clients referred, with each client receiving a $20 voucher for iTrustLD.',
    ],
  },
  {
    slug: 'vip',
    name: 'VIP',
    points: 500000,
    icon: 'badge',
    color: '#C48A12',
    ring: '#F4B42E',
    filled: false,
    benefits: ['Fully sponsored international tour package (for one person)'],
  },
  {
    slug: 'vvip',
    name: 'VVIP',
    points: 1000000,
    icon: 'badge',
    color: '#0D9F1B',
    ring: '#0D9F1B',
    filled: true,
    benefits: ['Fully sponsored international family tour package'],
  },
];

function validationError(message, status = 422) {
  const error = new Error(message);
  error.status = status;
  return error;
}

const TOUR_PACKAGE_BENEFITS = {
  vip: ['Fully sponsored international tour package (for one person)'],
  vvip: ['Fully sponsored international family tour package'],
};

const LEGACY_TIER_BENEFITS = {
  vip: [
    '$200 Welcome Bonus',
    'Earn $400 cashback for every 10 clients referred, with each client receiving a $25 voucher for iTrustLD.',
    'Priority support and exclusive promotions',
  ],
  vvip: [
    '$500 Welcome Bonus',
    'Earn $600 cashback for every 10 clients referred, with each client receiving a $35 voucher for iTrustLD.',
    'Dedicated account manager and VIP event invites',
  ],
};

let thresholdCache = { at: 0, tiers: null };

export function invalidateMembershipTierCache() {
  thresholdCache = { at: 0, tiers: null };
}

function toBool(value) {
  return value === true || value === 1 || value === '1' || String(value).toLowerCase() === 'true';
}

function normalizeBenefitAudience(value) {
  const key = String(value || '').trim().toLowerCase();
  if (key === 'partner' || key === 'affiliate') return 'affiliate';
  if (key === 'normal' || key === 'user') return 'normal';
  if (key === 'both' || key === 'all') return 'both';
  return 'both';
}

function normalizeBenefit(item) {
  if (typeof item === 'string') {
    const text = item.trim();
    return text ? { text, audience: 'both' } : null;
  }
  if (item && typeof item === 'object') {
    const text = String(item.text || item.benefit || item.label || '').trim();
    if (!text) return null;
    return {
      text,
      audience: normalizeBenefitAudience(item.audience || item.type || item.userType),
    };
  }
  return null;
}

function benefitTexts(benefits = []) {
  return benefits.map((item) => (typeof item === 'string' ? item : item?.text || '')).filter(Boolean);
}

function benefitsMatch(current = [], expected = []) {
  const a = benefitTexts(parseBenefits(current));
  const b = benefitTexts(parseBenefits(expected));
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

function parseBenefits(value) {
  let list = [];
  if (Array.isArray(value)) {
    list = value;
  } else if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      list = Array.isArray(parsed) ? parsed : value.split('\n');
    } catch {
      list = value.split('\n');
    }
  }
  return list.map(normalizeBenefit).filter(Boolean);
}

function filterBenefitsForAudience(benefits, audience) {
  if (!audience) return benefits;
  const target = normalizeBenefitAudience(audience);
  return (benefits || []).filter((item) => item.audience === 'both' || item.audience === target);
}

async function tableExists() {
  if (getDbDriver() === 'sqlite') {
    const rows = await query(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'loyalty_membership_tiers'`,
    );
    return rows.length > 0;
  }
  const rows = await query(`SHOW TABLES LIKE 'loyalty_membership_tiers'`);
  return rows.length > 0;
}

export async function ensureLoyaltyMembershipTiersSchema() {
  if (schemaReady) return;

  const exists = await tableExists();
  if (!exists) {
    if (getDbDriver() === 'sqlite') {
      await query(`
        CREATE TABLE IF NOT EXISTS loyalty_membership_tiers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          slug TEXT NOT NULL UNIQUE,
          level_id INTEGER NOT NULL DEFAULT 1,
          name TEXT NOT NULL,
          points INTEGER NOT NULL DEFAULT 0,
          icon TEXT NOT NULL DEFAULT 'star',
          color TEXT NOT NULL DEFAULT '#64969A',
          ring TEXT NOT NULL DEFAULT '#64969A',
          filled INTEGER NOT NULL DEFAULT 0,
          benefits_json TEXT,
          is_active INTEGER NOT NULL DEFAULT 1,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at TEXT,
          updated_at TEXT
        )
      `);
    } else {
      await query(`
        CREATE TABLE loyalty_membership_tiers (
          id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
          slug VARCHAR(64) NOT NULL UNIQUE,
          level_id INT UNSIGNED NOT NULL DEFAULT 1,
          name VARCHAR(120) NOT NULL,
          points INT UNSIGNED NOT NULL DEFAULT 0,
          icon VARCHAR(32) NOT NULL DEFAULT 'star',
          color VARCHAR(20) NOT NULL DEFAULT '#64969A',
          ring VARCHAR(20) NOT NULL DEFAULT '#64969A',
          filled TINYINT(1) NOT NULL DEFAULT 0,
          benefits_json TEXT NULL,
          is_active TINYINT(1) NOT NULL DEFAULT 1,
          sort_order INT UNSIGNED NOT NULL DEFAULT 0,
          created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )
      `);
    }
  }

  schemaReady = true;
}

async function loadDbRowsBySlug() {
  const rows = await query(`SELECT * FROM loyalty_membership_tiers`);
  const bySlug = new Map();
  for (const row of rows) {
    bySlug.set(String(row.slug || '').toLowerCase(), row);
  }
  return bySlug;
}

function mapMergedTier(def, index, dbRow) {
  // Benefits only from DB — never fall back to mock copy on user/admin read.
  const benefits = dbRow ? parseBenefits(dbRow.benefits_json) : [];
  const isActive = dbRow ? toBool(dbRow.is_active) : true;

  return {
    id: def.slug,
    slug: def.slug,
    levelId: index + 1,
    name: def.name,
    points: dbRow?.points != null ? Number(dbRow.points) || 0 : def.points,
    icon: def.icon,
    color: def.color,
    ring: def.ring,
    filled: Boolean(def.filled),
    active: isActive,
    isActive,
    benefits,
    sortOrder: index + 1,
    createdAt: dbRow?.created_at ?? null,
    updatedAt: dbRow?.updated_at ?? null,
  };
}

/** Ensure each mock tier has a DB row so benefits persist; keep existing benefits. */
async function ensureMockTierSeeded() {
  const bySlug = await loadDbRowsBySlug();

  for (let index = 0; index < DEFAULT_MEMBERSHIP_TIERS.length; index += 1) {
    const def = DEFAULT_MEMBERSHIP_TIERS[index];
    const existing = bySlug.get(def.slug);
    if (existing) {
      const currentBenefits = parseBenefits(existing.benefits_json);
      const tourBenefits = TOUR_PACKAGE_BENEFITS[def.slug];
      const legacyBenefits = LEGACY_TIER_BENEFITS[def.slug];
      let benefitsJson =
        existing.benefits_json == null
          ? JSON.stringify([])
          : typeof existing.benefits_json === 'string'
            ? existing.benefits_json
            : JSON.stringify(currentBenefits);

      if (tourBenefits && (!currentBenefits.length || benefitsMatch(currentBenefits, legacyBenefits || []))) {
        benefitsJson = JSON.stringify(tourBenefits);
      }

      await query(
        `UPDATE loyalty_membership_tiers
         SET level_id = ?, name = ?, icon = ?, color = ?, ring = ?, filled = ?,
             benefits_json = ?, sort_order = ?, updated_at = CURRENT_TIMESTAMP
         WHERE slug = ?`,
        [
          index + 1,
          def.name,
          def.icon,
          def.color,
          def.ring,
          def.filled ? 1 : 0,
          benefitsJson,
          index + 1,
          def.slug,
        ],
      );
      continue;
    }

    const seedBenefits = TOUR_PACKAGE_BENEFITS[def.slug] || [];
    await query(
      `INSERT INTO loyalty_membership_tiers
        (slug, level_id, name, points, icon, color, ring, filled, benefits_json, is_active, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        def.slug,
        index + 1,
        def.name,
        def.points,
        def.icon,
        def.color,
        def.ring,
        def.filled ? 1 : 0,
        JSON.stringify(seedBenefits),
        index + 1,
      ],
    );
  }

  // Remove non-mock ladder rows so admin always shows the fixed tiers.
  const allowed = DEFAULT_MEMBERSHIP_TIERS.map((t) => t.slug);
  const placeholders = allowed.map(() => '?').join(', ');
  await query(
    `DELETE FROM loyalty_membership_tiers WHERE slug NOT IN (${placeholders})`,
    allowed,
  );
}

export async function listLoyaltyMembershipTiersAdmin() {
  await ensureLoyaltyMembershipTiersSchema();
  await ensureMockTierSeeded();
  const bySlug = await loadDbRowsBySlug();
  const tiers = DEFAULT_MEMBERSHIP_TIERS.map((def, index) =>
    mapMergedTier(def, index, bySlug.get(def.slug)),
  );
  return { ok: true, tiers };
}

export async function listActiveLoyaltyMembershipTiers(audience = 'normal') {
  const { tiers } = await listLoyaltyMembershipTiersAdmin();
  const active = tiers.filter((tier) => tier.active !== false && tier.isActive !== false);
  return active.map((tier) => ({
    ...tier,
    benefits: benefitTexts(filterBenefitsForAudience(tier.benefits, audience || 'normal')),
  }));
}

export async function saveLoyaltyMembershipTiers(tiersPayload = []) {
  await ensureLoyaltyMembershipTiersSchema();
  await ensureMockTierSeeded();

  if (!Array.isArray(tiersPayload) || tiersPayload.length === 0) {
    throw validationError('At least one loyalty tier is required.');
  }

  const byIncoming = new Map();
  for (const tier of tiersPayload) {
    const slug = String(tier.id ?? tier.slug ?? '')
      .trim()
      .toLowerCase();
    if (slug) byIncoming.set(slug, tier);
  }

  for (let index = 0; index < DEFAULT_MEMBERSHIP_TIERS.length; index += 1) {
    const def = DEFAULT_MEMBERSHIP_TIERS[index];
    const incoming = byIncoming.get(def.slug);
    const existingRows = await query(
      `SELECT id, points FROM loyalty_membership_tiers WHERE slug = ? LIMIT 1`,
      [def.slug],
    );
    const existing = existingRows[0];
    const benefits = incoming ? parseBenefits(incoming.benefits) : [];
    const isActive = incoming
      ? toBool(incoming.active ?? incoming.isActive ?? true)
      : true;
    const incomingPoints = incoming?.points ?? incoming?.levelPoints;
    const points =
      incomingPoints != null && incomingPoints !== ''
        ? Math.max(0, Number(incomingPoints) || 0)
        : existing?.points != null
          ? Number(existing.points) || def.points
          : def.points;

    if (existing) {
      await query(
        `UPDATE loyalty_membership_tiers
         SET level_id = ?, name = ?, points = ?, icon = ?, color = ?, ring = ?, filled = ?,
             benefits_json = ?, is_active = ?, sort_order = ?, updated_at = CURRENT_TIMESTAMP
         WHERE slug = ?`,
        [
          index + 1,
          def.name,
          points,
          def.icon,
          def.color,
          def.ring,
          def.filled ? 1 : 0,
          JSON.stringify(benefits),
          isActive ? 1 : 0,
          index + 1,
          def.slug,
        ],
      );
    } else {
      await query(
        `INSERT INTO loyalty_membership_tiers
          (slug, level_id, name, points, icon, color, ring, filled, benefits_json, is_active, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [
          def.slug,
          index + 1,
          def.name,
          points,
          def.icon,
          def.color,
          def.ring,
          def.filled ? 1 : 0,
          JSON.stringify(benefits),
          isActive ? 1 : 0,
          index + 1,
        ],
      );
    }
  }

  invalidateMembershipTierCache();
  return listLoyaltyMembershipTiersAdmin();
}

export function getLevelIdFromThresholds(pointCount, thresholds = []) {
  const points = Number(pointCount) || 0;
  const list = (thresholds || []).length
    ? [...thresholds].sort((a, b) => (Number(a.points) || 0) - (Number(b.points) || 0))
    : DEFAULT_MEMBERSHIP_TIERS.map((tier, index) => ({
        slug: tier.slug,
        name: tier.name,
        levelId: index + 1,
        points: tier.points,
      }));

  let current = list[0];
  for (const tier of list) {
    if (points >= (Number(tier.points) || 0)) current = tier;
  }
  return Number(current?.levelId) || 1;
}

export async function getMembershipTierThresholds() {
  if (thresholdCache.tiers && Date.now() - thresholdCache.at < 15000) {
    return thresholdCache.tiers;
  }

  try {
    const { tiers } = await listLoyaltyMembershipTiersAdmin();
    const mapped = tiers.map((tier, index) => ({
      slug: tier.slug,
      name: tier.name,
      levelId: index + 1,
      points: Number(tier.points) || 0,
    }));
    thresholdCache = { at: Date.now(), tiers: mapped };
    return mapped;
  } catch {
    return DEFAULT_MEMBERSHIP_TIERS.map((tier, index) => ({
      slug: tier.slug,
      name: tier.name,
      levelId: index + 1,
      points: tier.points,
    }));
  }
}

export async function resolveLevelId(pointCount) {
  const thresholds = await getMembershipTierThresholds();
  return getLevelIdFromThresholds(pointCount, thresholds);
}

export function getTierByPointsFromList(points, tiers = []) {
  const pts = Number(points) || 0;
  const activeTiers = tiers.filter((tier) => tier.active !== false && tier.isActive !== false);
  const list = activeTiers.length ? activeTiers : tiers;
  let current = list[0];
  for (const tier of list) {
    if (pts >= tier.points) current = tier;
  }
  return current || null;
}
