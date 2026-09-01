import { getDbDriver, query } from '../config/database.js';
import { formatDateSl, formatYmdColombo, parseDbDateTime } from '../utils/slTime.js';
import {
  DEFAULT_ICON_LOGO_URL,
  DEFAULT_WIDE_LOGO_URL,
  deleteWebsiteLogoFile,
  resolveWebsiteLogoPublicUrl,
  storeWebsiteLogo,
  validateWebsiteLogoUpload,
} from './websiteLogoStorage.service.js';

let schemaReady = false;

function validationError(message, status = 422) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function formatDateInput(value) {
  if (!value) return null;
  if (value instanceof Date) return formatYmdColombo(value);
  const raw = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  const date = parseDbDateTime(raw);
  if (!date) return null;
  return formatYmdColombo(date);
}

function formatDisplayDate(value) {
  if (!value) return '';
  const parts = String(value).slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(parts)) {
    return formatDateSl(`${parts} 00:00:00`);
  }
  return formatDateSl(value) || parts;
}

function todayDateString() {
  return formatYmdColombo(new Date());
}

function rangesOverlap(fromA, toA, fromB, toB) {
  return fromA <= toB && fromB <= toA;
}

function yesterdayDateString() {
  return formatYmdColombo(new Date(Date.now() - 24 * 60 * 60 * 1000));
}

async function endCurrentlyActiveSchedules(excludeId = null) {
  const today = todayDateString();
  const yesterday = yesterdayDateString();
  const rows = await query(
    `SELECT id, active_from, active_to
     FROM website_logos
     WHERE is_default = 0
       AND logo_filename IS NOT NULL
       AND active_from <= ?
       AND active_to >= ?`,
    [today, today],
  );

  for (const row of rows) {
    if (excludeId && Number(row.id) === Number(excludeId)) continue;
    await query(
      `UPDATE website_logos
       SET active_to = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [yesterday, row.id],
    );
  }
}

async function assertScheduleDoesNotOverlap(activeFrom, activeTo) {
  const rows = await query(
    `SELECT id, campaign_name, active_from, active_to
     FROM website_logos
     WHERE is_default = 0`,
  );

  for (const row of rows) {
    const existingFrom = formatDateInput(row.active_from);
    const existingTo = formatDateInput(row.active_to);
    if (!existingFrom || !existingTo) continue;
    if (rangesOverlap(activeFrom, activeTo, existingFrom, existingTo)) {
      throw validationError(
        `Only one logo can be active at a time. "${row.campaign_name}" already covers overlapping dates.`,
      );
    }
  }
}
function resolveStatus(activeFrom, activeTo, isDefault = false) {
  if (isDefault) {
    return 'default';
  }
  const today = todayDateString();
  if (activeFrom && today < activeFrom) return 'scheduled';
  if (activeTo && today > activeTo) return 'expired';
  return 'active';
}

async function tableExists() {
  if (getDbDriver() === 'sqlite') {
    const rows = await query(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'website_logos'`,
    );
    return rows.length > 0;
  }
  const rows = await query(`SHOW TABLES LIKE 'website_logos'`);
  return rows.length > 0;
}

async function seedDefaultLogo() {
  const rows = await query(`SELECT COUNT(*) AS total FROM website_logos`);
  if (Number(rows[0]?.total) > 0) return;

  await query(
    `INSERT INTO website_logos (
      campaign_name, logo_filename, is_default, active_from, active_to, created_at, updated_at
    ) VALUES (?, NULL, 1, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    ['Default Brand', '2025-01-01', '2099-12-31'],
  );
}

export async function ensureWebsiteLogosSchema() {
  if (schemaReady) return;

  const exists = await tableExists();
  if (!exists) {
    if (getDbDriver() === 'sqlite') {
      await query(`
        CREATE TABLE IF NOT EXISTS website_logos (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          campaign_name TEXT NOT NULL,
          logo_filename TEXT,
          is_default INTEGER NOT NULL DEFAULT 0,
          active_from TEXT,
          active_to TEXT,
          created_at TEXT,
          updated_at TEXT
        )
      `);
    } else {
      await query(`
        CREATE TABLE website_logos (
          id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
          campaign_name VARCHAR(255) NOT NULL,
          logo_filename VARCHAR(255) NULL,
          is_default TINYINT(1) NOT NULL DEFAULT 0,
          active_from DATE NULL,
          active_to DATE NULL,
          created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
    }
  }

  await seedDefaultLogo();
  schemaReady = true;
}

function mapLogoRow(row) {
  const isDefault = row.is_default === 1 || row.is_default === true;
  const status = resolveStatus(row.active_from, row.active_to, isDefault);
  const logoUrl = row.logo_filename
    ? resolveWebsiteLogoPublicUrl(row.logo_filename, row.updated_at)
    : null;

  return {
    id: row.id,
    campaign: row.campaign_name,
    fileName: row.logo_filename || 'default-brand-logo.svg',
    activeFrom: formatDateInput(row.active_from),
    activeTo: formatDateInput(row.active_to),
    activeFromDisplay: formatDisplayDate(row.active_from),
    activeToDisplay: formatDisplayDate(row.active_to),
    isDefault,
    status,
    logoUrl,
    updatedAt: row.updated_at,
  };
}

export async function listWebsiteLogosAdmin() {
  await ensureWebsiteLogosSchema();
  const rows = await query(
    `SELECT id, campaign_name, logo_filename, is_default, active_from, active_to, created_at, updated_at
     FROM website_logos
     ORDER BY is_default DESC, active_from DESC, id DESC`,
  );
  return {
    logos: rows.map(mapLogoRow),
    defaults: {
      wideLogoUrl: DEFAULT_WIDE_LOGO_URL,
      iconLogoUrl: DEFAULT_ICON_LOGO_URL,
    },
  };
}

export async function createWebsiteLogoSchedule(payload = {}, file = null) {
  await ensureWebsiteLogosSchema();

  const campaign = String(payload.campaign || payload.campaign_name || '').trim();
  const activeFrom = formatDateInput(payload.active_from || payload.activeFrom);
  const activeTo = formatDateInput(payload.active_to || payload.activeTo);

  if (!campaign) {
    throw validationError('Season / campaign name is required.');
  }
  if (!activeFrom || !activeTo) {
    throw validationError('Active from and active to dates are required.');
  }
  if (activeTo < activeFrom) {
    throw validationError('Active to date must be on or after active from date.');
  }

  const uploadError = validateWebsiteLogoUpload(file);
  if (uploadError) {
    throw validationError(uploadError);
  }

  const today = todayDateString();
  if (activeFrom <= today && activeTo >= today) {
    await endCurrentlyActiveSchedules();
  }

  await assertScheduleDoesNotOverlap(activeFrom, activeTo);

  const logoFilename = await storeWebsiteLogo(file);
  const result = await query(
    `INSERT INTO website_logos (
      campaign_name, logo_filename, is_default, active_from, active_to, created_at, updated_at
    ) VALUES (?, ?, 0, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [campaign, logoFilename, activeFrom, activeTo],
  );

  const id = result.insertId ?? result.lastInsertRowid;
  const rows = await query(`SELECT * FROM website_logos WHERE id = ? LIMIT 1`, [id]);
  return { ok: true, logo: mapLogoRow(rows[0]) };
}

export async function deleteWebsiteLogoSchedule(id) {
  await ensureWebsiteLogosSchema();
  const rows = await query(`SELECT * FROM website_logos WHERE id = ? LIMIT 1`, [id]);
  const row = rows[0];
  if (!row) {
    throw validationError('Logo schedule not found.', 404);
  }
  if (row.is_default === 1 || row.is_default === true) {
    throw validationError('The default brand logo cannot be removed.');
  }

  await deleteWebsiteLogoFile(row.logo_filename);
  await query(`DELETE FROM website_logos WHERE id = ?`, [id]);
  return { ok: true };
}

export async function getActiveWebsiteLogo() {
  await ensureWebsiteLogosSchema();
  const today = todayDateString();

  const scheduledRows = await query(
    `SELECT id, campaign_name, logo_filename, is_default, active_from, active_to, updated_at
     FROM website_logos
     WHERE is_default = 0
       AND logo_filename IS NOT NULL
       AND active_from <= ?
       AND active_to >= ?
     ORDER BY active_from DESC, id DESC
     LIMIT 1`,
    [today, today],
  );

  if (scheduledRows[0]?.logo_filename) {
    const row = scheduledRows[0];
    const wideLogoUrl = resolveWebsiteLogoPublicUrl(row.logo_filename, row.updated_at);
    return {
      wideLogoUrl,
      iconLogoUrl: DEFAULT_ICON_LOGO_URL,
      campaign: row.campaign_name,
      isDefault: false,
    };
  }

  return {
    wideLogoUrl: DEFAULT_WIDE_LOGO_URL,
    iconLogoUrl: DEFAULT_ICON_LOGO_URL,
    campaign: 'Default Brand',
    isDefault: true,
  };
}
