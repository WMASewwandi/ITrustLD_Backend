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
    benefits: [
      '$200 Welcome Bonus',
      'Earn $400 cashback for every 10 clients referred, with each client receiving a $25 voucher for iTrustLD.',
      'Priority support and exclusive promotions',
    ],
  },
  {
    slug: 'vvip',
    name: 'VVIP',
    points: 1000000,
    icon: 'badge',
    color: '#0D9F1B',
    ring: '#0D9F1B',
    filled: true,
    benefits: [
      '$500 Welcome Bonus',
      'Earn $600 cashback for every 10 clients referred, with each client receiving a $35 voucher for iTrustLD.',
      'Dedicated account manager and VIP event invites',
    ],
  },
];

function validationError(message, status = 422) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function toBool(value) {
  return value === true || value === 1 || value === '1' || String(value).toLowerCase() === 'true';
}

function parseBenefits(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || '').trim()).filter(Boolean);
  }
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed.map((item) => String(item || '').trim()).filter(Boolean);
      }
    } catch {
      return value
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    }
  }
  return [];
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
    points: def.points,
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
      // Keep benefits in DB; sync mock name/points/styling onto the row.
      // If benefits still match the old auto-seeded mock copy, clear them —
      // user-facing benefits must come from admin saves only.
      const currentBenefits = parseBenefits(existing.benefits_json);
      const isLegacyDefault =
        currentBenefits.length === def.benefits.length &&
        currentBenefits.every((item, i) => item === def.benefits[i]);
      const benefitsJson = isLegacyDefault
        ? JSON.stringify([])
        : existing.benefits_json == null
          ? JSON.stringify([])
          : typeof existing.benefits_json === 'string'
            ? existing.benefits_json
            : JSON.stringify(parseBenefits(existing.benefits_json));

      await query(
        `UPDATE loyalty_membership_tiers
         SET level_id = ?, name = ?, points = ?, icon = ?, color = ?, ring = ?, filled = ?,
             benefits_json = ?, sort_order = ?, updated_at = CURRENT_TIMESTAMP
         WHERE slug = ?`,
        [
          index + 1,
          def.name,
          def.points,
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
        JSON.stringify([]),
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

export async function listActiveLoyaltyMembershipTiers() {
  const { tiers } = await listLoyaltyMembershipTiersAdmin();
  return tiers.filter((tier) => tier.active !== false && tier.isActive !== false);
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
    // Only persist benefits that were explicitly sent; never write mock defaults.
    const benefits = incoming ? parseBenefits(incoming.benefits) : [];
    const isActive = incoming
      ? toBool(incoming.active ?? incoming.isActive ?? true)
      : true;

    const rows = await query(`SELECT id FROM loyalty_membership_tiers WHERE slug = ? LIMIT 1`, [
      def.slug,
    ]);

    if (rows[0]) {
      await query(
        `UPDATE loyalty_membership_tiers
         SET level_id = ?, name = ?, points = ?, icon = ?, color = ?, ring = ?, filled = ?,
             benefits_json = ?, is_active = ?, sort_order = ?, updated_at = CURRENT_TIMESTAMP
         WHERE slug = ?`,
        [
          index + 1,
          def.name,
          def.points,
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
          def.points,
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

  return listLoyaltyMembershipTiersAdmin();
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
