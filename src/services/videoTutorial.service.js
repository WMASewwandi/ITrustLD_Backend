import { getDbDriver, query } from '../config/database.js';

let schemaReady = false;

const CATEGORY_MAP = {
  trending: 'trending',
  'new and trending': 'trending',
  guides: 'guides',
  'wizarding world': 'guides',
};

const CATEGORY_LABELS = {
  trending: 'New and Trending',
  guides: 'Wizarding World',
};

const DEFAULT_TUTORIALS = [
  { title: 'Sign Up on ITrustLD', youtubeId: 'bxhgIx_dHok', category: 'trending', sortOrder: 1 },
  {
    title: 'How to Redeem Your Bonus on ITrustLD',
    youtubeId: '4dPyJzDe8zg',
    category: 'trending',
    sortOrder: 2,
  },
  {
    title: 'How to Add an Account & Wallet',
    youtubeId: 'V1_vh7Qty1o',
    category: 'trending',
    sortOrder: 3,
  },
  {
    title: 'How to Top Up Your Wallet',
    youtubeId: 'RMbYft4hpiE',
    category: 'guides',
    sortOrder: 4,
  },
  {
    title: 'How to Cash Out Your Wallet',
    youtubeId: 'Ww_cuQh7Kak',
    category: 'guides',
    sortOrder: 5,
  },
  {
    title: 'How to Redeem Trust Points',
    youtubeId: '3UNbhpn-_6w',
    category: 'guides',
    sortOrder: 6,
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

function normalizeCategory(value) {
  const key = String(value || 'trending').trim().toLowerCase();
  return CATEGORY_MAP[key] || 'trending';
}

export function extractYoutubeId(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (/^[\w-]{11}$/.test(raw)) return raw;

  const patterns = [
    /(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|shorts\/|watch\?v=|watch\?.+&v=))([\w-]{11})/i,
    /^https?:\/\/(?:www\.)?youtube\.com\/watch\?.*v=([\w-]{11})/i,
  ];

  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (match?.[1]) return match[1];
  }

  return null;
}

export function buildYoutubeEmbedUrl(youtubeId) {
  return `https://www.youtube.com/embed/${youtubeId}`;
}

export function buildYoutubeThumbnailUrl(youtubeId) {
  return `https://img.youtube.com/vi/${youtubeId}/hqdefault.jpg`;
}

async function tableExists() {
  if (getDbDriver() === 'sqlite') {
    const rows = await query(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'video_tutorials'`,
    );
    return rows.length > 0;
  }
  const rows = await query(`SHOW TABLES LIKE 'video_tutorials'`);
  return rows.length > 0;
}

async function seedDefaultTutorials() {
  const rows = await query(`SELECT COUNT(*) AS total FROM video_tutorials`);
  const total = Number(rows[0]?.total) || 0;
  if (total > 0) return;

  for (const item of DEFAULT_TUTORIALS) {
    await query(
      `INSERT INTO video_tutorials
        (title, subtitle, youtube_id, category, duration, is_new, sort_order, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [item.title, '', item.youtubeId, item.category, '', 1, item.sortOrder],
    );
  }
}

export async function ensureVideoTutorialsSchema() {
  if (schemaReady) return;

  const exists = await tableExists();
  if (!exists) {
    if (getDbDriver() === 'sqlite') {
      await query(`
        CREATE TABLE IF NOT EXISTS video_tutorials (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL,
          subtitle TEXT,
          youtube_id TEXT NOT NULL,
          category TEXT NOT NULL DEFAULT 'trending',
          duration TEXT,
          is_new INTEGER NOT NULL DEFAULT 0,
          sort_order INTEGER NOT NULL DEFAULT 0,
          is_active INTEGER NOT NULL DEFAULT 1,
          created_at TEXT,
          updated_at TEXT
        )
      `);
    } else {
      await query(`
        CREATE TABLE video_tutorials (
          id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
          title VARCHAR(255) NOT NULL,
          subtitle VARCHAR(500) NULL,
          youtube_id VARCHAR(20) NOT NULL,
          category VARCHAR(32) NOT NULL DEFAULT 'trending',
          duration VARCHAR(16) NULL,
          is_new TINYINT(1) NOT NULL DEFAULT 0,
          sort_order INT UNSIGNED NOT NULL DEFAULT 0,
          is_active TINYINT(1) NOT NULL DEFAULT 1,
          created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )
      `);
    }
  }

  await seedDefaultTutorials();
  schemaReady = true;
}

function mapVideoTutorialRow(row) {
  const youtubeId = row.youtube_id || '';
  const categoryKey = row.category || 'trending';

  return {
    id: row.id,
    title: row.title || '',
    subtitle: row.subtitle || '',
    youtubeId,
    youtubeUrl: youtubeId ? `https://www.youtube.com/watch?v=${youtubeId}` : '',
    embedUrl: youtubeId ? buildYoutubeEmbedUrl(youtubeId) : '',
    thumbnailUrl: youtubeId ? buildYoutubeThumbnailUrl(youtubeId) : '',
    category: CATEGORY_LABELS[categoryKey] || CATEGORY_LABELS.trending,
    categoryKey,
    duration: row.duration || '',
    isNew: toBool(row.is_new),
    sortOrder: Number(row.sort_order) || 0,
    isActive: toBool(row.is_active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listVideoTutorialsAdmin() {
  await ensureVideoTutorialsSchema();
  const rows = await query(
    `SELECT *
     FROM video_tutorials
     ORDER BY sort_order ASC, id ASC`,
  );
  return {
    ok: true,
    tutorials: rows.map(mapVideoTutorialRow),
  };
}

export async function listActiveVideoTutorials() {
  await ensureVideoTutorialsSchema();
  const rows = await query(
    `SELECT *
     FROM video_tutorials
     WHERE is_active = 1
     ORDER BY sort_order ASC, id ASC`,
  );
  return rows.map(mapVideoTutorialRow);
}

export async function findVideoTutorialById(id) {
  await ensureVideoTutorialsSchema();
  const rows = await query(`SELECT * FROM video_tutorials WHERE id = ? LIMIT 1`, [id]);
  if (!rows[0]) return null;
  return mapVideoTutorialRow(rows[0]);
}

export async function createVideoTutorial(payload = {}) {
  await ensureVideoTutorialsSchema();

  const title = String(payload.title ?? '').trim();
  const subtitle = String(payload.subtitle ?? '').trim();
  const youtubeInput = payload.youtube_id ?? payload.youtubeId ?? payload.youtube_url ?? payload.youtubeUrl;
  const youtubeId = extractYoutubeId(youtubeInput);
  const category = normalizeCategory(payload.category ?? payload.categoryKey);
  const duration = String(payload.duration ?? '').trim();
  const isNew = toBool(payload.is_new ?? payload.isNew);
  const sortOrder = Number(payload.sort_order ?? payload.sortOrder) || 0;
  const isActive = payload.is_active !== undefined || payload.isActive !== undefined
    ? toBool(payload.is_active ?? payload.isActive)
    : true;

  if (!title) throw validationError('Title is required.');
  if (!youtubeId) throw validationError('A valid YouTube URL or video ID is required.');

  const result = await query(
    `INSERT INTO video_tutorials
      (title, subtitle, youtube_id, category, duration, is_new, sort_order, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [title, subtitle || null, youtubeId, category, duration || null, isNew ? 1 : 0, sortOrder, isActive ? 1 : 0],
  );

  const id = result.insertId ?? result.lastInsertRowid;
  return {
    ok: true,
    tutorial: await findVideoTutorialById(id),
  };
}

export async function updateVideoTutorial(id, payload = {}) {
  await ensureVideoTutorialsSchema();

  const existing = await findVideoTutorialById(id);
  if (!existing) throw validationError('Video tutorial not found.', 404);

  const title = String(payload.title ?? existing.title).trim();
  const subtitle = String(payload.subtitle ?? existing.subtitle).trim();
  const youtubeInput = payload.youtube_id ?? payload.youtubeId ?? payload.youtube_url ?? payload.youtubeUrl;
  const youtubeId = youtubeInput != null && String(youtubeInput).trim()
    ? extractYoutubeId(youtubeInput)
    : existing.youtubeId;
  const category = normalizeCategory(payload.category ?? payload.categoryKey ?? existing.categoryKey);
  const duration = payload.duration !== undefined
    ? String(payload.duration ?? '').trim()
    : existing.duration;
  const isNew = payload.is_new !== undefined || payload.isNew !== undefined
    ? toBool(payload.is_new ?? payload.isNew)
    : existing.isNew;
  const sortOrder = payload.sort_order !== undefined || payload.sortOrder !== undefined
    ? Number(payload.sort_order ?? payload.sortOrder) || 0
    : existing.sortOrder;
  const isActive = payload.is_active !== undefined || payload.isActive !== undefined
    ? toBool(payload.is_active ?? payload.isActive)
    : existing.isActive;

  if (!title) throw validationError('Title is required.');
  if (!youtubeId) throw validationError('A valid YouTube URL or video ID is required.');

  await query(
    `UPDATE video_tutorials
     SET title = ?, subtitle = ?, youtube_id = ?, category = ?, duration = ?,
         is_new = ?, sort_order = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [
      title,
      subtitle || null,
      youtubeId,
      category,
      duration || null,
      isNew ? 1 : 0,
      sortOrder,
      isActive ? 1 : 0,
      id,
    ],
  );

  return {
    ok: true,
    tutorial: await findVideoTutorialById(id),
  };
}

export async function deleteVideoTutorial(id) {
  await ensureVideoTutorialsSchema();

  const existing = await findVideoTutorialById(id);
  if (!existing) throw validationError('Video tutorial not found.', 404);

  await query(`DELETE FROM video_tutorials WHERE id = ?`, [id]);
  return { ok: true, id: Number(id) };
}
