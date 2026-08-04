import { getDbDriver, query } from '../config/database.js';
import {
  deletePromotionalMediaFile,
  resolvePromotionalMediaPublicUrl,
  storePromotionalMedia,
  validatePromotionalMediaUpload,
} from './promotionalBannerStorage.service.js';

let schemaReady = false;

const DISPLAY_TYPE_MAP = {
  'static banner': 'static',
  static: 'static',
  slider: 'slider',
};

const DISPLAY_TYPE_LABELS = {
  static: 'Static Banner',
  slider: 'Slider',
};

const AUDIENCE_MAP = {
  'normal users': 'normal',
  normal: 'normal',
  'affiliate users': 'affiliate',
  affiliate: 'affiliate',
  both: 'both',
};

const AUDIENCE_LABELS = {
  normal: 'Normal Users',
  affiliate: 'Affiliate Users',
  both: 'Both',
};

function validationError(message, status = 422) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function normalizeDisplayType(value) {
  const key = String(value || 'static').trim().toLowerCase();
  if (!key || key === 'all') return null;
  return DISPLAY_TYPE_MAP[key] || 'static';
}

function normalizeAudience(value) {
  const key = String(value || 'normal').trim().toLowerCase();
  return AUDIENCE_MAP[key] || 'normal';
}

function formatDateInput(value) {
  if (value == null || value === '') return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const date = value instanceof Date ? value : new Date(raw);
  if (Number.isNaN(date.getTime())) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatDisplayDate(value) {
  if (!value) return '';
  const parts = String(value).slice(0, 10);
  const date = new Date(`${parts}T00:00:00`);
  if (Number.isNaN(date.getTime())) return parts;
  return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

async function tableExists() {
  if (getDbDriver() === 'sqlite') {
    const rows = await query(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'promotional_banners'`,
    );
    return rows.length > 0;
  }
  const rows = await query(`SHOW TABLES LIKE 'promotional_banners'`);
  return rows.length > 0;
}

export async function ensurePromotionalBannersSchema() {
  if (schemaReady) return;

  const exists = await tableExists();
  if (!exists) {
    if (getDbDriver() === 'sqlite') {
      await query(`
        CREATE TABLE IF NOT EXISTS promotional_banners (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL,
          description TEXT,
          color TEXT NOT NULL DEFAULT '#0D9F1B',
          cta_link TEXT,
          cta_label TEXT NOT NULL DEFAULT 'Learn More',
          display_type TEXT NOT NULL DEFAULT 'static',
          audience TEXT NOT NULL DEFAULT 'normal',
          active_from TEXT,
          active_to TEXT,
          media_filename TEXT,
          media_filenames TEXT,
          is_active INTEGER NOT NULL DEFAULT 1,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at TEXT,
          updated_at TEXT
        )
      `);
    } else {
      await query(`
        CREATE TABLE promotional_banners (
          id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
          title VARCHAR(255) NOT NULL,
          description TEXT NULL,
          color VARCHAR(20) NOT NULL DEFAULT '#0D9F1B',
          cta_link VARCHAR(500) NULL,
          cta_label VARCHAR(120) NOT NULL DEFAULT 'Learn More',
          display_type VARCHAR(32) NOT NULL DEFAULT 'static',
          audience VARCHAR(32) NOT NULL DEFAULT 'normal',
          active_from DATE NULL,
          active_to DATE NULL,
          media_filename VARCHAR(255) NULL,
          media_filenames TEXT NULL,
          is_active TINYINT(1) NOT NULL DEFAULT 1,
          sort_order INT UNSIGNED NOT NULL DEFAULT 0,
          created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )
      `);
    }
  }

  await ensureMediaFilenamesColumn();
  await sanitizePromotionalBannerDates();
  schemaReady = true;
}

async function ensureMediaFilenamesColumn() {
  if (getDbDriver() === 'sqlite') {
    const cols = await query(`PRAGMA table_info(promotional_banners)`);
    if (!cols.some((col) => col.name === 'media_filenames')) {
      await query(`ALTER TABLE promotional_banners ADD COLUMN media_filenames TEXT`);
    }
    return;
  }

  const cols = await query(`SHOW COLUMNS FROM promotional_banners LIKE 'media_filenames'`);
  if (!cols.length) {
    await query(
      `ALTER TABLE promotional_banners ADD COLUMN media_filenames TEXT NULL AFTER media_filename`,
    );
  }
}

function parseStoredMediaFilenames(row) {
  const raw = row.media_filenames;
  if (raw != null && raw !== '') {
    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (Array.isArray(parsed)) {
        return parsed.map((name) => String(name || '').trim()).filter(Boolean);
      }
    } catch {
      // fall through to single media_filename
    }
  }
  const single = String(row.media_filename || '').trim();
  return single ? [single] : [];
}

function serializeMediaFilenames(filenames = []) {
  const names = (Array.isArray(filenames) ? filenames : []).filter(Boolean);
  return names.length ? JSON.stringify(names) : null;
}

async function storeMediaFiles(mediaFiles = []) {
  const files = Array.isArray(mediaFiles) ? mediaFiles.filter(Boolean) : [];
  const filenames = [];
  for (const file of files) {
    const mediaError = validatePromotionalMediaUpload(file);
    if (mediaError) throw validationError(mediaError);
    filenames.push(await storePromotionalMedia(file));
  }
  return filenames;
}

async function deleteMediaFilenames(filenames = []) {
  for (const name of filenames) {
    if (name) await deletePromotionalMediaFile(name);
  }
}

async function mapPromotionalBannerRow(row) {
  const mediaNames = parseStoredMediaFilenames(row);
  const mediaUrls = await Promise.all(
    mediaNames.map((name) => resolvePromotionalMediaPublicUrl(name, row.updated_at)),
  );

  return {
    id: row.id,
    title: row.title || '',
    description: row.description || '',
    color: row.color || '#0D9F1B',
    ctaLink: row.cta_link || '',
    ctaLabel: row.cta_label || 'Learn More',
    displayType: DISPLAY_TYPE_LABELS[row.display_type] || 'Static Banner',
    displayTypeKey: row.display_type || 'static',
    audience: AUDIENCE_LABELS[row.audience] || 'Normal Users',
    audienceKey: row.audience || 'normal',
    activeFrom: formatDateInput(row.active_from),
    activeTo: formatDateInput(row.active_to),
    activeFromLabel: formatDisplayDate(row.active_from),
    activeToLabel: formatDisplayDate(row.active_to),
    mediaName: mediaNames[0] || '',
    mediaNames,
    mediaUrl: mediaUrls[0] || null,
    mediaUrls,
    mediaCount: mediaNames.length,
    isActive: row.is_active === 1 || row.is_active === true,
    sortOrder: Number(row.sort_order) || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** One banner row with N images → N slides for that banner's carousel. */
export function expandBannerToSlides(banner = {}) {
  const urls =
    Array.isArray(banner.mediaUrls) && banner.mediaUrls.length
      ? banner.mediaUrls
      : banner.mediaUrl
        ? [banner.mediaUrl]
        : [null];
  const names =
    Array.isArray(banner.mediaNames) && banner.mediaNames.length
      ? banner.mediaNames
      : banner.mediaName
        ? [banner.mediaName]
        : [];

  return urls.map((mediaUrl, index) => ({
    ...banner,
    id: `${banner.id}-${index}`,
    bannerId: banner.id,
    mediaUrl,
    mediaName: names[index] || names[0] || '',
    mediaUrls: [mediaUrl].filter(Boolean),
    mediaNames: names[index] ? [names[index]] : names.slice(0, 1),
  }));
}

/** Flatten all banners into one slide list (legacy). Prefer one slider per banner on the site. */
export function expandPromotionalSliderSlides(banners = []) {
  const slides = [];
  for (const banner of banners) {
    slides.push(...expandBannerToSlides(banner));
  }
  return slides;
}

function todaySqlExpression() {
  return getDbDriver() === 'sqlite' ? "date('now')" : 'CURDATE()';
}

/** Banners must have active_from + active_to and today must fall inside that range. */
function activeDateSqlConditions() {
  const today = todaySqlExpression();
  if (getDbDriver() === 'sqlite') {
    return [
      `active_from IS NOT NULL AND active_from != ''`,
      `active_to IS NOT NULL AND active_to != ''`,
      `date(active_from) <= date('now')`,
      `date(active_to) >= date('now')`,
    ];
  }
  return [
    'active_from IS NOT NULL',
    'active_to IS NOT NULL',
    `active_from <= ${today}`,
    `active_to >= ${today}`,
  ];
}

async function sanitizePromotionalBannerDates() {
  if (getDbDriver() === 'sqlite') return;
  try {
    await query(
      `UPDATE promotional_banners
       SET active_from = NULL
       WHERE active_from IS NOT NULL
         AND (CAST(active_from AS CHAR) = '' OR active_from < '1000-01-01')`,
    );
    await query(
      `UPDATE promotional_banners
       SET active_to = NULL
       WHERE active_to IS NOT NULL
         AND (CAST(active_to AS CHAR) = '' OR active_to < '1000-01-01')`,
    );
  } catch (error) {
    console.warn('[promotional-banners:sanitize-dates]', error.message);
  }
}

function buildActiveConditions(audienceKey, displayTypeKey) {
  const conditions = ['is_active = 1', ...activeDateSqlConditions()];
  const values = [];

  if (displayTypeKey) {
    conditions.push('display_type = ?');
    values.push(displayTypeKey);
  }

  if (audienceKey) {
    conditions.push(`(audience = 'both' OR audience = ?)`);
    values.push(audienceKey);
  }

  return { conditions, values };
}

function resolveAudiencesForUserType(userType = 'normal') {
  if (userType === 'partner') {
    return ['affiliate', 'both'];
  }
  return ['normal', 'both'];
}

function buildActiveConditionsForAudiences(audiences, displayTypeKey) {
  const conditions = ['is_active = 1', ...activeDateSqlConditions()];
  const values = [];

  if (displayTypeKey) {
    conditions.push('display_type = ?');
    values.push(displayTypeKey);
  }

  if (Array.isArray(audiences) && audiences.length) {
    conditions.push(`audience IN (${audiences.map(() => '?').join(', ')})`);
    values.push(...audiences);
  }

  return { conditions, values };
}

export async function listActivePromotionalBannersForUserType(
  userType = 'normal',
  { displayType = 'all' } = {},
) {
  await ensurePromotionalBannersSchema();

  const audiences = resolveAudiencesForUserType(userType);
  const displayTypeKey = normalizeDisplayType(displayType);
  const { conditions, values } = buildActiveConditionsForAudiences(audiences, displayTypeKey);

  const rows = await query(
    `SELECT * FROM promotional_banners
     WHERE ${conditions.join(' AND ')}
     ORDER BY sort_order ASC, created_at DESC, id DESC`,
    values,
  );

  return Promise.all(rows.map(mapPromotionalBannerRow));
}

export async function listPromotionalBannersAdmin() {
  await ensurePromotionalBannersSchema();
  const rows = await query(
    `SELECT * FROM promotional_banners ORDER BY sort_order ASC, created_at DESC, id DESC`,
    [],
  );
  return {
    ok: true,
    banners: await Promise.all(rows.map(mapPromotionalBannerRow)),
  };
}

export async function listActivePromotionalBanners({
  audience = 'normal',
  displayType = 'static',
} = {}) {
  await ensurePromotionalBannersSchema();

  const audienceKey = normalizeAudience(audience);
  const displayTypeKey = normalizeDisplayType(displayType);
  const { conditions, values } = buildActiveConditions(audienceKey, displayTypeKey);

  const rows = await query(
    `SELECT * FROM promotional_banners
     WHERE ${conditions.join(' AND ')}
     ORDER BY sort_order ASC, created_at DESC, id DESC`,
    values,
  );

  return Promise.all(rows.map(mapPromotionalBannerRow));
}

export async function getPromotionalBannerById(id) {
  await ensurePromotionalBannersSchema();
  const bannerId = Number(id);
  if (!bannerId) throw validationError('Invalid banner id.', 400);

  const rows = await query(`SELECT * FROM promotional_banners WHERE id = ? LIMIT 1`, [bannerId]);
  if (!rows.length) throw validationError('Promotional banner not found.', 404);

  return { ok: true, banner: await mapPromotionalBannerRow(rows[0]) };
}

function parseBannerPayload(body = {}) {
  const title = String(body.title ?? body.banner_title ?? '').trim();
  const description = String(body.description ?? body.banner_description ?? '').trim();
  const color = String(body.color ?? '#0D9F1B').trim() || '#0D9F1B';
  const ctaLink = String(body.cta_link ?? body.ctaLink ?? '').trim();
  const ctaLabel = String(body.cta_label ?? body.ctaLabel ?? 'Learn More').trim() || 'Learn More';
  const displayType = normalizeDisplayType(body.display_type ?? body.displayType);
  const audience = normalizeAudience(body.audience);
  const activeFrom = formatDateInput(body.active_from ?? body.activeFrom);
  const activeTo = formatDateInput(body.active_to ?? body.activeTo);
  const isActive = ['1', 'true', true, 1].includes(body.is_active ?? body.isActive ?? true);
  const sortOrder = Number(body.sort_order ?? body.sortOrder ?? 0) || 0;

  if (!title) throw validationError('Title is required.');

  return {
    title,
    description: description || null,
    color,
    ctaLink: ctaLink || null,
    ctaLabel,
    displayType,
    audience,
    activeFrom,
    activeTo,
    isActive: isActive ? 1 : 0,
    sortOrder,
  };
}

export async function createPromotionalBanner(body = {}, mediaFileOrFiles = null) {
  await ensurePromotionalBannersSchema();
  const payload = parseBannerPayload(body);
  const files = Array.isArray(mediaFileOrFiles)
    ? mediaFileOrFiles.filter(Boolean)
    : mediaFileOrFiles
      ? [mediaFileOrFiles]
      : [];

  if (files.length > 1 && payload.displayType !== 'slider') {
    throw validationError('Upload one image for static banners, or choose Slider for multiple images.');
  }

  const mediaNames = await storeMediaFiles(files);
  const primaryMedia = mediaNames[0] || null;

  const result = await query(
    `INSERT INTO promotional_banners (
      title, description, color, cta_link, cta_label, display_type, audience,
      active_from, active_to, media_filename, media_filenames, is_active, sort_order, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [
      payload.title,
      payload.description,
      payload.color,
      payload.ctaLink,
      payload.ctaLabel,
      payload.displayType,
      payload.audience,
      payload.activeFrom,
      payload.activeTo,
      primaryMedia,
      serializeMediaFilenames(mediaNames),
      payload.isActive,
      payload.sortOrder,
    ],
  );

  const id = result.insertId ?? result.lastInsertRowid;
  return getPromotionalBannerById(id);
}

/** @deprecated Use createPromotionalBanner with multiple files — kept for route compatibility. */
export async function createPromotionalBanners(body = {}, mediaFiles = []) {
  return createPromotionalBanner(body, mediaFiles);
}

export async function updatePromotionalBanner(id, body = {}, mediaFileOrFiles = null) {
  await ensurePromotionalBannersSchema();
  const { banner: existing } = await getPromotionalBannerById(id);
  const payload = parseBannerPayload({
    title: body.title ?? existing.title,
    description: body.description ?? existing.description,
    color: body.color ?? existing.color,
    cta_link: body.cta_link ?? body.ctaLink ?? existing.ctaLink,
    cta_label: body.cta_label ?? body.ctaLabel ?? existing.ctaLabel,
    display_type: body.display_type ?? body.displayType ?? existing.displayTypeKey,
    audience: body.audience ?? existing.audienceKey,
    active_from: body.active_from ?? body.activeFrom ?? existing.activeFrom,
    active_to: body.active_to ?? body.activeTo ?? existing.activeTo,
    is_active: body.is_active ?? body.isActive ?? existing.isActive,
    sort_order: body.sort_order ?? body.sortOrder ?? existing.sortOrder,
  });

  const files = Array.isArray(mediaFileOrFiles)
    ? mediaFileOrFiles.filter(Boolean)
    : mediaFileOrFiles
      ? [mediaFileOrFiles]
      : [];

  if (files.length > 1 && payload.displayType !== 'slider') {
    throw validationError('Upload one image for static banners, or choose Slider for multiple images.');
  }

  let mediaNames = Array.isArray(existing.mediaNames) ? [...existing.mediaNames] : [];
  if (!mediaNames.length && existing.mediaName) mediaNames = [existing.mediaName];

  if (files.length) {
    const uploaded = await storeMediaFiles(files);
    await deleteMediaFilenames(mediaNames);
    mediaNames = uploaded;
  }

  const removeMedia = ['1', 'true', true].includes(body.remove_media ?? body.removeMedia ?? false);
  if (removeMedia) {
    await deleteMediaFilenames(mediaNames);
    mediaNames = [];
  }

  const primaryMedia = mediaNames[0] || null;

  await query(
    `UPDATE promotional_banners
     SET title = ?, description = ?, color = ?, cta_link = ?, cta_label = ?,
         display_type = ?, audience = ?, active_from = ?, active_to = ?,
         media_filename = ?, media_filenames = ?, is_active = ?, sort_order = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [
      payload.title,
      payload.description,
      payload.color,
      payload.ctaLink,
      payload.ctaLabel,
      payload.displayType,
      payload.audience,
      payload.activeFrom,
      payload.activeTo,
      primaryMedia,
      serializeMediaFilenames(mediaNames),
      payload.isActive,
      payload.sortOrder,
      Number(id),
    ],
  );

  return getPromotionalBannerById(id);
}

export async function deletePromotionalBanner(id) {
  await ensurePromotionalBannersSchema();
  const { banner } = await getPromotionalBannerById(id);
  await deleteMediaFilenames(
    Array.isArray(banner.mediaNames) && banner.mediaNames.length
      ? banner.mediaNames
      : banner.mediaName
        ? [banner.mediaName]
        : [],
  );
  await query(`DELETE FROM promotional_banners WHERE id = ?`, [Number(id)]);
  return { ok: true, message: 'Promotional banner deleted.' };
}

function sliderContentKey(banner = {}) {
  return [
    String(banner.title || '').trim().toLowerCase(),
    String(banner.description || '').trim().toLowerCase(),
    String(banner.audienceKey || '').trim().toLowerCase(),
    String(banner.activeFrom || '').slice(0, 10),
    String(banner.activeTo || '').slice(0, 10),
    String(banner.color || '').trim().toLowerCase(),
    String(banner.ctaLink || '').trim(),
  ].join('|');
}

/** Merge legacy one-image-per-row slider banners into one promotion with many images. */
export function consolidateSliderBanners(banners = []) {
  const groups = new Map();

  for (const banner of banners) {
    if (!banner) continue;
    const key = sliderContentKey(banner);
    if (!groups.has(key)) {
      groups.set(key, {
        ...banner,
        mediaUrls: Array.isArray(banner.mediaUrls) ? [...banner.mediaUrls.filter(Boolean)] : banner.mediaUrl ? [banner.mediaUrl] : [],
        mediaNames: Array.isArray(banner.mediaNames) ? [...banner.mediaNames] : banner.mediaName ? [banner.mediaName] : [],
      });
      continue;
    }

    const group = groups.get(key);
    const urls = Array.isArray(banner.mediaUrls) && banner.mediaUrls.length
      ? banner.mediaUrls.filter(Boolean)
      : banner.mediaUrl
        ? [banner.mediaUrl]
        : [];
    const names = Array.isArray(banner.mediaNames) && banner.mediaNames.length
      ? banner.mediaNames
      : banner.mediaName
        ? [banner.mediaName]
        : [];

    urls.forEach((url, index) => {
      if (!url || group.mediaUrls.includes(url)) return;
      group.mediaUrls.push(url);
      group.mediaNames.push(names[index] || '');
    });
  }

  return Array.from(groups.values()).map((banner) => ({
    ...banner,
    mediaUrl: banner.mediaUrls[0] || null,
    mediaName: banner.mediaNames[0] || '',
    mediaCount: banner.mediaUrls.length,
  }));
}

export async function getDashboardPromotionalContent(userType = 'normal') {
  const [staticBanners, sliderBanners, allBanners] = await Promise.all([
    listActivePromotionalBannersForUserType(userType, { displayType: 'static' }),
    listActivePromotionalBannersForUserType(userType, { displayType: 'slider' }),
    listActivePromotionalBannersForUserType(userType, { displayType: 'all' }),
  ]);

  const consolidatedSliders = consolidateSliderBanners(sliderBanners);

  return {
    promo_banner: staticBanners[0] || null,
    promotional_slider_banners: consolidatedSliders,
    promotional_sliders: consolidatedSliders,
    promotional_banners: allBanners,
  };
}
