import { query } from '../config/database.js';
import { env } from '../config/env.js';
import { sendEmailAndSms } from './notification.service.js';
import { loyaltyCatalogNotifyEmailHtml } from './mail.templates.js';
import {
  getLevelIdFromThresholds,
  getMembershipTierThresholds,
} from './loyaltyMembershipTier.service.js';
import { fullyVerifiedAccountSql } from './accountHolder.service.js';

function parseNotifyFlag(value) {
  return value === true || value === 1 || value === '1' || String(value).toLowerCase() === 'true';
}

function normalizeAudienceType(value) {
  const normalized = String(value || 'both').trim().toLowerCase();
  if (normalized === 'standard') return 'normal';
  if (normalized === 'partner') return 'affiliate';
  if (['normal', 'affiliate', 'both'].includes(normalized)) return normalized;
  return 'both';
}

function normalizeTier(tiers) {
  if (!Array.isArray(tiers)) {
    const single = String(tiers || '').trim().toUpperCase();
    return single ? [single] : [];
  }
  return [...new Set(tiers.map((tier) => String(tier || '').trim().toUpperCase()).filter(Boolean))];
}

function resolveTierName(totalPoints, thresholds) {
  const levelId = getLevelIdFromThresholds(totalPoints, thresholds);
  const tier = thresholds.find((item) => Number(item.levelId) === Number(levelId));
  return String(tier?.name || 'Normal').toUpperCase();
}

async function listLoyaltyNotifyRecipients({ audienceType = 'both', tiers = [] } = {}) {
  const audience = normalizeAudienceType(audienceType);
  const allowedTiers = normalizeTier(tiers);
  if (!allowedTiers.length) return [];

  const params = [];
  let audienceSql = '';
  if (audience === 'normal') {
    audienceSql = `AND COALESCE(ah.is_patner, 'NO') != 'YES'`;
  } else if (audience === 'affiliate') {
    audienceSql = `AND ah.is_patner = 'YES'`;
  }

  const rows = await query(
    `SELECT
       ah.user_id,
       ah.email,
       ah.mobile_number,
       ah.first_name,
       COALESCE((
         SELECT SUM(pe.point_earning_amount)
         FROM point_earnings pe
         WHERE pe.user_id = ah.user_id
           AND pe.created_at > DATE_SUB(NOW(), INTERVAL 365 DAY)
       ), 0) AS total_points
     FROM account_holders ah
     WHERE COALESCE(ah.account_status, 'ACTIVE') != 'BANNED'
       AND ah.email IS NOT NULL
       AND TRIM(ah.email) != ''
       AND ${fullyVerifiedAccountSql('ah')}
       ${audienceSql}`,
    params,
  );

  const thresholds = await getMembershipTierThresholds();
  const allowed = new Set(allowedTiers);

  return rows.filter((row) => {
    const tierName = resolveTierName(Number(row.total_points) || 0, thresholds);
    return allowed.has(tierName);
  });
}

async function sendLoyaltyCatalogNotifications({
  recipients,
  subject,
  headline,
  intro,
  detailLines = [],
  smsMessage,
  smsType,
}) {
  if (!recipients.length) {
    console.info('[loyalty-notify] no matching recipients');
    return;
  }

  const dashboardUrl = `${env.userAppUrl}/dashboard/loyalty`;
  let successCount = 0;
  let failureCount = 0;

  for (const recipient of recipients) {
    try {
      await sendEmailAndSms({
        email: recipient.email,
        subject,
        html: loyaltyCatalogNotifyEmailHtml({
          firstName: recipient.first_name,
          headline,
          intro,
          detailLines,
          dashboardUrl,
        }),
        text: smsMessage,
        smsMessage,
        msisdn: recipient.mobile_number || null,
        userId: recipient.user_id || null,
        smsType,
      });
      successCount += 1;
    } catch (error) {
      failureCount += 1;
      console.error('[loyalty-notify] failed for', recipient.email, error.message);
    }
  }

  console.info('[loyalty-notify] complete', {
    smsType,
    successCount,
    failureCount,
    total: recipients.length,
  });
}

export function scheduleLoyaltyNotify(details) {
  if (!parseNotifyFlag(details?.notifyUsersByEmail ?? details?.notifyUsers)) return;

  void (async () => {
    const recipients = await listLoyaltyNotifyRecipients({
      audienceType: details.audienceType,
      tiers: details.tiers,
    });

    await sendLoyaltyCatalogNotifications({
      recipients,
      subject: details.subject,
      headline: details.headline,
      intro: details.intro,
      detailLines: details.detailLines || [],
      smsMessage: details.smsMessage,
      smsType: details.smsType || 'LOYALTY_CATALOG',
    });
  })().catch((error) => {
    console.error('[loyalty-notify]', error.message);
  });
}

export function scheduleGiftNotify({
  notifyUsersByEmail,
  title,
  audienceType,
  allowedLevels,
  isUpdate = false,
}) {
  const giftTitle = String(title || 'Gift').trim() || 'Gift';
  scheduleLoyaltyNotify({
    notifyUsersByEmail,
    audienceType,
    tiers: allowedLevels,
    subject: isUpdate
      ? `iTrustLD gift updated: ${giftTitle}`
      : `iTrustLD new gift available: ${giftTitle}`,
    headline: isUpdate ? 'Gift updated' : 'New gift available',
    intro: isUpdate
      ? `A loyalty gift matching your account has been updated: ${giftTitle}.`
      : `A new loyalty gift is available for your account: ${giftTitle}.`,
    detailLines: [`Gift: ${giftTitle}`],
    smsMessage: isUpdate
      ? `iTrustLD: Gift updated — ${giftTitle}. Check Loyalty gifts.`
      : `iTrustLD: New gift available — ${giftTitle}. Check Loyalty gifts.`,
    smsType: 'LOYALTY_GIFT',
  });
}

export function scheduleBonusNotify({
  notifyUsersByEmail,
  bonusAmount,
  isAffiliate,
  membershipTier,
  isUpdate = false,
}) {
  const tier = String(membershipTier || '').trim().toUpperCase();
  const amount = Number(bonusAmount);
  const amountLabel = Number.isFinite(amount) ? amount.toFixed(2) : String(bonusAmount ?? '');
  const audienceLabel = isAffiliate ? 'affiliate' : 'normal';

  scheduleLoyaltyNotify({
    notifyUsersByEmail,
    audienceType: isAffiliate ? 'affiliate' : 'normal',
    tiers: [tier],
    subject: isUpdate
      ? `iTrustLD ${tier} bonus updated`
      : `iTrustLD new ${tier} bonus available`,
    headline: isUpdate ? 'Bonus updated' : 'New bonus available',
    intro: isUpdate
      ? `Your ${tier} ${audienceLabel} loyalty bonus has been updated.`
      : `A new ${tier} ${audienceLabel} loyalty bonus is available.`,
    detailLines: [`Tier: ${tier}`, `Bonus amount: USD ${amountLabel}`],
    smsMessage: isUpdate
      ? `iTrustLD: ${tier} bonus updated to USD ${amountLabel}. Check Loyalty.`
      : `iTrustLD: New ${tier} bonus of USD ${amountLabel}. Check Loyalty.`,
    smsType: 'LOYALTY_BONUS',
  });
}

export function scheduleVoucherLevelNotify({
  notifyUsersByEmail,
  loyaltyLevel,
  clientBonusAmount,
  clientCount,
  isUpdate = false,
}) {
  const level = String(loyaltyLevel || '').trim().toUpperCase();
  const amount = Number(clientBonusAmount);
  const amountLabel = Number.isFinite(amount) ? amount.toFixed(2) : String(clientBonusAmount ?? '');
  const countLabel = String(clientCount ?? '');

  scheduleLoyaltyNotify({
    notifyUsersByEmail,
    audienceType: 'affiliate',
    tiers: [level],
    subject: isUpdate
      ? `iTrustLD ${level} voucher bonus updated`
      : `iTrustLD new ${level} voucher bonus available`,
    headline: isUpdate ? 'Voucher bonus updated' : 'New voucher bonus available',
    intro: isUpdate
      ? `Your ${level} client voucher bonus configuration has been updated.`
      : `A new ${level} client voucher bonus configuration is available.`,
    detailLines: [
      `Tier: ${level}`,
      `Client bonus: USD ${amountLabel}`,
      `Client count: ${countLabel}`,
    ],
    smsMessage: isUpdate
      ? `iTrustLD: ${level} voucher bonus updated — USD ${amountLabel} / ${countLabel} clients.`
      : `iTrustLD: New ${level} voucher bonus — USD ${amountLabel} / ${countLabel} clients.`,
    smsType: 'LOYALTY_VOUCHER',
  });
}
