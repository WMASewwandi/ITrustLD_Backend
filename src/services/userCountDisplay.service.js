import { getDbDriver, query } from '../config/database.js';

const SETTING_KEY = 'user_count_base';
const DEFAULT_BASE_COUNT = 82000;

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

async function readBaseCountRow() {
  const rows = await query(
    `SELECT setting_value
     FROM platform_settings
     WHERE setting_key = ?
     LIMIT 1`,
    [SETTING_KEY],
  );
  return rows[0] ?? null;
}

async function getBaseCount() {
  await ensurePlatformSettingsTable();
  const row = await readBaseCountRow();
  if (!row) {
    return DEFAULT_BASE_COUNT;
  }

  const parsed = Number.parseInt(String(row.setting_value ?? ''), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_BASE_COUNT;
}

export async function countLiveMembers() {
  const rows = await query(
    `SELECT COUNT(*) AS total
     FROM account_holders
     WHERE COALESCE(account_status, 'ACTIVE') != 'BANNED'`,
  );
  return Number(rows[0]?.total) || 0;
}

export async function getUserCountDisplay() {
  const baseCount = await getBaseCount();
  const liveCount = await countLiveMembers();

  return {
    baseCount,
    liveCount,
    displayedCount: baseCount + liveCount,
  };
}

export async function updateUserCountBase(userId, rawBaseCount) {
  const baseCount = Number.parseInt(String(rawBaseCount ?? ''), 10);
  if (!Number.isFinite(baseCount) || baseCount < 0) {
    throw validationError('Base count must be a non-negative whole number.');
  }

  await ensurePlatformSettingsTable();
  const existing = await readBaseCountRow();

  if (existing) {
    await query(
      `UPDATE platform_settings
       SET setting_value = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP
       WHERE setting_key = ?`,
      [String(baseCount), userId, SETTING_KEY],
    );
  } else {
    await query(
      `INSERT INTO platform_settings (setting_key, setting_value, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [SETTING_KEY, String(baseCount), userId],
    );
  }

  return getUserCountDisplay();
}
