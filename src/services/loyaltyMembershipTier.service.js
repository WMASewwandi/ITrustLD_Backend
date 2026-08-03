import { getDbDriver, query } from '../config/database.js';

let schemaReady = false;

function validationError(message, status = 422) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function toBool(value) {
  return value === true || value === 1 || value === '1' || String(value).toLowerCase() === 'true';
}

function slugify(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
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

function mapTierRow(row) {
  return {
    id: row.slug,
    slug: row.slug,
    levelId: Number(row.level_id) || 1,
    name: row.name || '',
    points: Number(row.points) || 0,
    icon: row.icon || 'star',
    color: row.color || '#64969A',
    ring: row.ring || '#64969A',
    filled: toBool(row.filled),
    active: toBool(row.is_active),
    isActive: toBool(row.is_active),
    benefits: parseBenefits(row.benefits_json),
    sortOrder: Number(row.sort_order) || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listLoyaltyMembershipTiersAdmin() {
  await ensureLoyaltyMembershipTiersSchema();
  const rows = await query(
    `SELECT *
     FROM loyalty_membership_tiers
     ORDER BY sort_order ASC, level_id ASC, id ASC`,
  );
  return {
    ok: true,
    tiers: rows.map(mapTierRow),
  };
}

export async function listActiveLoyaltyMembershipTiers() {
  await ensureLoyaltyMembershipTiersSchema();
  const rows = await query(
    `SELECT *
     FROM loyalty_membership_tiers
     WHERE is_active = 1
     ORDER BY sort_order ASC, level_id ASC, id ASC`,
  );
  return rows.map(mapTierRow);
}

function normalizeIncomingTier(tier, index, existingBySlug) {
  const incomingId = String(tier.id ?? tier.slug ?? '').trim();
  const existing = incomingId ? existingBySlug.get(incomingId) : null;
  const name = String(tier.name || existing?.name || 'Untitled').trim();
  const slug = incomingId || slugify(name) || `tier-${Date.now()}-${index}`;
  const benefits = parseBenefits(tier.benefits);
  const points = Math.max(0, Number(tier.points) || 0);
  const isActive = tier.active !== undefined || tier.isActive !== undefined
    ? toBool(tier.active ?? tier.isActive)
    : true;

  return {
    slug,
    levelId: Number(existing?.levelId ?? tier.levelId ?? tier.level_id) || index + 1,
    name,
    points,
    icon: existing?.icon || tier.icon || 'star',
    color: existing?.color || tier.color || '#64969A',
    ring: existing?.ring || tier.ring || '#64969A',
    filled: existing?.filled ?? toBool(tier.filled),
    benefits,
    isActive,
    sortOrder: index + 1,
  };
}

export async function saveLoyaltyMembershipTiers(tiersPayload = []) {
  await ensureLoyaltyMembershipTiersSchema();

  if (!Array.isArray(tiersPayload) || tiersPayload.length === 0) {
    throw validationError('At least one loyalty tier is required.');
  }

  const existing = await listLoyaltyMembershipTiersAdmin();
  const existingBySlug = new Map(existing.tiers.map((tier) => [tier.slug, tier]));
  const normalized = tiersPayload.map((tier, index) =>
    normalizeIncomingTier(tier, index, existingBySlug),
  );

  const incomingSlugs = new Set(normalized.map((tier) => tier.slug));

  for (const tier of existing.tiers) {
    if (!incomingSlugs.has(tier.slug)) {
      await query(`DELETE FROM loyalty_membership_tiers WHERE slug = ?`, [tier.slug]);
    }
  }

  for (const tier of normalized) {
    const benefitsJson = JSON.stringify(tier.benefits);
    const rows = await query(`SELECT id FROM loyalty_membership_tiers WHERE slug = ? LIMIT 1`, [
      tier.slug,
    ]);

    if (rows[0]) {
      await query(
        `UPDATE loyalty_membership_tiers
         SET level_id = ?, name = ?, points = ?, icon = ?, color = ?, ring = ?, filled = ?,
             benefits_json = ?, is_active = ?, sort_order = ?, updated_at = CURRENT_TIMESTAMP
         WHERE slug = ?`,
        [
          tier.levelId,
          tier.name,
          tier.points,
          tier.icon,
          tier.color,
          tier.ring,
          tier.filled ? 1 : 0,
          benefitsJson,
          tier.isActive ? 1 : 0,
          tier.sortOrder,
          tier.slug,
        ],
      );
    } else {
      await query(
        `INSERT INTO loyalty_membership_tiers
          (slug, level_id, name, points, icon, color, ring, filled, benefits_json, is_active, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [
          tier.slug,
          tier.levelId,
          tier.name,
          tier.points,
          tier.icon,
          tier.color,
          tier.ring,
          tier.filled ? 1 : 0,
          benefitsJson,
          tier.isActive ? 1 : 0,
          tier.sortOrder,
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
