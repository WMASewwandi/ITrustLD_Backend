import { getDbDriver, query } from '../config/database.js';

const SETTING_KEY_ENABLED = 'maintenance_mode_enabled';
const SETTING_KEY_MESSAGE = 'maintenance_mode_message';

export const DEFAULT_MAINTENANCE_MESSAGE =
  'We are currently performing scheduled maintenance. Please check back shortly.';

let tableReady = false;

function validationError(message, status = 422) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function ensurePlatformSettingsTable() {
  if (tableReady) return;

  const driver = getDbDriver();
  if (driver === 'sqlite') {
    await query(`
      CREATE TABLE IF NOT EXISTS platform_settings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        setting_key TEXT NOT NULL UNIQUE,
        setting_value TEXT,
        updated_by INTEGER,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);
  } else {
    await query(`
      CREATE TABLE IF NOT EXISTS platform_settings (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        setting_key VARCHAR(100) NOT NULL,
        setting_value TEXT NULL,
        updated_by BIGINT UNSIGNED NULL,
        created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY platform_settings_setting_key_unique (setting_key)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }

  tableReady = true;
}

async function readSetting(key) {
  const rows = await query(
    `SELECT setting_value, updated_by, updated_at
     FROM platform_settings
     WHERE setting_key = ?
     LIMIT 1`,
    [key],
  );
  return rows[0] ?? null;
}

async function writeSetting(key, value, userId = null) {
  await ensurePlatformSettingsTable();
  const existing = await readSetting(key);

  if (existing) {
    await query(
      `UPDATE platform_settings
       SET setting_value = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP
       WHERE setting_key = ?`,
      [value, userId, key],
    );
  } else {
    await query(
      `INSERT INTO platform_settings (setting_key, setting_value, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [key, value, userId],
    );
  }
}

function parseEnabled(value) {
  if (value === true || value === 1 || value === '1') return true;
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
}

function normalizeMessage(value) {
  const message = String(value ?? '').trim();
  return message || DEFAULT_MAINTENANCE_MESSAGE;
}

export async function getMaintenanceMode() {
  await ensurePlatformSettingsTable();

  const enabledRow = await readSetting(SETTING_KEY_ENABLED);
  const messageRow = await readSetting(SETTING_KEY_MESSAGE);

  return {
    enabled: parseEnabled(enabledRow?.setting_value),
    message: normalizeMessage(messageRow?.setting_value),
    updatedAt: enabledRow?.updated_at || messageRow?.updated_at || null,
    updatedBy: enabledRow?.updated_by ?? messageRow?.updated_by ?? null,
  };
}

let maintenanceCache = null;
let maintenanceCacheAt = 0;
const MAINTENANCE_CACHE_MS = 2_000;

export function clearMaintenanceModeCache() {
  maintenanceCache = null;
  maintenanceCacheAt = 0;
}

export async function getMaintenanceModeCached(maxAgeMs = MAINTENANCE_CACHE_MS) {
  const now = Date.now();
  if (maintenanceCache && now - maintenanceCacheAt < maxAgeMs) {
    return maintenanceCache;
  }

  maintenanceCache = await getMaintenanceMode();
  maintenanceCacheAt = now;
  return maintenanceCache;
}

export async function updateMaintenanceMode(userId, payload = {}) {
  const hasEnabled = Object.prototype.hasOwnProperty.call(payload, 'enabled');
  const hasMessage = Object.prototype.hasOwnProperty.call(payload, 'message');

  if (!hasEnabled && !hasMessage) {
    throw validationError('Nothing to update.');
  }

  if (hasEnabled) {
    const enabled = parseEnabled(payload.enabled);
    await writeSetting(SETTING_KEY_ENABLED, enabled ? 'true' : 'false', userId);
  }

  if (hasMessage) {
    const message = normalizeMessage(payload.message);
    if (message.length > 500) {
      throw validationError('Maintenance message must be 500 characters or fewer.');
    }
    await writeSetting(SETTING_KEY_MESSAGE, message, userId);
  }

  clearMaintenanceModeCache();
  return getMaintenanceMode();
}
