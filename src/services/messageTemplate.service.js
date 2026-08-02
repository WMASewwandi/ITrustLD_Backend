import { getDbDriver, query } from '../config/database.js';

let schemaReady = false;

export const TEMPLATE_PLACEHOLDERS = [
  { key: '{{username}}', sample: 'John Doe' },
  { key: '{{transaction_id}}', sample: 'TXN-88421' },
  { key: '{{amount}}', sample: 'LKR 25,000' },
  { key: '{{promo_code}}', sample: 'TRUST10' },
];

const TYPE_MAP = {
  email: 'email',
  sms: 'sms',
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

function normalizeType(value) {
  const key = String(value || 'email').trim().toLowerCase();
  return TYPE_MAP[key] || 'email';
}

function normalizeAudience(value) {
  const key = String(value || 'normal').trim().toLowerCase();
  return AUDIENCE_MAP[key] || 'normal';
}

async function ensureMessageTemplatesSchema() {
  if (schemaReady) return;

  if (getDbDriver() === 'sqlite') {
    await query(`
      CREATE TABLE IF NOT EXISTS message_templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        template_type TEXT NOT NULL DEFAULT 'email',
        subject TEXT,
        body TEXT NOT NULL,
        audience TEXT NOT NULL DEFAULT 'normal',
        is_active INTEGER NOT NULL DEFAULT 1,
        created_by INTEGER,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);
  } else {
    await query(`
      CREATE TABLE IF NOT EXISTS message_templates (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        template_type VARCHAR(20) NOT NULL DEFAULT 'email',
        subject VARCHAR(500) NULL,
        body TEXT NOT NULL,
        audience VARCHAR(30) NOT NULL DEFAULT 'normal',
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        created_by BIGINT UNSIGNED NULL,
        created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }

  schemaReady = true;
}

function mapTemplateRow(row) {
  const type = normalizeType(row.template_type);
  return {
    id: row.id,
    name: row.name,
    type: type === 'sms' ? 'SMS' : 'Email',
    subject: row.subject || '',
    body: row.body || '',
    audience: AUDIENCE_LABELS[normalizeAudience(row.audience)] || 'Normal Users',
    audienceKey: normalizeAudience(row.audience),
    active: row.is_active === 1 || row.is_active === true,
    updatedAt: row.updated_at,
  };
}

export async function listMessageTemplatesAdmin() {
  await ensureMessageTemplatesSchema();
  const rows = await query(
    `SELECT id, name, template_type, subject, body, audience, is_active, created_at, updated_at
     FROM message_templates
     ORDER BY updated_at DESC, id DESC`,
  );

  return {
    ok: true,
    templates: rows.map(mapTemplateRow),
    placeholders: TEMPLATE_PLACEHOLDERS,
  };
}

export async function createMessageTemplate(userId, payload = {}) {
  await ensureMessageTemplatesSchema();

  const name = String(payload.name || '').trim();
  const type = normalizeType(payload.type || payload.template_type);
  const audience = normalizeAudience(payload.audience);
  const subject = String(payload.subject || '').trim();
  const body = String(payload.body || '').trim();

  if (!name) {
    throw validationError('Template name is required.');
  }
  if (!body) {
    throw validationError('Template body is required.');
  }
  if (type === 'email' && !subject) {
    throw validationError('Email subject is required.');
  }
  if (type === 'sms' && body.length > 160) {
    throw validationError('SMS body must be 160 characters or fewer.');
  }

  const result = await query(
    `INSERT INTO message_templates (
      name, template_type, subject, body, audience, is_active, created_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 1, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [name, type, type === 'email' ? subject : null, body, audience, userId],
  );

  const id = result.insertId ?? result.lastInsertRowid;
  const rows = await query(`SELECT * FROM message_templates WHERE id = ? LIMIT 1`, [id]);
  return { ok: true, template: mapTemplateRow(rows[0]) };
}

export async function toggleMessageTemplateStatus(id) {
  await ensureMessageTemplatesSchema();
  const rows = await query(`SELECT * FROM message_templates WHERE id = ? LIMIT 1`, [id]);
  const row = rows[0];
  if (!row) {
    throw validationError('Template not found.', 404);
  }

  const nextActive = row.is_active === 1 || row.is_active === true ? 0 : 1;
  await query(
    `UPDATE message_templates SET is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [nextActive, id],
  );

  const updated = await query(`SELECT * FROM message_templates WHERE id = ? LIMIT 1`, [id]);
  return { ok: true, template: mapTemplateRow(updated[0]) };
}

export async function duplicateMessageTemplate(id, userId) {
  await ensureMessageTemplatesSchema();
  const rows = await query(`SELECT * FROM message_templates WHERE id = ? LIMIT 1`, [id]);
  const row = rows[0];
  if (!row) {
    throw validationError('Template not found.', 404);
  }

  const result = await query(
    `INSERT INTO message_templates (
      name, template_type, subject, body, audience, is_active, created_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 0, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [
      `${row.name} (Copy)`,
      row.template_type,
      row.subject,
      row.body,
      row.audience,
      userId,
    ],
  );

  const newId = result.insertId ?? result.lastInsertRowid;
  const created = await query(`SELECT * FROM message_templates WHERE id = ? LIMIT 1`, [newId]);
  return { ok: true, template: mapTemplateRow(created[0]) };
}

export async function deleteMessageTemplate(id) {
  await ensureMessageTemplatesSchema();
  const rows = await query(`SELECT id FROM message_templates WHERE id = ? LIMIT 1`, [id]);
  if (!rows[0]) {
    throw validationError('Template not found.', 404);
  }

  await query(`DELETE FROM message_templates WHERE id = ?`, [id]);
  return { ok: true };
}

export function renderTemplatePreview(text, placeholders = TEMPLATE_PLACEHOLDERS) {
  let output = String(text || '');
  placeholders.forEach(({ key, sample }) => {
    output = output.split(key).join(sample);
  });
  return output;
}
