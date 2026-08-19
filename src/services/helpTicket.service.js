import { getDbDriver } from '../config/database.js';
import { query } from '../config/database.js';
import { sendMail } from './mail.service.js';
import { helpTicketReplyEmailHtml } from './mail.templates.js';
import { isTurnstileRequired, verifyTurnstileToken } from './turnstile.service.js';

let schemaReady = false;

function validationError(message, status = 422) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function formatTimestamp(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function toBool(value) {
  return value === true || value === 1 || value === '1';
}

async function hasIsReadColumn() {
  if (getDbDriver() === 'sqlite') {
    const rows = await query(`PRAGMA table_info(help_tickets)`);
    return rows.some((row) => String(row.name).toLowerCase() === 'is_read');
  }

  const rows = await query(`SHOW COLUMNS FROM help_tickets LIKE 'is_read'`);
  return rows.length > 0;
}

export async function ensureHelpTicketsSchema() {
  if (schemaReady) return;

  const exists = await hasIsReadColumn();
  if (!exists) {
    if (getDbDriver() === 'sqlite') {
      await query(`ALTER TABLE help_tickets ADD COLUMN is_read INTEGER NOT NULL DEFAULT 0`);
    } else {
      await query(
        `ALTER TABLE help_tickets ADD COLUMN is_read TINYINT(1) NOT NULL DEFAULT 0 AFTER message`,
      );
    }
  }

  schemaReady = true;
}

function mapHelpTicketRow(row) {
  const isGuest = !row.user_id;
  return {
    id: row.id,
    userId: row.user_id != null ? Number(row.user_id) : null,
    firstName: row.first_name || '',
    lastName: row.last_name || '',
    fullName: [row.first_name, row.last_name].filter(Boolean).join(' ').trim() || '—',
    email: row.email || '—',
    subject: row.subject || '—',
    message: row.message || '',
    isRead: toBool(row.is_read),
    isGuest,
    type: isGuest ? 'Guest' : 'Member',
    submittedAt: formatTimestamp(row.created_at),
    createdAt: row.created_at,
  };
}

export async function countHelpTickets() {
  await ensureHelpTicketsSchema();
  const rows = await query(`SELECT COUNT(*) AS total FROM help_tickets`, []);
  return Number(rows[0]?.total ?? 0);
}

export async function countUnreadHelpTickets() {
  await ensureHelpTicketsSchema();
  const rows = await query(
    `SELECT COUNT(*) AS total FROM help_tickets WHERE is_read = 0 OR is_read IS NULL`,
    [],
  );
  return Number(rows[0]?.total ?? 0);
}

async function assertGuestDuplicateWindow(email, subject, message) {
  const sql =
    getDbDriver() === 'sqlite'
      ? `SELECT COUNT(*) AS total
         FROM help_tickets
         WHERE user_id IS NULL
           AND email = ?
           AND subject = ?
           AND message = ?
           AND created_at >= datetime('now', '-10 minutes')`
      : `SELECT COUNT(*) AS total
         FROM help_tickets
         WHERE user_id IS NULL
           AND email = ?
           AND subject = ?
           AND message = ?
           AND created_at >= DATE_SUB(CURRENT_TIMESTAMP, INTERVAL 10 MINUTE)`;

  const rows = await query(sql, [email, `Guest: ${subject}`, message]);
  const duplicates = Number(rows[0]?.total ?? 0);
  if (duplicates > 0) {
    throw validationError('We already received this support request recently. Please wait for our reply instead of submitting the same message again.', 429);
  }
}

export async function createHelpTicket(userId, payload = {}, { remoteIp = null } = {}) {
  await ensureHelpTicketsSchema();

  const firstName = String(payload.first_name ?? payload.firstName ?? '').trim();
  const lastName = String(payload.last_name ?? payload.lastName ?? '').trim();
  const email = String(payload.email ?? '').trim();
  const subject = String(payload.subject ?? '').trim();
  const message = String(payload.message ?? '').trim();

  if (!firstName) throw validationError('First name is required.');
  if (!email) throw validationError('Email is required.');
  if (!subject) throw validationError('Subject is required.');
  if (!message) throw validationError('Message is required.');
  if (!email.includes('@')) throw validationError('A valid email is required.');

  const resolvedUserId = userId != null ? Number(userId) : null;
  const turnstileToken =
    payload.cf_turnstile_response ||
    payload['cf-turnstile-response'] ||
    payload.turnstile_token;

  if (resolvedUserId == null) {
    if (isTurnstileRequired()) {
      const valid = await verifyTurnstileToken(turnstileToken, remoteIp);
      if (!valid) {
        throw validationError('You failed to verify that you are not a robot.');
      }
    }

    await assertGuestDuplicateWindow(email, subject, message);
  }

  const resolvedSubject =
    resolvedUserId != null ? subject : `Guest: ${subject}`;

  const result = await query(
    `INSERT INTO help_tickets (user_id, first_name, last_name, email, subject, message, is_read, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [resolvedUserId, firstName, lastName || null, email, resolvedSubject, message],
  );

  return {
    ok: true,
    id: result.insertId ?? result.lastInsertRowid ?? null,
    message:
      'Your support ticket was submitted successfully. Our support team will respond you via email',
  };
}

export async function listHelpTickets(params = {}) {
  await ensureHelpTicketsSchema();

  const page = Math.max(1, Number(params.page) || 1);
  const perPage = Math.min(100, Math.max(1, Number(params.per_page) || 50));
  const offset = (page - 1) * perPage;

  const conditions = [];
  const values = [];

  const search = String(params.search ?? '').trim();
  const email = String(params.email ?? '').trim();
  const type = String(params.type ?? '').trim().toLowerCase();
  const readFilter = String(params.read ?? params.is_read ?? '').trim().toLowerCase();

  if (search) {
    const like = `%${escapeLike(search)}%`;
    conditions.push(
      `(ht.first_name LIKE ? ESCAPE '\\\\' OR ht.last_name LIKE ? ESCAPE '\\\\' OR ht.email LIKE ? ESCAPE '\\\\' OR ht.subject LIKE ? ESCAPE '\\\\' OR ht.message LIKE ? ESCAPE '\\\\')`,
    );
    values.push(like, like, like, like, like);
  }

  if (email) {
    conditions.push(`ht.email LIKE ? ESCAPE '\\\\'`);
    values.push(`%${escapeLike(email)}%`);
  }

  if (type === 'guest') {
    conditions.push('ht.user_id IS NULL');
  } else if (type === 'member') {
    conditions.push('ht.user_id IS NOT NULL');
  }

  if (readFilter === 'unread' || readFilter === '0' || readFilter === 'false') {
    conditions.push('(ht.is_read = 0 OR ht.is_read IS NULL)');
  } else if (readFilter === 'read' || readFilter === '1' || readFilter === 'true') {
    conditions.push('ht.is_read = 1');
  }

  const whereSql = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const countRows = await query(
    `SELECT COUNT(*) AS total FROM help_tickets ht ${whereSql}`,
    values,
  );
  const total = Number(countRows[0]?.total) || 0;

  const rows = await query(
    `SELECT ht.*
     FROM help_tickets ht
     ${whereSql}
     ORDER BY ht.is_read ASC, ht.created_at DESC, ht.id DESC
     LIMIT ? OFFSET ?`,
    [...values, perPage, offset],
  );

  return {
    ok: true,
    tickets: rows.map(mapHelpTicketRow),
    pagination: {
      page,
      per_page: perPage,
      total,
      total_pages: Math.max(1, Math.ceil(total / perPage)),
    },
  };
}

export async function getHelpTicketById(id) {
  await ensureHelpTicketsSchema();

  const ticketId = Number(id);
  if (!ticketId) throw validationError('Invalid ticket id.', 400);

  const rows = await query(`SELECT * FROM help_tickets WHERE id = ? LIMIT 1`, [ticketId]);
  if (!rows.length) throw validationError('Help ticket not found.', 404);

  return { ok: true, ticket: mapHelpTicketRow(rows[0]) };
}

export async function markHelpTicketRead(id) {
  await ensureHelpTicketsSchema();

  const ticketId = Number(id);
  if (!ticketId) throw validationError('Invalid ticket id.', 400);

  const existing = await getHelpTicketById(ticketId);
  if (existing.ticket.isRead) {
    return {
      ok: true,
      ticket: existing.ticket,
      unread: await countUnreadHelpTickets(),
    };
  }

  await query(
    `UPDATE help_tickets SET is_read = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [ticketId],
  );

  const updated = await getHelpTicketById(ticketId);
  return {
    ...updated,
    unread: await countUnreadHelpTickets(),
  };
}

export async function markAllHelpTicketsRead() {
  await ensureHelpTicketsSchema();

  const result = await query(
    `UPDATE help_tickets SET is_read = 1, updated_at = CURRENT_TIMESTAMP WHERE is_read = 0 OR is_read IS NULL`,
    [],
  );

  const updated = Number(result.affectedRows ?? result.changes ?? 0);

  return {
    ok: true,
    message:
      updated > 0
        ? `${updated} help ticket${updated === 1 ? '' : 's'} marked as read.`
        : 'All help tickets are already read.',
    updated,
    unread: await countUnreadHelpTickets(),
  };
}

export async function replyToHelpTicket(id, payload = {}) {
  await ensureHelpTicketsSchema();

  const ticketId = Number(id);
  if (!ticketId) throw validationError('Invalid ticket id.', 400);

  const { ticket } = await getHelpTicketById(ticketId);
  const replySubject = String(payload.subject ?? '').trim();
  const replyMessage = String(payload.message ?? payload.body ?? '').trim();

  if (!replySubject) throw validationError('Reply subject is required.');
  if (!replyMessage) throw validationError('Reply message is required.');

  const html = helpTicketReplyEmailHtml({
    firstName: ticket.firstName,
    originalSubject: ticket.subject,
    originalMessage: ticket.message,
    replyMessage,
  });

  await sendMail({
    to: ticket.email,
    subject: replySubject,
    html,
    text: replyMessage,
  });

  await markHelpTicketRead(ticketId);

  return {
    ok: true,
    message: `Reply sent to ${ticket.email}.`,
    ticket: (await getHelpTicketById(ticketId)).ticket,
    unread: await countUnreadHelpTickets(),
  };
}
