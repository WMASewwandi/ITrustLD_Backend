import { getDbDriver, query } from '../config/database.js';
import { parseDbDateTime } from '../utils/slTime.js';
import {
  deleteCountdownBackgroundFile,
  resolveCountdownBackgroundPublicUrl,
  storeCountdownBackground,
  validateCountdownBackgroundUpload,
} from './countdownBackgroundStorage.service.js';

const SETTING_KEY_ENABLED = 'maintenance_mode_enabled';
const SETTING_KEY_MESSAGE = 'maintenance_mode_message';
const SETTING_KEY_COUNTDOWN_ENABLED = 'launch_countdown_enabled';
const SETTING_KEY_COUNTDOWN_RELEASES_AT = 'launch_countdown_releases_at';
const SETTING_KEY_COUNTDOWN_MESSAGE = 'launch_countdown_message';
const SETTING_KEY_COUNTDOWN_EYEBROW = 'launch_countdown_eyebrow';
const SETTING_KEY_COUNTDOWN_TITLE = 'launch_countdown_title';
const SETTING_KEY_COUNTDOWN_FOOTER = 'launch_countdown_footer';
const SETTING_KEY_COUNTDOWN_BACKGROUND = 'launch_countdown_background';

export const DEFAULT_MAINTENANCE_MESSAGE =
  'We are currently performing scheduled maintenance. Please check back shortly.';

export const DEFAULT_COUNTDOWN_MESSAGE =
  'The new iTrustLD experience is almost here. We go live at the time shown below.';

export const DEFAULT_COUNTDOWN_EYEBROW = 'New system launch';
export const DEFAULT_COUNTDOWN_TITLE = 'Going live soon';
export const DEFAULT_COUNTDOWN_FOOTER = 'Please check back when the countdown ends.';

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

function normalizeLimitedText(value, fallback, max, label) {
  const text = String(value ?? '').trim();
  if (text.length > max) {
    throw validationError(`${label} must be ${max} characters or fewer.`);
  }
  return text || fallback;
}

function normalizeReleasesAt(value) {
  if (value == null || String(value).trim() === '') return null;
  const parsed = parseDbDateTime(value);
  if (!parsed) {
    throw validationError('Enter a valid launch date and time.');
  }
  return parsed.toISOString();
}

function isCountdownActive(enabled, releasesAt, now = new Date()) {
  if (!enabled || !releasesAt) return false;
  const at = new Date(releasesAt);
  return !Number.isNaN(at.getTime()) && at.getTime() > now.getTime();
}

function mapCountdown(rows, now = new Date()) {
  const enabled = parseEnabled(rows.enabled?.setting_value);
  const releasesAt = String(rows.releasesAt?.setting_value || '').trim() || null;
  const backgroundFilename = String(rows.background?.setting_value || '').trim() || null;
  const backgroundUpdatedAt = rows.background?.updated_at || null;
  return {
    enabled,
    releasesAt,
    eyebrow: String(rows.eyebrow?.setting_value || '').trim() || DEFAULT_COUNTDOWN_EYEBROW,
    title: String(rows.title?.setting_value || '').trim() || DEFAULT_COUNTDOWN_TITLE,
    message: String(rows.message?.setting_value || '').trim() || DEFAULT_COUNTDOWN_MESSAGE,
    footer: String(rows.footer?.setting_value || '').trim() || DEFAULT_COUNTDOWN_FOOTER,
    backgroundFilename,
    backgroundUrl: resolveCountdownBackgroundPublicUrl(backgroundFilename, backgroundUpdatedAt),
    active: isCountdownActive(enabled, releasesAt, now),
  };
}

export async function getMaintenanceMode() {
  await ensurePlatformSettingsTable();

  const [
    enabledRow,
    messageRow,
    countdownEnabledRow,
    countdownReleasesRow,
    countdownMessageRow,
    countdownEyebrowRow,
    countdownTitleRow,
    countdownFooterRow,
    countdownBackgroundRow,
  ] = await Promise.all([
    readSetting(SETTING_KEY_ENABLED),
    readSetting(SETTING_KEY_MESSAGE),
    readSetting(SETTING_KEY_COUNTDOWN_ENABLED),
    readSetting(SETTING_KEY_COUNTDOWN_RELEASES_AT),
    readSetting(SETTING_KEY_COUNTDOWN_MESSAGE),
    readSetting(SETTING_KEY_COUNTDOWN_EYEBROW),
    readSetting(SETTING_KEY_COUNTDOWN_TITLE),
    readSetting(SETTING_KEY_COUNTDOWN_FOOTER),
    readSetting(SETTING_KEY_COUNTDOWN_BACKGROUND),
  ]);

  const now = new Date();
  const countdown = mapCountdown(
    {
      enabled: countdownEnabledRow,
      releasesAt: countdownReleasesRow,
      message: countdownMessageRow,
      eyebrow: countdownEyebrowRow,
      title: countdownTitleRow,
      footer: countdownFooterRow,
      background: countdownBackgroundRow,
    },
    now,
  );

  return {
    enabled: parseEnabled(enabledRow?.setting_value),
    message: normalizeMessage(messageRow?.setting_value),
    updatedAt:
      enabledRow?.updated_at ||
      messageRow?.updated_at ||
      countdownEnabledRow?.updated_at ||
      countdownReleasesRow?.updated_at ||
      countdownMessageRow?.updated_at ||
      countdownEyebrowRow?.updated_at ||
      countdownTitleRow?.updated_at ||
      countdownFooterRow?.updated_at ||
      countdownBackgroundRow?.updated_at ||
      null,
    updatedBy:
      enabledRow?.updated_by ??
      messageRow?.updated_by ??
      countdownEnabledRow?.updated_by ??
      countdownReleasesRow?.updated_by ??
      countdownMessageRow?.updated_by ??
      countdownEyebrowRow?.updated_by ??
      countdownTitleRow?.updated_by ??
      countdownFooterRow?.updated_by ??
      countdownBackgroundRow?.updated_by ??
      null,
    serverNow: now.toISOString(),
    countdown,
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

export async function updateMaintenanceMode(userId, payload = {}, file = null) {
  const hasEnabled = Object.prototype.hasOwnProperty.call(payload, 'enabled');
  const hasMessage = Object.prototype.hasOwnProperty.call(payload, 'message');
  const hasCountdownEnabled = Object.prototype.hasOwnProperty.call(payload, 'countdownEnabled');
  const hasCountdownReleasesAt = Object.prototype.hasOwnProperty.call(
    payload,
    'countdownReleasesAt',
  );
  const hasCountdownMessage = Object.prototype.hasOwnProperty.call(payload, 'countdownMessage');
  const hasCountdownEyebrow = Object.prototype.hasOwnProperty.call(payload, 'countdownEyebrow');
  const hasCountdownTitle = Object.prototype.hasOwnProperty.call(payload, 'countdownTitle');
  const hasCountdownFooter = Object.prototype.hasOwnProperty.call(payload, 'countdownFooter');
  const removeBackground = parseEnabled(payload.removeBackground);

  if (
    !hasEnabled &&
    !hasMessage &&
    !hasCountdownEnabled &&
    !hasCountdownReleasesAt &&
    !hasCountdownMessage &&
    !hasCountdownEyebrow &&
    !hasCountdownTitle &&
    !hasCountdownFooter &&
    !file &&
    !removeBackground
  ) {
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

  if (hasCountdownEyebrow) {
    await writeSetting(
      SETTING_KEY_COUNTDOWN_EYEBROW,
      normalizeLimitedText(payload.countdownEyebrow, DEFAULT_COUNTDOWN_EYEBROW, 80, 'Eyebrow'),
      userId,
    );
  }

  if (hasCountdownTitle) {
    await writeSetting(
      SETTING_KEY_COUNTDOWN_TITLE,
      normalizeLimitedText(payload.countdownTitle, DEFAULT_COUNTDOWN_TITLE, 120, 'Title'),
      userId,
    );
  }

  if (hasCountdownMessage) {
    await writeSetting(
      SETTING_KEY_COUNTDOWN_MESSAGE,
      normalizeLimitedText(payload.countdownMessage, DEFAULT_COUNTDOWN_MESSAGE, 500, 'Countdown message'),
      userId,
    );
  }

  if (hasCountdownFooter) {
    await writeSetting(
      SETTING_KEY_COUNTDOWN_FOOTER,
      normalizeLimitedText(payload.countdownFooter, DEFAULT_COUNTDOWN_FOOTER, 200, 'Footer'),
      userId,
    );
  }

  let nextReleasesAt = null;
  if (hasCountdownReleasesAt) {
    nextReleasesAt = normalizeReleasesAt(payload.countdownReleasesAt);
    await writeSetting(SETTING_KEY_COUNTDOWN_RELEASES_AT, nextReleasesAt, userId);
  }

  if (hasCountdownEnabled) {
    const countdownEnabled = parseEnabled(payload.countdownEnabled);
    if (countdownEnabled) {
      const releasesAt =
        nextReleasesAt ||
        String((await readSetting(SETTING_KEY_COUNTDOWN_RELEASES_AT))?.setting_value || '').trim() ||
        null;
      if (!releasesAt) {
        throw validationError('Set a launch date and time before turning the countdown on.');
      }
      if (new Date(releasesAt).getTime() <= Date.now()) {
        throw validationError('Launch time must be in the future.');
      }
    }
    await writeSetting(SETTING_KEY_COUNTDOWN_ENABLED, countdownEnabled ? 'true' : 'false', userId);
  }

  if (file) {
    const fileError = validateCountdownBackgroundUpload(file);
    if (fileError) {
      throw validationError(fileError);
    }
    const previous = String((await readSetting(SETTING_KEY_COUNTDOWN_BACKGROUND))?.setting_value || '').trim();
    const filename = await storeCountdownBackground(file);
    await writeSetting(SETTING_KEY_COUNTDOWN_BACKGROUND, filename, userId);
    if (previous && previous !== filename) {
      await deleteCountdownBackgroundFile(previous);
    }
  } else if (removeBackground) {
    const previous = String((await readSetting(SETTING_KEY_COUNTDOWN_BACKGROUND))?.setting_value || '').trim();
    await writeSetting(SETTING_KEY_COUNTDOWN_BACKGROUND, '', userId);
    if (previous) {
      await deleteCountdownBackgroundFile(previous);
    }
  }

  clearMaintenanceModeCache();
  return getMaintenanceMode();
}
