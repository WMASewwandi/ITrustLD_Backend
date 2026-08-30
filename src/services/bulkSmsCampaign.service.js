import { getDbDriver, query } from '../config/database.js';
import { addColumnIfMissing, createTableIfMissing } from '../db/helpers.js';
import { formatTimestampSl, nowSqlDateTime, parseDbDateTime } from '../utils/slTime.js';
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
  custom: 'custom',
};

const SEGMENT_LABELS = {
  all_users: 'All users',
  normal_users: 'Normal users',
  affiliate_users: 'Affiliate users',
  pending_kyc: 'Pending KYC segment',
  custom: 'Custom',
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
const MAX_CUSTOM_NUMBERS = 200;
const processingCampaignIds = new Set();

function validationError(message, status = 422) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function normalizeSegment(value) {
  const key = String(value || 'all_users').trim().toLowerCase();
  return SEGMENT_MAP[key] || 'all_users';
}

function formatDisplayDateTime(value) {
  if (!value) return '';
  const date = parseDbDateTime(value);
  if (!date) return String(value);
  return date.toLocaleString('en-GB', {
    timeZone: 'Asia/Colombo',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function parseScheduleInput(value) {
  if (value == null || String(value).trim() === '') return null;
  return parseDbDateTime(value);
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

  await addColumnIfMissing('bulk_sms_campaigns', 'recipient_emails', {
    sqlite: 'recipient_emails TEXT',
    mysql: 'recipient_emails TEXT NULL AFTER recipient_segment',
  });
  await addColumnIfMissing('bulk_sms_campaigns', 'processing_at', {
    sqlite: 'processing_at TEXT',
    mysql: 'processing_at DATETIME NULL',
  });
  await addColumnIfMissing('bulk_sms_campaigns', 'processed_count', {
    sqlite: 'processed_count INTEGER NOT NULL DEFAULT 0',
    mysql: 'processed_count INT UNSIGNED NOT NULL DEFAULT 0',
  });

  await createTableIfMissing('bulk_sms_send_log', {
    sqlite: `
      CREATE TABLE IF NOT EXISTS bulk_sms_send_log (
        campaign_id INTEGER NOT NULL,
        mobile_key TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (campaign_id, mobile_key)
      )
    `,
    mysql: `
      CREATE TABLE IF NOT EXISTS bulk_sms_send_log (
        campaign_id BIGINT UNSIGNED NOT NULL,
        mobile_key VARCHAR(20) NOT NULL,
        created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (campaign_id, mobile_key)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `,
  });

  schemaReady = true;
}

function parseCustomNumbers(value) {
  const raw = Array.isArray(value) ? value.join(',') : String(value || '');
  const tokens = raw
    .split(/[\s,;]+/)
    .map((token) => token.trim())
    .filter(Boolean);
  const seen = new Set();
  const unique = [];
  for (const token of tokens) {
    const key = mobileKey(token) || `raw:${token}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(token);
  }
  return unique;
}

function isPhoneToken(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length >= 9 && digits.length <= 15;
}

function mobileKey(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return '';
  return digits.length >= 9 ? digits.slice(-9) : digits;
}

function mobileKeySql() {
  if (getDbDriver() === 'sqlite') {
    return `substr(replace(replace(replace(replace(coalesce(mobile_number,''), '+', ''), '-', ''), ' ', ''), '/', ''), -9)`;
  }
  return `RIGHT(REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(mobile_number,''), '+', ''), '-', ''), ' ', ''), '/', ''), 9)`;
}

function affectedCount(result) {
  return Number(result?.affectedRows ?? result?.changes ?? 0);
}

async function claimCampaignProcessLock(campaignId) {
  const now = nowSqlDateTime();
  const stale = formatTimestampSl(new Date(Date.now() - 3 * 60 * 1000));
  const result = await query(
    `UPDATE bulk_sms_campaigns
     SET processing_at = ?
     WHERE id = ?
       AND status IN ('queued', 'sending')
       AND (processing_at IS NULL OR processing_at < ?)`,
    [now, campaignId, stale],
  );
  return affectedCount(result) === 1;
}

async function releaseCampaignProcessLock(campaignId) {
  await query(
    `UPDATE bulk_sms_campaigns
     SET processing_at = NULL
     WHERE id = ?`,
    [campaignId],
  );
}

async function claimCampaignMobile(campaignId, msisdn) {
  const key = mobileKey(msisdn);
  if (!key) return false;
  try {
    if (getDbDriver() === 'sqlite') {
      const result = await query(
        `INSERT OR IGNORE INTO bulk_sms_send_log (campaign_id, mobile_key, created_at)
         VALUES (?, ?, CURRENT_TIMESTAMP)`,
        [campaignId, key],
      );
      return affectedCount(result) > 0;
    }
    const result = await query(
      `INSERT IGNORE INTO bulk_sms_send_log (campaign_id, mobile_key, created_at)
       VALUES (?, ?, NOW())`,
      [campaignId, key],
    );
    return affectedCount(result) > 0;
  } catch (error) {
    if (error?.code === 'ER_DUP_ENTRY' || /unique|duplicate/i.test(String(error.message || ''))) {
      return false;
    }
    throw error;
  }
}

function recipientLabel(segment, numbers = []) {
  if (segment === 'custom') {
    return numbers.length ? `Custom (${numbers.length})` : 'Custom';
  }
  return SEGMENT_LABELS[segment] || segment;
}

function mapCampaignRow(row) {
  const segment = normalizeSegment(row.recipient_segment);
  const customNumbers = parseCustomNumbers(row.recipient_emails);
  const total = Number(row.total_recipients) || 0;
  const sent = Number(row.sent_count) || 0;
  const failed = Number(row.failed_count) || 0;

  return {
    id: row.id,
    recipients: recipientLabel(segment, customNumbers),
    recipientSegment: segment,
    customNumbers,
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

function resolveCustomRecipients(numbers) {
  if (!numbers.length) {
    return { recipients: [] };
  }

  const invalid = numbers.find((number) => !isPhoneToken(number));
  if (invalid) {
    throw validationError(`Invalid mobile number: ${invalid}`);
  }

  return {
    recipients: numbers.map((mobile) => ({
      user_id: null,
      mobile_number: mobile,
    })),
  };
}

async function countRecipients(segment, customNumbers = []) {
  if (segment === 'custom') {
    return resolveCustomRecipients(customNumbers).recipients.length;
  }
  const where = SEGMENT_WHERE[segment];
  if (!where) return 0;
  const rows = await query(
    `SELECT COUNT(*) AS total FROM (
       SELECT 1 FROM account_holders WHERE ${where} GROUP BY ${mobileKeySql()}
     ) unique_mobiles`,
  );
  return Number(rows[0]?.total) || 0;
}

async function fetchRecipientBatch(segment, offset, limit, customNumbers = []) {
  if (segment === 'custom') {
    return resolveCustomRecipients(customNumbers).recipients.slice(offset, offset + limit);
  }
  const where = SEGMENT_WHERE[segment];
  const rows = await query(
    `SELECT MIN(id) AS id, MIN(user_id) AS user_id, MIN(mobile_number) AS mobile_number
     FROM account_holders
     WHERE ${where}
     GROUP BY ${mobileKeySql()}
     ORDER BY MIN(id) ASC
     LIMIT ? OFFSET ?`,
    [limit, offset],
  );
  return rows;
}

export async function listBulkSmsCampaignsAdmin() {
  await ensureBulkSmsSchema();
  await processDueBulkSmsCampaigns();

  const rows = await query(
    `SELECT id, recipient_segment, recipient_emails, message, scheduled_at, status, total_recipients,
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
  const rawSchedule = payload.schedule || payload.scheduledAt;
  const scheduledDate = rawSchedule ? parseScheduleInput(rawSchedule) : new Date();
  if (!scheduledDate || Number.isNaN(scheduledDate.getTime())) {
    throw validationError('Invalid schedule date.');
  }
  const now = nowSqlDateTime();
  const scheduledAt = rawSchedule ? formatTimestampSl(scheduledDate) : now;
  const sendNow = scheduledDate.getTime() <= Date.now();

  if (!message) {
    throw validationError('SMS message is required.');
  }
  if (message.length > 160) {
    throw validationError('SMS message must be 160 characters or fewer.');
  }

  let customNumbers = [];
  if (segment === 'custom') {
    customNumbers = parseCustomNumbers(
      payload.numbers || payload.customNumbers || payload.emails || payload.customRecipients || payload.recipientEmails,
    );
    if (!customNumbers.length) {
      throw validationError('Enter at least one mobile number.');
    }
    if (customNumbers.length > MAX_CUSTOM_NUMBERS) {
      throw validationError(`You can enter at most ${MAX_CUSTOM_NUMBERS} mobile numbers.`);
    }
    resolveCustomRecipients(customNumbers);
  }

  const totalRecipients = await countRecipients(segment, customNumbers);
  if (totalRecipients === 0) {
    throw validationError(
      segment === 'custom'
        ? 'Enter at least one valid mobile number.'
        : 'No recipients found for the selected segment.',
    );
  }

  const result = await query(
    `INSERT INTO bulk_sms_campaigns (
      recipient_segment, recipient_emails, message, scheduled_at, status, total_recipients,
      sent_count, failed_count, created_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'queued', ?, 0, 0, ?, ?, ?)`,
    [
      segment,
      segment === 'custom' ? customNumbers.join(',') : null,
      message,
      scheduledAt,
      totalRecipients,
      userId,
      now,
      now,
    ],
  );

  const id = result.insertId ?? result.lastInsertRowid;
  if (sendNow) {
    await processBulkSmsCampaign(id);
  }

  const rows = await query(`SELECT * FROM bulk_sms_campaigns WHERE id = ? LIMIT 1`, [id]);
  return { ok: true, campaign: mapCampaignRow(rows[0]) };
}

async function getCampaignStatus(campaignId) {
  const rows = await query(`SELECT status FROM bulk_sms_campaigns WHERE id = ? LIMIT 1`, [campaignId]);
  return String(rows[0]?.status || '').toLowerCase();
}

function isCancellableStatus(status) {
  return status === 'queued' || status === 'sending';
}

export async function processDueBulkSmsCampaigns() {
  await ensureBulkSmsSchema();
  const now = nowSqlDateTime();
  const rows = await query(
    `SELECT id
     FROM bulk_sms_campaigns
     WHERE status IN ('queued', 'sending')
       AND (scheduled_at IS NULL OR scheduled_at <= ?)
     ORDER BY scheduled_at ASC, id ASC`,
    [now],
  );

  for (const row of rows) {
    if ((await getCampaignStatus(row.id)) === 'cancelled') continue;
    await processBulkSmsCampaign(row.id);
  }
}

export async function processBulkSmsCampaign(campaignId) {
  if (processingCampaignIds.has(campaignId)) return;
  processingCampaignIds.add(campaignId);
  let locked = false;

  try {
    await ensureBulkSmsSchema();
    locked = await claimCampaignProcessLock(campaignId);
    if (!locked) return;

    const rows = await query(`SELECT * FROM bulk_sms_campaigns WHERE id = ? LIMIT 1`, [campaignId]);
    const campaign = rows[0];
    if (!campaign) return;

    const status = String(campaign.status || '').toLowerCase();
    if (!isCancellableStatus(status)) return;

    const now = nowSqlDateTime();
    if (campaign.scheduled_at && campaign.scheduled_at > now) return;

    if (status === 'queued') {
      await query(
        `UPDATE bulk_sms_campaigns
         SET status = 'sending', started_at = COALESCE(started_at, ?), updated_at = ?
         WHERE id = ? AND status = 'queued'`,
        [now, now, campaignId],
      );
      if ((await getCampaignStatus(campaignId)) === 'cancelled') return;
    }

    const segment = normalizeSegment(campaign.recipient_segment);
    const customNumbers = parseCustomNumbers(campaign.recipient_emails);
    const sentCount = Number(campaign.sent_count) || 0;
    const failedCount = Number(campaign.failed_count) || 0;
    const totalRecipients = Number(campaign.total_recipients) || 0;
    const processedCount = Number(campaign.processed_count) || sentCount + failedCount;

    if (processedCount >= totalRecipients || sentCount + failedCount >= totalRecipients) {
      await query(
        `UPDATE bulk_sms_campaigns
         SET status = 'sent', completed_at = ?, updated_at = ?
         WHERE id = ? AND status IN ('queued', 'sending')`,
        [now, now, campaignId],
      );
      return;
    }

    const recipients = await fetchRecipientBatch(segment, processedCount, BATCH_SIZE, customNumbers);
    if (!recipients.length) {
      await query(
        `UPDATE bulk_sms_campaigns
         SET status = 'sent', completed_at = ?, updated_at = ?
         WHERE id = ? AND status IN ('queued', 'sending')`,
        [now, now, campaignId],
      );
      return;
    }

    let batchSent = 0;
    let batchFailed = 0;
    let lookedAt = 0;
    let cancelled = false;
    const batchSeen = new Set();

    for (const recipient of recipients) {
      if ((await getCampaignStatus(campaignId)) === 'cancelled') {
        cancelled = true;
        break;
      }
      lookedAt += 1;

      const key = mobileKey(recipient.mobile_number);
      if (!key || batchSeen.has(key) || !(await claimCampaignMobile(campaignId, recipient.mobile_number))) {
        continue;
      }
      batchSeen.add(key);

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
    const nextProcessed = processedCount + lookedAt;

    if (cancelled || (await getCampaignStatus(campaignId)) === 'cancelled') {
      await query(
        `UPDATE bulk_sms_campaigns
         SET sent_count = ?, failed_count = ?, processed_count = ?, updated_at = ?
         WHERE id = ? AND status = 'cancelled'`,
        [nextSent, nextFailed, nextProcessed, nowSqlDateTime(), campaignId],
      );
      return;
    }

    const isComplete = nextProcessed >= totalRecipients || nextSent + nextFailed >= totalRecipients;
    await query(
      `UPDATE bulk_sms_campaigns
       SET sent_count = ?, failed_count = ?, processed_count = ?, status = ?, completed_at = ?, updated_at = ?
       WHERE id = ? AND status IN ('queued', 'sending')`,
      [
        nextSent,
        nextFailed,
        nextProcessed,
        isComplete ? 'sent' : 'sending',
        isComplete ? nowSqlDateTime() : null,
        nowSqlDateTime(),
        campaignId,
      ],
    );
  } finally {
    if (locked) {
      try {
        await releaseCampaignProcessLock(campaignId);
      } catch {
        // lock expires on its own if release fails
      }
    }
    processingCampaignIds.delete(campaignId);
  }
}

export async function cancelBulkSmsCampaign(id) {
  await ensureBulkSmsSchema();
  const rows = await query(`SELECT * FROM bulk_sms_campaigns WHERE id = ? LIMIT 1`, [id]);
  const campaign = rows[0];
  if (!campaign) {
    throw validationError('Campaign not found.', 404);
  }

  const status = String(campaign.status || '').toLowerCase();
  if (!isCancellableStatus(status)) {
    throw validationError('Only queued or sending campaigns can be cancelled.');
  }

  const now = nowSqlDateTime();
  await query(
    `UPDATE bulk_sms_campaigns
     SET status = 'cancelled', completed_at = ?, updated_at = ?
     WHERE id = ? AND status IN ('queued', 'sending')`,
    [now, now, id],
  );

  const updated = await query(`SELECT * FROM bulk_sms_campaigns WHERE id = ? LIMIT 1`, [id]);
  if (String(updated[0]?.status || '').toLowerCase() !== 'cancelled') {
    throw validationError('Campaign could not be cancelled.');
  }
  return { ok: true, campaign: mapCampaignRow(updated[0]) };
}

export async function resendBulkSmsCampaign(userId, id) {
  await ensureBulkSmsSchema();
  const rows = await query(`SELECT * FROM bulk_sms_campaigns WHERE id = ? LIMIT 1`, [id]);
  const campaign = rows[0];
  if (!campaign) {
    throw validationError('Campaign not found.', 404);
  }

  const status = String(campaign.status || '').toLowerCase();
  if (status === 'queued' || status === 'sending') {
    throw validationError('Wait for this campaign to finish, or cancel it, before resending.');
  }

  return createBulkSmsCampaign(userId, {
    recipientSegment: campaign.recipient_segment,
    numbers: campaign.recipient_emails,
    message: campaign.message,
  });
}

export async function deleteBulkSmsCampaign(id) {
  await ensureBulkSmsSchema();
  const rows = await query(`SELECT * FROM bulk_sms_campaigns WHERE id = ? LIMIT 1`, [id]);
  const campaign = rows[0];
  if (!campaign) {
    throw validationError('Campaign not found.', 404);
  }

  const status = String(campaign.status || '').toLowerCase();
  if (status === 'sending') {
    throw validationError('Cancel the campaign before deleting it.');
  }

  await query(`DELETE FROM bulk_sms_send_log WHERE campaign_id = ?`, [id]);
  await query(`DELETE FROM bulk_sms_campaigns WHERE id = ?`, [id]);
  return { ok: true };
}
