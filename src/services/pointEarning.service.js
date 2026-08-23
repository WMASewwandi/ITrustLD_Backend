import { query } from '../config/database.js';
import { env } from '../config/env.js';
import { sendEmailAndSms } from './notification.service.js';
import { loyaltyLevelUpgradeEmailHtml } from './mail.templates.js';
import { ensurePointCollectionTierSchema } from './adminLoyaltyManagement.service.js';
import { resolveLevelId } from './loyaltyMembershipTier.service.js';

const LEVEL_LABELS = {
  1: 'NORMAL',
  2: 'SILVER',
  3: 'GOLD',
  4: 'DIAMOND',
  5: 'VIP',
  6: 'VVIP',
};

const LEVEL_DISPLAY_NAMES = {
  1: 'Normal',
  2: 'Silver',
  3: 'Gold',
  4: 'Diamond',
  5: 'VIP',
  6: 'VVIP',
};

const TIER_RANGES = {
  1: [0, 10000],
  2: [10000, 50000],
  3: [50000, 100000],
  4: [100000, 500000],
  5: [500000, 1000000],
};

export const SILVER_LEVEL_ID = 2;

export function isAffiliateLinkEligible(isPartner, levelId) {
  if (isPartner) return true;
  return (Number(levelId) || 1) >= SILVER_LEVEL_ID;
}

export function getLevelId(pointCount) {
  const points = Number(pointCount) || 0;
  if (points >= 1000000) return 6;
  if (points >= 500000) return 5;
  if (points >= 100000) return 4;
  if (points >= 50000) return 3;
  if (points >= 10000) return 2;
  return 1;
}

export function getLevelLabel(levelId) {
  return LEVEL_LABELS[levelId] || 'NORMAL';
}

export function getLevelDisplayName(levelId) {
  return LEVEL_DISPLAY_NAMES[levelId] || 'Normal';
}

export function getTierProgressPercentage(levelId, earnedForYear) {
  const level = Number(levelId) || 1;
  const earned = Number(earnedForYear) || 0;

  if (level >= 6) return 100;

  const [tierStart, tierEnd] = TIER_RANGES[level] || [0, 10000];
  const tierSpan = tierEnd - tierStart;
  if (tierSpan <= 0) return 100;

  return Math.min(100, Math.max(0, ((earned - tierStart) / tierSpan) * 100));
}

async function getUserYearlyPoints(userId) {
  const rows = await query(
    `SELECT COALESCE(SUM(point_earning_amount), 0) AS total
     FROM point_earnings
     WHERE user_id = ?
       AND created_at > DATE_SUB(NOW(), INTERVAL 365 DAY)`,
    [userId],
  );
  return Number(rows[0]?.total) || 0;
}

async function getLatestActivePointMultiplier(isAffiliate, membershipTier) {
  await ensurePointCollectionTierSchema();
  const affiliateFlag = isAffiliate ? 1 : 0;
  const tier = String(membershipTier || '').trim().toUpperCase();

  if (tier) {
    const tierRows = await query(
      `SELECT cal_amount
       FROM loyalty_management_point_collections
       WHERE is_active = 1
         AND is_affiliate = ?
         AND UPPER(membership_tier) = ?
         AND (is_deleted = 0 OR is_deleted IS NULL OR is_deleted = FALSE)
       ORDER BY id DESC
       LIMIT 1`,
      [affiliateFlag, tier],
    );
    if (tierRows[0]) {
      const amount = Number(tierRows[0].cal_amount);
      return Number.isFinite(amount) ? amount : 1;
    }
  }

  return 1;
}

async function getPointMultiplierForUser(userId, isAffiliate) {
  const yearlyPoints = await getUserYearlyPoints(userId);
  const tier = getLevelLabel(await resolveLevelId(yearlyPoints));
  return getLatestActivePointMultiplier(isAffiliate, tier);
}

async function hasPointEarning(depositId, category) {
  const rows = await query(
    `SELECT id
     FROM point_earnings
     WHERE deposit_id = ?
       AND earning_category = ?
     LIMIT 1`,
    [depositId, category],
  );
  return Boolean(rows[0]);
}

async function insertPointEarning({
  userId,
  depositId,
  depositAmount,
  points,
  multiplier,
  category,
}) {
  await query(
    `INSERT INTO point_earnings
      (user_id, deposit_id, deposit_amount, point_earning_amount, point_multiplier, earning_category, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())`,
    [userId, depositId, depositAmount, points, multiplier, category],
  );
}

async function findPartnerForClient(clientAccountHolderId) {
  const rows = await query(
    `SELECT ah.id AS account_holder_id, ah.user_id, ah.is_patner
     FROM partner_clients pc
     INNER JOIN account_holders ah ON ah.id = pc.partner_ah_id
     WHERE pc.client_ah_id = ?
     LIMIT 1`,
    [clientAccountHolderId],
  );
  return rows[0] || null;
}

async function loadAccountHolderForDeposit(deposit, accountHolder) {
  if (accountHolder?.id) return accountHolder;
  const rows = await query(
    `SELECT id, user_id, is_patner, email, mobile_number, first_name
     FROM account_holders
     WHERE user_id = ?
     LIMIT 1`,
    [deposit.user_id],
  );
  return rows[0] || null;
}

async function notifyLevelUpgrade(userId, levelId, loyaltyPoints) {
  if (![2, 3, 4, 5, 6].includes(levelId)) return;

  const rows = await query(
    `SELECT email, mobile_number, first_name
     FROM account_holders
     WHERE user_id = ?
     LIMIT 1`,
    [userId],
  );
  const account = rows[0];
  if (!account?.email) return;

  const levelName = getLevelDisplayName(levelId);
  const featureUrl = `${env.userAppUrl}/dashboard/loyalty`;
  const subject = `Congratulations! You've unlocked ${levelName} Trust Level!`;
  const smsMessage = `Congratulations! You've unlocked ${levelName} Trust Level by reaching ${Math.round(loyaltyPoints).toLocaleString()} Loyalty Points!`;

  // Never block the request path on SMTP/SMS latency.
  void sendEmailAndSms({
    email: account.email,
    subject,
    html: loyaltyLevelUpgradeEmailHtml({
      levelName,
      loyaltyPoints,
      featureUrl,
    }),
    text: smsMessage,
    smsMessage,
    msisdn: account.mobile_number,
    userId,
    smsType: 'LOYALTY_LEVEL_UPGRADE',
  }).catch((error) => {
    console.error('[loyalty-level-upgrade-notify]', error.message);
  });
}

export async function updateUserPointLevel(userId) {
  const [lastLevelRows, earnedRows] = await Promise.all([
    query(
      `SELECT id, point_level_id, event_type
       FROM point_level_customers
       WHERE user_id = ?
       ORDER BY id DESC
       LIMIT 1`,
      [userId],
    ),
    query(
      `SELECT COALESCE(SUM(point_earning_amount), 0) AS total
       FROM point_earnings
       WHERE user_id = ?
         AND created_at > DATE_SUB(NOW(), INTERVAL 365 DAY)`,
      [userId],
    ),
  ]);

  const pointLevelLast = lastLevelRows[0] || null;
  const pointCollectionDuringYear = Number(earnedRows[0]?.total || 0);
  const pointLevelIdNew = await resolveLevelId(pointCollectionDuringYear);

  const insertLevelRecord = async (eventType) => {
    await query(
      `INSERT INTO point_level_customers
        (user_id, point_level_label, point_level_id, event_type, created_at, updated_at)
       VALUES (?, ?, ?, ?, NOW(), NOW())`,
      [userId, getLevelLabel(pointLevelIdNew), pointLevelIdNew, eventType],
    );
  };

  if (pointLevelLast) {
    if (pointLevelLast.point_level_id < pointLevelIdNew) {
      await insertLevelRecord('PROMOTED');
      await notifyLevelUpgrade(userId, pointLevelIdNew, pointCollectionDuringYear);
    } else if (pointLevelLast.point_level_id === pointLevelIdNew) {
      if (pointLevelLast.event_type === 'NEUTRAL') {
        await query(`UPDATE point_level_customers SET updated_at = NOW() WHERE id = ?`, [
          pointLevelLast.id,
        ]);
      } else {
        await insertLevelRecord('NEUTRAL');
      }
    } else if (pointLevelLast.point_level_id > pointLevelIdNew) {
      await insertLevelRecord('DEMOTED');
    }
  } else if (pointLevelIdNew > 1) {
    await insertLevelRecord('PROMOTED');
    await notifyLevelUpgrade(userId, pointLevelIdNew, pointCollectionDuringYear);
  }

  return pointLevelIdNew;
}

export async function getUserPointLevel(userId) {
  const rows = await query(
    `SELECT point_level_id, point_level_label
     FROM point_level_customers
     WHERE user_id = ?
     ORDER BY id DESC
     LIMIT 1`,
    [userId],
  );
  return rows[0] || null;
}

/**
 * Award depositor, referral, and super-referral points when a deposit is completed.
 * Mirrors Laravel DepositManagementController complete flow.
 */
export async function awardDepositPoints(deposit, accountHolder = null) {
  try {
    const holder = await loadAccountHolderForDeposit(deposit, accountHolder);
    if (!holder) return;

    const depositAmount = Number(deposit.deposit_amount) || 0;
    const depositId = deposit.id;

    const depositorMultiplier = await getPointMultiplierForUser(holder.user_id, false);
    if (depositorMultiplier > 0) {
      const depositorExists = await hasPointEarning(depositId, 'Deposit');
      if (!depositorExists) {
        const clientPoints = depositAmount * depositorMultiplier;
        await insertPointEarning({
          userId: holder.user_id,
          depositId,
          depositAmount,
          points: clientPoints,
          multiplier: depositorMultiplier,
          category: 'Deposit',
        });
      }
    }

    const partner = await findPartnerForClient(holder.id);
    let directPartnerAccountHolderId = null;

    if (partner) {
      directPartnerAccountHolderId = partner.account_holder_id;
      const affiliateMultiplier = await getPointMultiplierForUser(partner.user_id, true);

      if (affiliateMultiplier > 0) {
        const referralExists = await hasPointEarning(depositId, 'Referral');
        if (!referralExists) {
          const affiliatePoints = depositAmount * affiliateMultiplier;
          const depositorIsPartner = holder.is_patner === 'YES';
          const referralPoints = depositorIsPartner ? affiliatePoints * 0.1 : affiliatePoints;
          const referralMultiplier = depositorIsPartner
            ? affiliateMultiplier * 0.1
            : affiliateMultiplier;

          await insertPointEarning({
            userId: partner.user_id,
            depositId,
            depositAmount,
            points: referralPoints,
            multiplier: referralMultiplier,
            category: 'Referral',
          });
        }
      }
    }

    if (directPartnerAccountHolderId) {
      const superPartner = await findPartnerForClient(directPartnerAccountHolderId);
      if (superPartner) {
        const affiliateMultiplier = await getPointMultiplierForUser(superPartner.user_id, true);
        if (affiliateMultiplier > 0) {
          const affiliatePoints = depositAmount * affiliateMultiplier;
          await insertPointEarning({
            userId: superPartner.user_id,
            depositId,
            depositAmount,
            points: affiliatePoints * 0.1,
            multiplier: affiliateMultiplier * 0.1,
            category: 'Referral',
          });
        }
      }
    }

    await updateUserPointLevel(holder.user_id);
  } catch (error) {
    console.error('[deposit-points]', error.message);
  }
}

/**
 * Reverse loyalty points awarded for a deposit when admin rejects it.
 * Deletes depositor and referral earnings for this deposit, then refreshes
 * each affected user's loyalty level.
 */
export async function reverseDepositPoints(deposit) {
  if (!deposit?.id) return;

  try {
    const earningRows = await query(
      `SELECT user_id
       FROM point_earnings
       WHERE deposit_id = ?`,
      [deposit.id],
    );
    if (!earningRows.length) return;

    const userIds = [
      ...new Set(earningRows.map((row) => Number(row.user_id)).filter(Boolean)),
    ];

    await query(`DELETE FROM point_earnings WHERE deposit_id = ?`, [deposit.id]);

    await Promise.all(userIds.map((userId) => updateUserPointLevel(userId)));
  } catch (error) {
    console.error('[deposit-points-reverse]', error.message);
  }
}
