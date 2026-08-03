import { getDbDriver, query } from '../config/database.js';
import { queueSmsMessage } from './notification.service.js';

let schemaReady = false;

const SEGMENT_MAP = {
  'all users': 'all_users',
  all_users: 'all_users',
  'normal users': 'normal_users',
  normal_users: 'normal_users',
  'affiliate users': 'affiliate_users',
  affiliate_users: 'affiliate_users',
  'pending kyc segment': 'pending_kyc',
  pending_kyc: 'pending_kyc',
};

const SEGMENT_LABELS = {
  all_users: 'All users',
  normal_users: 'Normal users',
  affiliate_users: 'Affiliate users',
  pending_kyc: 'Pending KYC segment',
};

const SEGMENT_WHERE = {
  all_users: `
    COALESCE(account_status, 'ACTIVE') != 'BANNED'
    AND mobile_number IS NOT NULL
    AND TRIM(mobile_number) != ''
  `,
  normal_users: `
    COALESCE(account_status, 'ACTIVE') != 'BANNED'
    AND mobile_number IS NOT NULL
    AND TRIM(mobile_number) != ''
    AND COALESCE(is_patner, 'NO') != 'YES'
  `,
  affiliate_users: `
    COALESCE(account_status, 'ACTIVE') != 'BANNED'
    AND mobile_number IS NOT NULL
    AND TRIM(mobile_number) != ''
    AND is_patner = 'YES'
  `,
  pending_kyc: `
    COALESCE(account_status, 'ACTIVE') != 'BANNED'
    AND mobile_number IS NOT NULL
    AND TRIM(mobile_number) != ''
    AND email_verification = 'VERIFIED'
    AND mobile_number_verification = 'VERIFIED'
    AND (
      identity_verification != 'VERIFIED'
      OR address_verification != 'VERIFIED'
    )
  `,
};

const BATCH_SIZE = 100;

function validationError(message, status = 422) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function normalizeSegment(value) {
  const key = String(value || 'all_users').trim().toLowerCase();
  return SEGMENT_MAP[key] || 'all_users';
}

function formatDateTimeInput(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatDisplayDateTime(value) {
  if (!value) return '';
  const date = new Date(String(value).replace(' ', 'T'));
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

async function ensureBulkSmsSchema() {
  if (schemaReady) return;

  if (getDbDriver() === 'sqlite') {
    await query(`
      CREATE TABLE IF NOT EXISTS bulk_sms_campaigns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        recipient_segment TEXT NOT NULL DEFAULT 'all_users',
        message TEXT NOT NULL,
        scheduled_at TEXT,
        status TEXT NOT NULL DEFAULT 'queued',
        total_recipients INTEGER NOT NULL DEFAULT 0,
        sent_count INTEGER NOT NULL DEFAULT 0,
        failed_count INTEGER NOT NULL DEFAULT 0,
        created_by INTEGER,
        started_at TEXT,
        completed_at TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);
  } else {
    await query(`
      CREATE TABLE IF NOT EXISTS bulk_sms_campaigns (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        recipient_segment VARCHAR(40) NOT NULL DEFAULT 'all_users',
        message TEXT NOT NULL,
        scheduled_at DATETIME NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'queued',
        total_recipients INT UNSIGNED NOT NULL DEFAULT 0,
        sent_count INT UNSIGNED NOT NULL DEFAULT 0,
        failed_count INT UNSIGNED NOT NULL DEFAULT 0,
        created_by BIGINT UNSIGNED NULL,
        started_at DATETIME NULL,
        completed_at DATETIME NULL,
        created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }

  schemaReady = true;
}

function mapCampaignRow(row) {
  const segment = normalizeSegment(row.recipient_segment);
  const total = Number(row.total_recipients) || 0;
  const sent = Number(row.sent_count) || 0;
  const failed = Number(row.failed_count) || 0;

  return {
    id: row.id,
    recipients: SEGMENT_LABELS[segment] || segment,
    recipientSegment: segment,
    message: row.message,
    scheduled: formatDisplayDateTime(row.scheduled_at),
    scheduledAt: row.scheduled_at,
    status: capitalizeStatus(row.status),
    sent,
    failed,
    total,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

function capitalizeStatus(status) {
  const value = String(status || 'queued').toLowerCase();
  if (value === 'sending') return 'Sending';
  if (value === 'sent') return 'Sent';
  if (value === 'failed') return 'Failed';
  if (value === 'cancelled') return 'Cancelled';
  return 'Queued';
}

async function countRecipients(segment) {
  const where = SEGMENT_WHERE[segment];
  if (!where) return 0;
  const rows = await query(`SELECT COUNT(*) AS total FROM account_holders WHERE ${where}`);
  return Number(rows[0]?.total) || 0;
}

async function fetchRecipientBatch(segment, offset, limit) {
  const where = SEGMENT_WHERE[segment];
  const rows = await query(
    `SELECT id, user_id, mobile_number
     FROM account_holders
     WHERE ${where}
     ORDER BY id ASC
     LIMIT ? OFFSET ?`,
    [limit, offset],
  );
  return rows;
}

export async function listBulkSmsCampaignsAdmin() {
  await ensureBulkSmsSchema();
  await processDueBulkSmsCampaigns();

  const rows = await query(
    `SELECT id, recipient_segment, message, scheduled_at, status, total_recipients,
            sent_count, failed_count, created_by, started_at, completed_at, created_at, updated_at
     FROM bulk_sms_campaigns
     ORDER BY created_at DESC, id DESC`,
  );

  const campaigns = rows.map(mapCampaignRow);
  const stats = {
    queued: campaigns.filter((c) => c.status === 'Queued').length,
    sending: campaigns.filter((c) => c.status === 'Sending').length,
    sent: campaigns.filter((c) => c.status === 'Sent').length,
  };

  return { ok: true, campaigns, stats };
}

export async function createBulkSmsCampaign(userId, payload = {}) {
  await ensureBulkSmsSchema();

  const segment = normalizeSegment(payload.recipients || payload.recipientSegment);
  const message = String(payload.message || '').trim();
  const scheduledDate = payload.schedule || payload.scheduledAt
    ? new Date(payload.schedule || payload.scheduledAt)
    : new Date();
  if (Number.isNaN(scheduledDate.getTime())) {
    throw validationError('Invalid schedule date.');
  }
  const scheduledAt = formatDateTimeInput(scheduledDate);
  const sendNow = scheduledDate.getTime() <= Date.now();

  if (!message) {
    throw validationError('SMS message is required.');
  }
  if (message.length > 160) {
    throw validationError('SMS message must be 160 characters or fewer.');
  }

  const totalRecipients = await countRecipients(segment);
  if (totalRecipients === 0) {
    throw validationError('No recipients found for the selected segment.');
  }

  const result = await query(
    `INSERT INTO bulk_sms_campaigns (
      recipient_segment, message, scheduled_at, status, total_recipients,
      sent_count, failed_count, created_by, created_at, updated_at
    ) VALUES (?, ?, ?, 'queued', ?, 0, 0, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [segment, message, scheduledAt, totalRecipients, userId],
  );

  const id = result.insertId ?? result.lastInsertRowid;
  if (sendNow) {
    await processBulkSmsCampaign(id);
  }

  const rows = await query(`SELECT * FROM bulk_sms_campaigns WHERE id = ? LIMIT 1`, [id]);
  return { ok: true, campaign: mapCampaignRow(rows[0]) };
}

export async function processDueBulkSmsCampaigns() {
  await ensureBulkSmsSchema();
  const now = formatDateTimeInput(new Date());
  const rows = await query(
    `SELECT id
     FROM bulk_sms_campaigns
     WHERE status IN ('queued', 'sending')
       AND (scheduled_at IS NULL OR scheduled_at <= ?)
     ORDER BY scheduled_at ASC, id ASC`,
    [now],
  );

  for (const row of rows) {
    await processBulkSmsCampaign(row.id);
  }
}

export async function processBulkSmsCampaign(campaignId) {
  await ensureBulkSmsSchema();

  const rows = await query(`SELECT * FROM bulk_sms_campaigns WHERE id = ? LIMIT 1`, [campaignId]);
  const campaign = rows[0];
  if (!campaign) return;

  const status = String(campaign.status || '').toLowerCase();
  if (!['queued', 'sending'].includes(status)) return;

  const now = formatDateTimeInput(new Date());
  if (campaign.scheduled_at && campaign.scheduled_at > now) return;

  if (status === 'queued') {
    await query(
      `UPDATE bulk_sms_campaigns
       SET status = 'sending', started_at = COALESCE(started_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [campaignId],
    );
  }

  const segment = normalizeSegment(campaign.recipient_segment);
  const sentCount = Number(campaign.sent_count) || 0;
  const failedCount = Number(campaign.failed_count) || 0;
  const totalRecipients = Number(campaign.total_recipients) || 0;

  if (sentCount + failedCount >= totalRecipients) {
    await query(
      `UPDATE bulk_sms_campaigns
       SET status = 'sent', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [campaignId],
    );
    return;
  }

  const recipients = await fetchRecipientBatch(segment, sentCount + failedCount, BATCH_SIZE);
  if (!recipients.length) {
    await query(
      `UPDATE bulk_sms_campaigns
       SET status = 'sent', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [campaignId],
    );
    return;
  }

  let batchSent = 0;
  let batchFailed = 0;

  for (const recipient of recipients) {
    try {
      await queueSmsMessage({
        message: campaign.message,
        msisdn: recipient.mobile_number,
        userId: recipient.user_id,
        smsType: 'BULK_CAMPAIGN',
      });
      batchSent += 1;
    } catch {
      batchFailed += 1;
    }
  }

  const nextSent = sentCount + batchSent;
  const nextFailed = failedCount + batchFailed;
  const isComplete = nextSent + nextFailed >= totalRecipients;

  await query(
    `UPDATE bulk_sms_campaigns
     SET sent_count = ?, failed_count = ?, status = ?, completed_at = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [
      nextSent,
      nextFailed,
      isComplete ? 'sent' : 'sending',
      isComplete ? formatDateTimeInput(new Date()) : null,
      campaignId,
    ],
  );
}

export async function cancelBulkSmsCampaign(id) {
  await ensureBulkSmsSchema();
  const rows = await query(`SELECT * FROM bulk_sms_campaigns WHERE id = ? LIMIT 1`, [id]);
  const campaign = rows[0];
  if (!campaign) {
    throw validationError('Campaign not found.', 404);
  }

  const status = String(campaign.status || '').toLowerCase();
  if (!['queued', 'sending'].includes(status)) {
    throw validationError('Only queued or sending campaigns can be cancelled.');
  }

  await query(
    `UPDATE bulk_sms_campaigns
     SET status = 'cancelled', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [id],
  );

  const updated = await query(`SELECT * FROM bulk_sms_campaigns WHERE id = ? LIMIT 1`, [id]);
  return { ok: true, campaign: mapCampaignRow(updated[0]) };
}
