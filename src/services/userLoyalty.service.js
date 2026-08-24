import { query } from '../config/database.js';
import { env } from '../config/env.js';
import {
  findAccountHolderByUserId,
  isAccountBanned,
  needsVerification,
} from './accountHolder.service.js';
import { sendEmailAndSms } from './notification.service.js';
import {
  loyaltyRedemptionApprovedEmailHtml,
  loyaltyRedemptionPendingEmailHtml,
  loyaltyRedemptionRejectedEmailHtml,
} from './mail.templates.js';
import {
  getLevelDisplayName,
  getLevelId,
  getLevelLabel,
  getTierProgressPercentage,
  getUserPointLevel,
  isAffiliateLinkEligible,
  updateUserPointLevel,
} from './pointEarning.service.js';
import {
  getMembershipTierThresholds,
  resolveLevelId,
} from './loyaltyMembershipTier.service.js';
import { ensureBonusTierSchema } from './adminLoyaltyManagement.service.js';
import { getClientBonusSummaryForUser } from './userVoucherClaims.service.js';
import { listAvailableGiftsForUser } from './userLoyaltyGifts.service.js';
import {
  logSystemUserAction,
  SYSTEM_USER_ACTIONS,
} from './systemUserActionLog.service.js';
import { assertCanUpdateRecordStatus } from './statusUpdateScope.service.js';
import {
  addColomboDays,
  formatTimestampSl,
  formatYmdColombo,
  getColomboDateParts,
  parseDbDateTime,
} from '../utils/slTime.js';

const PARTNER_TIER_THRESHOLDS = [
  { id: 'normal', name: 'Normal', levelPoints: 0, pointsPerLot: 20 },
  { id: 'silver', name: 'Silver', levelPoints: 10000, pointsPerLot: 40 },
  { id: 'gold', name: 'Gold', levelPoints: 50000, pointsPerLot: 60 },
  { id: 'diamond', name: 'Diamond', levelPoints: 100000, pointsPerLot: 70 },
  { id: 'vip', name: 'VIP', levelPoints: 500000, pointsPerLot: 80 },
  { id: 'vvip', name: 'VVIP', levelPoints: 1000000, pointsPerLot: 90 },
];

const POINT_DIVIDER = env.loyalty.pointDivider;
const MIN_POINTS = env.loyalty.minimumPoints;
const STANDARD_USD = env.loyalty.standardUsdPerBlock;
const PARTNER_USD = env.loyalty.partnerUsdPerBlock;
const STARTER_TX_ID = env.loyalty.starterWithdrawalTransactionId;
const STARTER_BONUS_TX_ID = env.loyalty.starterBonusTransactionId;

function validationError(message, status = 422) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function formatYmdHis(value) {
  const formatted = formatTimestampSl(value);
  if (!formatted) return '—';
  return formatted.slice(0, 16);
}

function formatYmd(value) {
  const date = value ? parseDbDateTime(value) : null;
  if (!date) return '';
  return formatYmdColombo(date);
}

function mapUserStatus(status) {
  if (status === 'Approved') return 'Completed';
  return status || 'Pending';
}

function mapAdminStatus(status) {
  if (status === 'Completed') return 'Approved';
  return status;
}

function displayTransactionId(rowId) {
  return String(STARTER_TX_ID + Number(rowId || 0));
}

async function assertLoyaltyAccess(userId) {
  const accountHolder = await findAccountHolderByUserId(userId);
  if (!accountHolder) {
    throw validationError('Account holder not found.', 404);
  }
  if (isAccountBanned(accountHolder)) {
    throw validationError('Your account has been banned. Please contact support.', 403);
  }
  if (needsVerification(accountHolder)) {
    const error = validationError('Complete account verification before using loyalty features.');
    error.code = 'VERIFICATION_REQUIRED';
    throw error;
  }
  return accountHolder;
}

async function getPointTotals(userId) {
  const [earnedRows, withdrawnRows] = await Promise.all([
    query(
      `SELECT COALESCE(SUM(point_earning_amount), 0) AS total
       FROM point_earnings
       WHERE user_id = ?`,
      [userId],
    ),
    query(
      `SELECT COALESCE(SUM(point_withdrawal_amount), 0) AS total
       FROM point_withdrawals
       WHERE user_id = ?
         AND (status IS NULL OR status != 'Rejected')`,
      [userId],
    ),
  ]);

  const earned = Number(earnedRows[0]?.total || 0);
  const withdrawn = Number(withdrawnRows[0]?.total || 0);

  return {
    earned,
    withdrawn,
    remaining: Math.floor(earned - withdrawn),
  };
}

async function getEarnedForYear(userId) {
  const rows = await query(
    `SELECT COALESCE(SUM(point_earning_amount), 0) AS total
     FROM point_earnings
     WHERE user_id = ?
       AND created_at >= DATE_SUB(NOW(), INTERVAL 1 YEAR)`,
    [userId],
  );
  return Number(rows[0]?.total || 0);
}

/** Points whose 1-year anniversary is today — they leave the rolling period today. */
async function getPointsDroppingToday(userId) {
  const rows = await query(
    `SELECT COALESCE(SUM(point_earning_amount), 0) AS total
     FROM point_earnings
     WHERE user_id = ?
       AND created_at >= DATE_SUB(CURDATE(), INTERVAL 1 YEAR)
       AND created_at <  DATE_ADD(DATE_SUB(CURDATE(), INTERVAL 1 YEAR), INTERVAL 1 DAY)`,
    [userId],
  );
  return Math.floor(Number(rows[0]?.total || 0));
}

function formatDisplayDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const d = String(date.getDate()).padStart(2, '0');
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const y = date.getFullYear();
  return `${d}/${m}/${y}`;
}

async function getPointsBreakdownForYear(userId) {
  const rows = await query(
    `SELECT earning_category, COALESCE(SUM(point_earning_amount), 0) AS total
     FROM point_earnings
     WHERE user_id = ?
       AND created_at >= DATE_SUB(NOW(), INTERVAL 1 YEAR)
     GROUP BY earning_category`,
    [userId],
  );

  const totals = { Deposit: 0, Referral: 0 };
  for (const row of rows) {
    totals[row.earning_category] = Number(row.total || 0);
  }

  return [
    { label: 'Deposit Points', points: totals.Deposit },
    { label: 'Referral Points', points: totals.Referral },
  ];
}

async function getConfiguredPartnerTiers() {
  const thresholds = await getMembershipTierThresholds();
  return PARTNER_TIER_THRESHOLDS.map((tier) => {
    const match = thresholds.find((item) => item.slug === tier.id);
    return match ? { ...tier, levelPoints: Number(match.points) || 0 } : tier;
  });
}

async function getPartnerLevelOverviewRows(userId, level, earnedForYear, tiers = PARTNER_TIER_THRESHOLDS) {
  const currentTier = tiers[Math.max(0, Math.min(tiers.length - 1, level - 1))] || tiers[0];
  const nextTier = tiers[level] || null;
  const currentPts = Math.floor(Number(earnedForYear) || 0);
  const tierEnd = nextTier ? nextTier.levelPoints : currentTier.levelPoints;

  const now = new Date();
  const periodStart = new Date(now);
  periodStart.setFullYear(periodStart.getFullYear() - 1);
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const evaluationPeriod = `${formatDisplayDate(periodStart)} – ${formatDisplayDate(now)}`;

  const changeRows = await query(
    `SELECT point_level_id, point_level_label, event_type, created_at
     FROM point_level_customers
     WHERE user_id = ?
       AND event_type IN ('PROMOTED', 'DEMOTED')
     ORDER BY id DESC
     LIMIT 10`,
    [userId],
  );

  const lastPromotion = changeRows.find((row) => row.event_type === 'PROMOTED');

  const currentRow = {
    from_level: currentTier.name,
    to_level: nextTier?.name || currentTier.name,
    start_date: formatDisplayDate(periodStart),
    monthly_review: formatDisplayDate(monthEnd),
    last_upgrade: lastPromotion ? formatDisplayDate(lastPromotion.created_at) : '—',
    progress: nextTier ? `${currentPts.toLocaleString()}/${tierEnd.toLocaleString()}` : `${currentPts.toLocaleString()}`,
    evaluation_period: evaluationPeriod,
    is_current: true,
  };

  const historyRows = changeRows.map((row) => {
    const levelId = Number(row.point_level_id) || 1;
    const toLevel = getLevelDisplayName(levelId);
    const fromLevel =
      row.event_type === 'PROMOTED'
        ? getLevelDisplayName(Math.max(1, levelId - 1))
        : getLevelDisplayName(Math.min(6, levelId + 1));
    const createdAt = row.created_at ? new Date(row.created_at) : null;
    const reviewDate = createdAt ? new Date(createdAt) : null;
    if (reviewDate) reviewDate.setMonth(reviewDate.getMonth() + 1);

    return {
      from_level: fromLevel,
      to_level: toLevel,
      start_date: formatDisplayDate(createdAt),
      monthly_review: formatDisplayDate(reviewDate),
      last_upgrade: row.event_type === 'PROMOTED' ? formatDisplayDate(createdAt) : '—',
      progress:
        row.event_type === 'PROMOTED'
          ? `Promoted to ${toLevel}`
          : `Demoted to ${toLevel}`,
      evaluation_period: evaluationPeriod,
      is_current: false,
    };
  });

  return [currentRow, ...historyRows];
}

function getTrackPositionPct(points, tiers = PARTNER_TIER_THRESHOLDS) {
  if (!tiers.length) return 0;
  const pts = Number(points) || 0;
  const last = tiers[tiers.length - 1];
  if (pts >= last.levelPoints) return 100;

  let segmentIndex = 0;
  for (let i = 0; i < tiers.length - 1; i += 1) {
    if (pts >= (tiers[i].levelPoints || 0)) segmentIndex = i;
  }
  const from = tiers[segmentIndex].levelPoints || 0;
  const to = tiers[segmentIndex + 1]?.levelPoints || from;
  const frac = to > from ? Math.min(1, Math.max(0, (pts - from) / (to - from))) : 1;
  return Math.min(100, ((segmentIndex + frac) / Math.max(tiers.length - 1, 1)) * 100);
}

function buildPartnerProgress(
  level,
  earnedForYear,
  levelOverviewRows,
  tiers = PARTNER_TIER_THRESHOLDS,
  todaysLeftPoints = 0,
) {
  const currentTier = tiers[Math.max(0, Math.min(tiers.length - 1, level - 1))] || tiers[0];
  const nextTier = tiers[level] || null;
  const currentPts = Number(earnedForYear) || 0;
  const tierStart = currentTier.levelPoints;
  const tierEnd = nextTier ? nextTier.levelPoints : currentTier.levelPoints;
  const remaining = nextTier ? Math.max(0, tierEnd - currentPts) : 0;
  const span = tierEnd - tierStart;
  const progressPct = nextTier
    ? Math.min(100, Math.max(0, span > 0 ? ((currentPts - tierStart) / span) * 100 : 100))
    : 100;

  const now = new Date();
  const periodStart = new Date(now);
  periodStart.setFullYear(periodStart.getFullYear() - 1);
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const daysLeft = Math.max(
    0,
    Math.ceil((monthEnd.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)),
  );

  const lastPromotion = levelOverviewRows.find(
    (row) => !row.is_current && String(row.progress || '').startsWith('Promoted'),
  );

  return {
    current_tier: currentTier.name,
    next_tier: nextTier?.name || null,
    period_points: currentPts,
    tier_target: tierEnd,
    tier_start: tierStart,
    points_to_next: remaining,
    progress_percentage: Math.round(progressPct),
    track_position_pct: Math.round(getTrackPositionPct(currentPts, tiers)),
    points_per_lot: currentTier.pointsPerLot,
    tiers: tiers.map((tier) => ({ ...tier })),
    level_overview: {
      rows: levelOverviewRows,
    },
    evaluation: {
      start_date: formatDisplayDate(periodStart),
      end_date: formatDisplayDate(now),
      period_label: `${formatDisplayDate(periodStart)} – ${formatDisplayDate(now)}`,
      monthly_review: formatDisplayDate(monthEnd),
      last_upgrade: lastPromotion?.last_upgrade || levelOverviewRows[0]?.last_upgrade || '—',
      days_left: daysLeft,
      todays_left_points: Math.floor(Number(todaysLeftPoints) || 0),
    },
  };
}

function buildRateLabel(isPartner) {
  const usd = isPartner ? PARTNER_USD : STANDARD_USD;
  return `($) ${POINT_DIVIDER.toLocaleString()} Trust Points = ${usd} USD`;
}

async function getLatestPointWithdrawalRate(paymentOptionName) {
  const rows = await query(
    `SELECT pwr.rate
     FROM point_withdrawal_rates pwr
     INNER JOIN payment_options po ON po.id = pwr.payment_option_id
     WHERE po.payment_option_name = ?
     ORDER BY pwr.applicable_date DESC, pwr.id DESC
     LIMIT 1`,
    [paymentOptionName],
  );
  return Number(rows[0]?.rate || 1);
}

async function accountExistsForUser(userId, accountType, accountId) {
  const type = String(accountType || '').trim().toUpperCase();
  const id = Number(accountId);
  if (!type || !Number.isInteger(id)) return false;

  const tableByType = {
    XM: 'user_xm_accounts',
    SKRILL: 'user_skrill_accounts',
    NETELLER: 'user_neteller_accounts',
    'PERFECT MONEY': 'user_perfect_money_accounts',
    'BANK TRANSFER': 'user_bank_accounts',
    'CARD PAYMENT': 'user_card_payment_accounts',
    CRYPTO: 'user_crypto_accounts',
  };

  const table = tableByType[type];
  if (!table) return false;

  const rows = await query(
    `SELECT id
     FROM ${table}
     WHERE user_id = ?
       AND id = ?
       AND (is_deleted = 0 OR is_deleted IS NULL OR is_deleted = FALSE)
     LIMIT 1`,
    [userId, id],
  );
  return Boolean(rows[0]);
}

function allocateAffiliateCode(length = 8) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < length; i += 1) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return code;
}

async function ensureAffiliateCode(userId, accountHolder) {
  if (accountHolder.affiliate_code) return accountHolder.affiliate_code;

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const code = allocateAffiliateCode();
    const rows = await query(
      `SELECT id FROM account_holders WHERE affiliate_code = ? LIMIT 1`,
      [code],
    );
    if (!rows[0]) {
      await query(
        `UPDATE account_holders SET affiliate_code = ?, updated_at = NOW() WHERE user_id = ?`,
        [code, userId],
      );
      return code;
    }
  }
  return null;
}

function resolveFilterDates(filterTemplate, fromDate, toDate) {
  const template = String(filterTemplate || '').trim().toUpperCase();
  const today = new Date();
  const end = formatYmd(today);

  if (template === 'LAST_7_DAYS' || template === 'WEEKLY') {
    const from = new Date(today);
    from.setDate(from.getDate() - 7);
    return { fromDate: formatYmd(from), toDate: end };
  }
  if (template === 'LAST_MONTH' || template === 'MONTHLY') {
    const from = new Date(today);
    from.setMonth(from.getMonth() - 1);
    return { fromDate: formatYmd(from), toDate: end };
  }

  return {
    fromDate: fromDate ? String(fromDate).slice(0, 10) : null,
    toDate: toDate ? String(toDate).slice(0, 10) : null,
  };
}

export async function getUserLoyaltySummary(userId) {
  const accountHolder = await assertLoyaltyAccess(userId);
  const isPartner = accountHolder.is_patner === 'YES';

  // Refresh level in the background so SMTP/SMS or writes never stall this GET.
  void updateUserPointLevel(userId).catch((error) => {
    console.error('[loyalty-summary-level-update]', error.message);
  });

  const [totals, earnedForYear, pointLevelDetails] = await Promise.all([
    getPointTotals(userId),
    getEarnedForYear(userId),
    getUserPointLevel(userId),
  ]);

  let level = 1;
  let percentage = 0;

  if (pointLevelDetails) {
    level = Number(pointLevelDetails.point_level_id) || 1;
    if (isPartner) {
      percentage = getTierProgressPercentage(level, earnedForYear);
    } else if (totals.remaining >= MIN_POINTS) {
      percentage = 100;
    } else {
      percentage = Math.round((totals.remaining / MIN_POINTS) * 100);
    }
  } else if (isPartner) {
    percentage = getTierProgressPercentage(1, earnedForYear);
  } else if (earnedForYear >= MIN_POINTS) {
    percentage = 100;
  } else {
    percentage = Math.round((earnedForYear / MIN_POINTS) * 100);
  }

  const usdPerBlock = isPartner ? PARTNER_USD : STANDARD_USD;
  const eligibleForAffiliate = isAffiliateLinkEligible(isPartner, level);
  const affiliateCode = eligibleForAffiliate
    ? await ensureAffiliateCode(userId, accountHolder)
    : null;

  const partnerProgressPromise = isPartner
    ? Promise.all([
        getPointsBreakdownForYear(userId),
        getConfiguredPartnerTiers(),
        getPointsDroppingToday(userId),
      ]).then(async ([pointsBreakdown, tiers, todaysLeftPoints]) => {
        const levelOverviewRows = await getPartnerLevelOverviewRows(
          userId,
          level,
          earnedForYear,
          tiers,
        );
        return {
          ...buildPartnerProgress(
            level,
            earnedForYear,
            levelOverviewRows,
            tiers,
            todaysLeftPoints,
          ),
          points_breakdown: pointsBreakdown,
        };
      })
    : Promise.resolve(null);

  const directClientCountPromise = isPartner
    ? query(
        `SELECT COUNT(*) AS total
         FROM partner_clients pc
         INNER JOIN account_holders a ON pc.client_ah_id = a.id
         WHERE pc.partner_ah_id = ? AND a.account_number IS NOT NULL`,
        [accountHolder.id],
      ).then((rows) => Number(rows[0]?.total || 0))
    : Promise.resolve(0);

  const [partnerProgress, bonusSummary, clientBonusSummary, directClientCount, giftsData] =
    await Promise.all([
      partnerProgressPromise,
      getBonusSummaryForUser(userId, isPartner, totals.remaining),
      getClientBonusSummaryForUser(userId, isPartner),
      directClientCountPromise,
      listAvailableGiftsForUser(userId).catch((error) => {
        console.error('[loyalty-summary-gifts]', error.message);
        return { gifts: [] };
      }),
    ]);

  const eligibleGiftCount = (giftsData.gifts || []).filter((gift) => gift.is_eligible).length;

  return {
    point_summary: {
      earned: totals.earned,
      withdrawn: totals.withdrawn,
      remaining: totals.remaining,
      earned_for_year: earnedForYear,
      level,
      level_label: getLevelDisplayName(level),
      percentage,
    },
    is_partner: isPartner,
    affiliate_code: affiliateCode,
    has_affiliate_link: eligibleForAffiliate && Boolean(affiliateCode),
    direct_client_count: directClientCount,
    partner_tier: getLevelDisplayName(level),
    partner_progress: partnerProgress,
    bonus_summary: bonusSummary,
    client_bonus_summary: clientBonusSummary,
    eligible_gift_count: eligibleGiftCount,
    rate_label: buildRateLabel(isPartner),
    usd_value_of_earned: Number(((totals.earned / POINT_DIVIDER) * usdPerBlock).toFixed(2)),
    minimum_points: MIN_POINTS,
    point_divider: POINT_DIVIDER,
    usd_per_block: usdPerBlock,
  };
}

export async function createUserLoyaltyWithdrawal(userId, payload = {}) {
  const accountHolder = await assertLoyaltyAccess(userId);
  const points = Number(payload.withdrawal_point_amount ?? payload.points);
  const accountId = payload.selected_account_id ?? payload.account_id;
  const accountType = String(
    payload.selected_account_type ?? payload.account_type ?? '',
  )
    .trim()
    .toUpperCase();

  if (!Number.isFinite(points) || points <= 0) {
    throw validationError('Withdrawal point amount is required.');
  }
  if (!accountId) {
    throw validationError('Receiving account is required.');
  }
  if (!accountType) {
    throw validationError('Payment option is required.');
  }

  const totals = await getPointTotals(userId);
  if (totals.remaining < MIN_POINTS) {
    throw validationError(
      `Minimum of ${MIN_POINTS.toLocaleString()} loyalty points required to make a withdrawal request.`,
    );
  }
  if (points < MIN_POINTS) {
    throw validationError(`Minimum of ${MIN_POINTS.toLocaleString()} points has to be withdrawn.`);
  }
  if (points > totals.remaining) {
    throw validationError(
      `You cannot withdraw an amount exceeding your existing point balance. Your point balance is ${totals.remaining}.`,
    );
  }

  const accountValid = await accountExistsForUser(userId, accountType, accountId);
  if (!accountValid) {
    throw validationError('Selected receiving account was not found.');
  }

  const rate = await getLatestPointWithdrawalRate(accountType);
  const isPartner = accountHolder.is_patner === 'YES';
  const usdPerBlock = isPartner ? PARTNER_USD : STANDARD_USD;
  const cashoutAmount = (points / POINT_DIVIDER) * usdPerBlock;
  const accountCurrencyAmount = cashoutAmount * rate;

  const insert = await query(
    `INSERT INTO point_withdrawals
      (user_id, point_withdrawal_amount, cashout_amount, account_currency_amount, point_divider,
       payment_option, account_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'Pending', NOW(), NOW())`,
    [
      userId,
      points,
      cashoutAmount,
      accountCurrencyAmount,
      POINT_DIVIDER,
      accountType,
      accountId,
    ],
  );

  const withdrawalId = insert.insertId;
  const transactionId = displayTransactionId(withdrawalId);

  const pointLevelDetails = await getUserPointLevel(userId);
  const levelId = Number(pointLevelDetails?.point_level_id) || 1;
  if (isAffiliateLinkEligible(isPartner, levelId)) {
    await ensureAffiliateCode(userId, accountHolder);
  }

  const updatedTotals = await getPointTotals(userId);

  return {
    ok: true,
    error: false,
    message:
      'Withdrawal request has been submitted successfully. This process may take up to 24 hours.',
    transaction_id: transactionId,
    remaining_points: updatedTotals.remaining,
    withdrawal: mapUserWithdrawalRow({
      id: withdrawalId,
      point_withdrawal_amount: points,
      cashout_amount: cashoutAmount,
      account_currency_amount: accountCurrencyAmount,
      payment_option: accountType,
      account_id: accountId,
      status: 'Pending',
      created_at: new Date(),
      updated_at: new Date(),
    }),
  };
}

function mapUserWithdrawalRow(row, accountDisplay = null) {
  const points = Number(row.point_withdrawal_amount || 0);
  const cashout = Number(row.cashout_amount || 0);
  const received = Number(row.account_currency_amount || 0);
  const paymentOption = String(row.payment_option || '').trim();
  const optionUpper = paymentOption.toUpperCase();
  const receivingCurrency =
    optionUpper === 'BANK TRANSFER' || optionUpper === 'CARD PAYMENT'
      ? 'LKR'
      : optionUpper === 'CRYPTO' || optionUpper.startsWith('CRYPTO')
        ? 'USDT'
        : 'USD';
  const datetime = formatYmdHis(row.created_at);
  const [datePart, timePart] = String(datetime).split(' ');

  return {
    id: displayTransactionId(row.id),
    withdrawal_id: row.id,
    type: 'Loyalty Cash-out',
    method: 'Point Withdrawal',
    points,
    points_display: points.toLocaleString(),
    amount: `USD ${cashout.toFixed(2)}`,
    cashout_amount: cashout,
    received_amount: received.toFixed(2),
    receiving_amount: `${receivingCurrency} ${received.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`,
    currency: 'USD',
    payment_option: paymentOption || '—',
    account_id: row.account_id,
    account: accountDisplay?.platformDetail || accountDisplay?.platformId || '—',
    account_platform: accountDisplay?.platform || paymentOption || '—',
    status: mapUserStatus(row.status),
    date: datePart || formatYmd(row.created_at),
    time: timePart || '',
    datetime,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function listUserLoyaltyWithdrawals(userId, params = {}) {
  await assertLoyaltyAccess(userId);

  const page = Math.max(1, Number(params.page) || 1);
  const perPage = Math.min(50, Math.max(1, Number(params.per_page) || 10));
  const offset = (page - 1) * perPage;
  const status = params.status && params.status !== 'All Statuses' ? mapAdminStatus(params.status) : null;
  const search = String(params.search ?? params.q ?? '').trim();
  const { fromDate, toDate } = resolveFilterDates(
    params.filter_template ?? params.filterTemplate,
    params.from_date ?? params.fromDate,
    params.to_date ?? params.toDate,
  );

  let sql = `SELECT *
             FROM point_withdrawals
             WHERE user_id = ?`;
  const values = [userId];

  if (status) {
    sql += ` AND status = ?`;
    values.push(status);
  }
  if (fromDate) {
    sql += ` AND DATE(created_at) >= ?`;
    values.push(fromDate);
  }
  if (toDate) {
    sql += ` AND DATE(created_at) <= ?`;
    values.push(toDate);
  }
  if (search) {
    const term = `%${search}%`;
    sql += ` AND (
      CAST(id AS CHAR) LIKE ? OR
      CAST(point_withdrawal_amount AS CHAR) LIKE ? OR
      CAST(cashout_amount AS CHAR) LIKE ? OR
      payment_option LIKE ? OR
      status LIKE ?
    )`;
    values.push(term, term, term, term, term);
  }

  const countRows = await query(`SELECT COUNT(*) AS total FROM (${sql}) AS loyalty_list`, values);
  const total = Number(countRows[0]?.total || 0);

  const rows = await query(`${sql} ORDER BY updated_at DESC LIMIT ? OFFSET ?`, [
    ...values,
    perPage,
    offset,
  ]);

  const transactions = await Promise.all(
    rows.map(async (row) => {
      const accountDisplay = await loadAccountDisplay(userId, row.payment_option, row.account_id);
      return mapUserWithdrawalRow(row, accountDisplay);
    }),
  );

  return {
    transactions,
    pagination: {
      page,
      per_page: perPage,
      total,
      total_pages: Math.max(1, Math.ceil(total / perPage)),
    },
  };
}

function buildAdminDateFilter(filter, fromDate, toDate) {
  const normalized = String(filter || '').trim().toLowerCase();
  const today = new Date();
  const end = formatYmdColombo(today);
  const parts = getColomboDateParts(today);

  switch (normalized) {
    case 'today':
      return { fromDate: end, toDate: end };
    case 'yesterday': {
      const day = formatYmdColombo(addColomboDays(today, -1));
      return { fromDate: day, toDate: day };
    }
    case 'last7days':
      return { fromDate: formatYmdColombo(addColomboDays(today, -7)), toDate: end };
    case 'lastmonth':
      return { fromDate: formatYmdColombo(addColomboDays(today, -30)), toDate: end };
    case 'last6months':
      return { fromDate: formatYmdColombo(addColomboDays(today, -180)), toDate: end };
    case 'currentyear':
      return { fromDate: `${parts.year}-01-01`, toDate: end };
    case 'lastyear':
      return {
        fromDate: `${parts.year - 1}-01-01`,
        toDate: `${parts.year - 1}-12-31`,
      };
    case 'customdate':
      return {
        fromDate: fromDate ? String(fromDate).slice(0, 10) : null,
        toDate: toDate ? String(toDate).slice(0, 10) : null,
      };
    default:
      return { fromDate: null, toDate: null };
  }
}

async function loadAccountDisplay(userId, paymentOption, accountId) {
  const type = String(paymentOption || '').trim().toUpperCase();
  const id = Number(accountId);
  if (!Number.isInteger(id)) {
    return { platform: '—', platformId: '—', platformName: null, platformDetail: '—' };
  }

  const queries = {
    XM: `SELECT xm_account_id AS value FROM user_xm_accounts WHERE user_id = ? AND id = ? LIMIT 1`,
    SKRILL: `SELECT skrill_email AS value FROM user_skrill_accounts WHERE user_id = ? AND id = ? LIMIT 1`,
    NETELLER: `SELECT neteller_email AS value FROM user_neteller_accounts WHERE user_id = ? AND id = ? LIMIT 1`,
    'PERFECT MONEY': `SELECT pm_account_id AS value FROM user_perfect_money_accounts WHERE user_id = ? AND id = ? LIMIT 1`,
    'BANK TRANSFER': `SELECT bank, account_number, beneficiary_name, branch FROM user_bank_accounts WHERE user_id = ? AND id = ? LIMIT 1`,
    'CARD PAYMENT': `SELECT bank, bank_account_number, beneficiary_name, branch FROM user_card_payment_accounts WHERE user_id = ? AND id = ? LIMIT 1`,
    CRYPTO: `SELECT crypto_account_id AS value FROM user_crypto_accounts WHERE user_id = ? AND id = ? LIMIT 1`,
  };

  const sql = queries[type];
  if (!sql) return { platform: type || '—', platformId: '—', platformName: null, platformDetail: '—' };

  const rows = await query(sql, [userId, id]);
  const row = rows[0];
  if (!row) return { platform: type || '—', platformId: '—', platformName: null, platformDetail: '—' };

  if (type === 'BANK TRANSFER' || type === 'CARD PAYMENT') {
    const accountNumber = row.account_number || row.bank_account_number;
    const beneficiaryName = row.beneficiary_name || '—';
    return {
      platform: row.bank || type,
      platformId: accountNumber || '—',
      platformName: beneficiaryName !== '—' ? beneficiaryName : null,
      platformDetail: `${accountNumber || '—'} · ${beneficiaryName}`,
    };
  }

  const accountValue = row.value || '—';
  return {
    platform: type,
    platformId: accountValue,
    platformName: null,
    platformDetail: accountValue,
  };
}

function mapAdminWithdrawalRow(row, accountDisplay) {
  const points = Number(row.point_withdrawal_amount || 0);
  const cashout = Number(row.cashout_amount || 0);
  const received = Number(row.account_currency_amount || 0);

  return {
    id: displayTransactionId(row.id),
    withdrawal_id: row.id,
    date: formatYmdHis(row.created_at),
    userId: row.account_number || `U-${row.user_id}`,
    customer: row.customer_name || '—',
    email: row.email || '—',
    points: points.toFixed(2),
    amount: `LKR ${received.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    amountUsd: `USD ${cashout.toFixed(2)}`,
    method: row.payment_option || '—',
    received: `LKR ${received.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    platform: accountDisplay.platform,
    platformId: accountDisplay.platformId,
    platformName: accountDisplay.platformName,
    platformDetail: accountDisplay.platformDetail,
    status: mapUserStatus(row.status),
    raw_status: row.status,
  };
}

export async function listLoyaltyOrdersForAdmin(params = {}) {
  const page = Math.max(1, Number(params.page) || 1);
  const perPage = Math.min(50, Math.max(1, Number(params.per_page) || 20));
  const offset = (page - 1) * perPage;
  const statusInput = params.status || 'Pending';
  const status = mapAdminStatus(statusInput);
  const keyword = String(params.keyword ?? params.q ?? '').trim();
  const { fromDate, toDate } = buildAdminDateFilter(
    params.filter ?? params.duration,
    params.from_date ?? params.fromDate,
    params.to_date ?? params.toDate,
  );

  let sql = `SELECT pw.*, ah.account_number, ah.first_name, ah.last_name, ah.email,
                    CONCAT(ah.first_name, ' ', ah.last_name) AS customer_name
             FROM point_withdrawals pw
             INNER JOIN account_holders ah ON ah.user_id = pw.user_id
             WHERE 1=1`;
  const values = [];

  if (status !== 'All') {
    sql += ` AND pw.status = ?`;
    values.push(status);
  }

  if (fromDate) {
    sql += ` AND DATE(pw.created_at) >= ?`;
    values.push(fromDate);
  }
  if (toDate) {
    sql += ` AND DATE(pw.created_at) <= ?`;
    values.push(toDate);
  }
  if (keyword) {
    const term = `%${keyword}%`;
    sql += ` AND (
      CAST(pw.id AS CHAR) LIKE ? OR
      ah.account_number LIKE ? OR
      ah.first_name LIKE ? OR
      ah.last_name LIKE ? OR
      ah.email LIKE ? OR
      pw.payment_option LIKE ?
    )`;
    values.push(term, term, term, term, term, term);
  }

  const countRows = await query(`SELECT COUNT(*) AS total FROM (${sql}) AS loyalty_orders`, values);
  const total = Number(countRows[0]?.total || 0);

  const rows = await query(`${sql} ORDER BY pw.created_at DESC LIMIT ? OFFSET ?`, [
    ...values,
    perPage,
    offset,
  ]);

  const orders = [];
  for (const row of rows) {
    const accountDisplay = await loadAccountDisplay(row.user_id, row.payment_option, row.account_id);
    orders.push(mapAdminWithdrawalRow(row, accountDisplay));
  }

  return {
    orders,
    pagination: {
      page,
      per_page: perPage,
      total,
      total_pages: Math.max(1, Math.ceil(total / perPage)),
    },
    starter_transaction_id: STARTER_TX_ID,
  };
}

export async function updateLoyaltyOrderStatus(adminUserId, payload = {}) {
  const transactionId = Number(payload.transaction_id ?? payload.transactionId);
  const nextStatus = mapAdminStatus(payload.withdrawal_request_status ?? payload.status);

  if (!Number.isInteger(transactionId)) {
    throw validationError('Transaction id is required.');
  }
  if (!['Pending', 'Approved', 'Rejected'].includes(nextStatus)) {
    throw validationError('Invalid loyalty order status.');
  }

  const withdrawalId = transactionId - STARTER_TX_ID;
  const rows = await query(`SELECT * FROM point_withdrawals WHERE id = ? LIMIT 1`, [withdrawalId]);
  const withdrawal = rows[0];
  if (!withdrawal) {
    throw validationError(`Invalid point withdrawal transaction id: ${transactionId}`);
  }

  const currentStatus = mapUserStatus(withdrawal.status);
  await assertCanUpdateRecordStatus(adminUserId, 'loyalty_order', currentStatus);

  if (nextStatus === 'Pending') {
    await query(
      `UPDATE point_withdrawals
       SET status = ?, pendings_by_admin = ?, updated_at = NOW()
       WHERE id = ?`,
      [nextStatus, adminUserId, withdrawalId],
    );
    await logSystemUserAction(adminUserId, SYSTEM_USER_ACTIONS.LOYALTY_ORDER_PENDING);
  } else if (nextStatus === 'Approved') {
    await query(
      `UPDATE point_withdrawals
       SET status = ?, approved_by_admin = ?, withdrawn_at = NOW(), updated_at = NOW()
       WHERE id = ?`,
      [nextStatus, adminUserId, withdrawalId],
    );
    await logSystemUserAction(adminUserId, SYSTEM_USER_ACTIONS.LOYALTY_ORDER_APPROVE);
  } else {
    await query(
      `UPDATE point_withdrawals
       SET status = ?, rejected_by_admin = ?, updated_at = NOW()
       WHERE id = ?`,
      [nextStatus, adminUserId, withdrawalId],
    );
    await logSystemUserAction(adminUserId, SYSTEM_USER_ACTIONS.LOYALTY_ORDER_REJECT);
  }

  return {
    ok: true,
    error: false,
    message: 'Successfully updated the point withdrawal request state',
    status: mapUserStatus(nextStatus),
  };
}

function mapBonusUserStatus(status) {
  if (status === 'Approved') return 'Claimed';
  return status || 'Pending';
}

function mapBonusAdminStatus(status) {
  if (status === 'Claimed' || status === 'Completed') return 'Approved';
  return status;
}

function displayBonusTransactionId(rowId) {
  return String(STARTER_BONUS_TX_ID + Number(rowId || 0));
}

function formatPaymentMethodLabel(paymentOption) {
  const key = String(paymentOption || '').trim().toUpperCase();
  const labels = {
    XM: 'XM',
    SKRILL: 'Skrill',
    NETELLER: 'Neteller',
    'PERFECT MONEY': 'Perfect Money',
    'BANK TRANSFER': 'Bank Transfer',
    'CARD PAYMENT': 'Card Payment',
    CRYPTO: 'Crypto',
  };
  return labels[key] || paymentOption || '—';
}

function formatBonusReceivedAmount(paymentOption, amount) {
  const value = Number(amount) || 0;
  const formatted = value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const key = String(paymentOption || '').trim().toUpperCase();
  if (key === 'CRYPTO') return `USDT ${formatted}`;
  if (key === 'BANK TRANSFER') return `LKR ${formatted}`;
  return `USD ${formatted}`;
}

async function fetchAdminNames(adminIds) {
  const ids = [...new Set(adminIds.filter(Boolean))];
  if (!ids.length) return {};
  const rows = await query(
    `SELECT id, name FROM users WHERE id IN (${ids.map(() => '?').join(', ')})`,
    ids,
  );
  return Object.fromEntries(rows.map((row) => [row.id, row.name]));
}

function resolveBonusAdminName(row, adminUsers) {
  const adminId = row.approved_by_admin || row.rejected_by_admin || row.pendings_by_admin;
  if (adminId && adminUsers[adminId]) return adminUsers[adminId];
  return '—';
}

function mapAdminBonusRow(row, accountDisplay, adminUsers) {
  const amount = Number(row.amount || 0);
  const method = formatPaymentMethodLabel(row.payment_option);

  return {
    id: displayBonusTransactionId(row.id),
    bonus_id: row.id,
    date: formatYmdHis(row.created_at),
    userId: row.account_number || `U-${row.user_id}`,
    customer: row.customer_name || '—',
    email: row.email || '—',
    amount: amount.toFixed(2),
    method,
    received: formatBonusReceivedAmount(row.payment_option, row.account_currency_amount),
    platformId: accountDisplay.platformId,
    platformName: accountDisplay.platformName,
    platform: accountDisplay.platform,
    platformDetail: accountDisplay.platformDetail,
    status: mapBonusUserStatus(row.status),
    raw_status: row.status,
    admin: resolveBonusAdminName(row, adminUsers),
  };
}

export async function listBonusClaimsForAdmin(params = {}) {
  const page = Math.max(1, Number(params.page) || 1);
  const perPage = Math.min(50, Math.max(1, Number(params.per_page) || 20));
  const offset = (page - 1) * perPage;
  const statusInput = params.status || 'Pending';
  const status = mapBonusAdminStatus(statusInput);
  const keyword = String(params.keyword ?? params.q ?? '').trim();
  const { fromDate, toDate } = buildAdminDateFilter(
    params.filter ?? params.duration,
    params.from_date ?? params.fromDate,
    params.to_date ?? params.toDate,
  );

  let sql = `SELECT lbc.*, ah.account_number, ah.first_name, ah.last_name, ah.email,
                    CONCAT(ah.first_name, ' ', ah.last_name) AS customer_name
             FROM loyalty_bonus_collects lbc
             INNER JOIN account_holders ah ON ah.user_id = lbc.user_id
             WHERE 1=1`;
  const values = [];

  if (status !== 'All') {
    sql += ` AND lbc.status = ?`;
    values.push(status);
  }

  if (fromDate) {
    sql += ` AND DATE(lbc.created_at) >= ?`;
    values.push(fromDate);
  }
  if (toDate) {
    sql += ` AND DATE(lbc.created_at) <= ?`;
    values.push(toDate);
  }
  if (keyword) {
    const term = `%${keyword}%`;
    sql += ` AND (
      CAST(lbc.id AS CHAR) LIKE ? OR
      ah.account_number LIKE ? OR
      ah.first_name LIKE ? OR
      ah.last_name LIKE ? OR
      ah.email LIKE ? OR
      lbc.payment_option LIKE ? OR
      CAST(lbc.amount AS CHAR) LIKE ?
    )`;
    values.push(term, term, term, term, term, term, term);
  }

  const countRows = await query(`SELECT COUNT(*) AS total FROM (${sql}) AS bonus_claims`, values);
  const total = Number(countRows[0]?.total || 0);

  const rows = await query(`${sql} ORDER BY lbc.created_at DESC LIMIT ? OFFSET ?`, [
    ...values,
    perPage,
    offset,
  ]);

  const adminIds = rows.flatMap((row) => [
    row.pendings_by_admin,
    row.approved_by_admin,
    row.rejected_by_admin,
  ]);
  const adminUsers = await fetchAdminNames(adminIds);

  const claims = [];
  for (const row of rows) {
    const accountDisplay = await loadAccountDisplay(row.user_id, row.payment_option, row.account_id);
    claims.push(mapAdminBonusRow(row, accountDisplay, adminUsers));
  }

  return {
    claims,
    pagination: {
      page,
      per_page: perPage,
      total,
      total_pages: Math.max(1, Math.ceil(total / perPage)),
    },
    starter_transaction_id: STARTER_BONUS_TX_ID,
  };
}

async function notifyBonusClaimStatus(userId, approved) {
  const rows = await query(
    `SELECT u.email, ah.mobile_number, ah.first_name
     FROM users u
     INNER JOIN account_holders ah ON ah.user_id = u.id
     WHERE u.id = ?
     LIMIT 1`,
    [userId],
  );
  const account = rows[0];
  if (!account?.email) return;

  const balanceUrl = `${env.userAppUrl}/dashboard/loyalty`;
  const subject = approved
    ? 'Loyalty point redemption approved'
    : 'Loyalty point redemption rejected';
  const smsMessage = approved
    ? 'Congratulations! Your loyalty points have been successfully redeemed.'
    : 'Your loyalty points redemption request has been rejected.';

  try {
    await sendEmailAndSms({
      email: account.email,
      subject,
      html: approved
        ? loyaltyRedemptionApprovedEmailHtml({ firstName: account.first_name, balanceUrl })
        : loyaltyRedemptionRejectedEmailHtml({ firstName: account.first_name, balanceUrl }),
      text: smsMessage,
      smsMessage,
      msisdn: account.mobile_number,
      userId,
      smsType: approved ? 'LOYALTY_REDEMPTION_APPROVED' : 'LOYALTY_REDEMPTION_REJECTED',
    });
  } catch (error) {
    console.error('[bonus-claim-notify]', error.message);
  }
}

export async function updateBonusClaimStatus(adminUserId, payload = {}) {
  const transactionId = Number(payload.transaction_id ?? payload.transactionId);
  const nextStatus = mapBonusAdminStatus(payload.bonus_request_status ?? payload.status);

  if (!Number.isInteger(transactionId)) {
    throw validationError('Transaction id is required.');
  }
  if (!['Pending', 'Approved', 'Rejected'].includes(nextStatus)) {
    throw validationError('Invalid bonus claim status.');
  }

  const bonusId = transactionId - STARTER_BONUS_TX_ID;
  const rows = await query(`SELECT * FROM loyalty_bonus_collects WHERE id = ? LIMIT 1`, [bonusId]);
  const bonusClaim = rows[0];
  if (!bonusClaim) {
    throw validationError(`Invalid bonus transaction id: ${transactionId}`);
  }

  const currentStatus = mapBonusUserStatus(bonusClaim.status);
  await assertCanUpdateRecordStatus(adminUserId, 'loyalty_bonus', currentStatus);

  if (nextStatus === 'Pending') {
    await query(
      `UPDATE loyalty_bonus_collects
       SET status = ?, pendings_by_admin = ?, updated_at = NOW()
       WHERE id = ?`,
      [nextStatus, adminUserId, bonusId],
    );
    await logSystemUserAction(adminUserId, SYSTEM_USER_ACTIONS.LOYALTY_BONUS_PENDING);
  } else if (nextStatus === 'Approved') {
    await query(
      `UPDATE loyalty_bonus_collects
       SET status = ?, approved_by_admin = ?, updated_at = NOW()
       WHERE id = ?`,
      [nextStatus, adminUserId, bonusId],
    );
    await logSystemUserAction(adminUserId, SYSTEM_USER_ACTIONS.LOYALTY_BONUS_APPROVE);
    await notifyBonusClaimStatus(bonusClaim.user_id, true);
  } else {
    await query(
      `UPDATE loyalty_bonus_collects
       SET status = ?, rejected_by_admin = ?, updated_at = NOW()
       WHERE id = ?`,
      [nextStatus, adminUserId, bonusId],
    );
    await logSystemUserAction(adminUserId, SYSTEM_USER_ACTIONS.LOYALTY_BONUS_REJECT);
    await notifyBonusClaimStatus(bonusClaim.user_id, false);
  }

  return {
    ok: true,
    error: false,
    message: 'Successfully updated the bonus request state',
    status: mapBonusUserStatus(nextStatus),
  };
}

const BONUS_MIN_POINTS_REMAINING = 200;

async function getLoyaltyManagementConfig(identifier) {
  const rows = await query(
    `SELECT id, identifier, is_active, date_activated
     FROM loyalty_management_configs
     WHERE identifier = ?
     LIMIT 1`,
    [identifier],
  );
  return rows[0] || null;
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

async function getActiveLoyaltyBonus(isAffiliate, userId) {
  await ensureBonusTierSchema();
  const yearlyPoints = await getUserYearlyPoints(userId);
  const tier = getLevelLabel(await resolveLevelId(yearlyPoints));
  const rows = await query(
    `SELECT id, bonus_amount, is_active, membership_tier
     FROM loyalty_management_bonuses
     WHERE is_active = 1
       AND is_affiliate = ?
       AND UPPER(membership_tier) = ?
       AND (is_deleted = 0 OR is_deleted IS NULL OR is_deleted = FALSE)
     ORDER BY id DESC
     LIMIT 1`,
    [isAffiliate ? 1 : 0, tier],
  );

  if (rows[0]) {
    const amount = Number(rows[0].bonus_amount);
    return {
      ...rows[0],
      bonus_amount: Number.isFinite(amount) ? amount : 1,
    };
  }

  return {
    id: 0,
    bonus_amount: 1,
    is_active: 1,
    membership_tier: tier,
  };
}

async function isBonusCollectAvailable(userId, isPartner, pointsRemaining) {
  const configIdentifier = isPartner ? 'BONUS-AFFILIATE' : 'BONUS';
  const masterConfig = await getLoyaltyManagementConfig(configIdentifier);
  if (!masterConfig?.is_active) {
    return { available: false, reason: 'Bonus program is not active.' };
  }

  const activeBonus = await getActiveLoyaltyBonus(isPartner, userId);
  if (!activeBonus) {
    return { available: false, reason: 'No active bonus offer at the moment.' };
  }

  if (Number(pointsRemaining) <= BONUS_MIN_POINTS_REMAINING) {
    return {
      available: false,
      reason: `You need more than ${BONUS_MIN_POINTS_REMAINING} Trust Points to claim a bonus.`,
    };
  }

  const lastRows = await query(
    `SELECT created_at
     FROM loyalty_bonus_collects
     WHERE user_id = ?
     ORDER BY id DESC
     LIMIT 1`,
    [userId],
  );
  const lastCollect = lastRows[0];
  if (!lastCollect) {
    return { available: true, bonus: activeBonus, bonusType: isPartner ? 'partner' : 'standard' };
  }

  const activatedAt = masterConfig.date_activated ? new Date(masterConfig.date_activated) : null;
  const lastCreatedAt = new Date(lastCollect.created_at);
  if (activatedAt && !Number.isNaN(activatedAt.getTime()) && lastCreatedAt < activatedAt) {
    return { available: true, bonus: activeBonus, bonusType: isPartner ? 'partner' : 'standard' };
  }

  return { available: false, reason: 'Bonus is not available at the moment.' };
}

export async function getBonusSummaryForUser(userId, isPartner, pointsRemaining) {
  const eligibility = await isBonusCollectAvailable(userId, isPartner, pointsRemaining);
  const rawAmount = Number(eligibility.bonus?.bonus_amount);
  const amount = eligibility.available
    ? Number.isFinite(rawAmount) && rawAmount > 0
      ? rawAmount
      : 1
    : Number.isFinite(rawAmount)
      ? rawAmount
      : 0;

  return {
    available: Boolean(eligibility.available),
    amount,
    amount_display: amount.toFixed(2),
    bonus_type: eligibility.bonusType || (isPartner ? 'partner' : 'standard'),
    reason: eligibility.reason || null,
    min_points_required: BONUS_MIN_POINTS_REMAINING + 1,
  };
}

async function notifyBonusClaimPending(userId) {
  const rows = await query(
    `SELECT u.email, ah.mobile_number, ah.first_name
     FROM users u
     INNER JOIN account_holders ah ON ah.user_id = u.id
     WHERE u.id = ?
     LIMIT 1`,
    [userId],
  );
  const account = rows[0];
  if (!account?.email) return;

  const balanceUrl = `${env.userAppUrl}/dashboard/loyalty`;
  const smsMessage = 'Your loyalty points redemption request is being reviewed.';

  try {
    await sendEmailAndSms({
      email: account.email,
      subject: 'Loyalty bonus claim submitted',
      html: loyaltyRedemptionPendingEmailHtml({
        firstName: account.first_name,
        balanceUrl,
      }),
      text: smsMessage,
      smsMessage,
      msisdn: account.mobile_number,
      userId,
      smsType: 'LOYALTY_REDEMPTION_PENDING',
    });
  } catch (error) {
    console.error('[bonus-claim-pending-notify]', error.message);
  }
}

export async function createUserBonusClaim(userId, payload = {}) {
  const accountHolder = await assertLoyaltyAccess(userId);
  const isPartner = accountHolder.is_patner === 'YES';
  const accountId = payload.selected_account_id ?? payload.account_id;
  const accountType = String(
    payload.selected_account_type ?? payload.payment_option ?? payload.account_type ?? '',
  )
    .trim()
    .toUpperCase();

  if (!accountId) {
    throw validationError('Receiving account is required.');
  }
  if (!accountType) {
    throw validationError('Payment option is required.');
  }

  const totals = await getPointTotals(userId);
  const eligibility = await isBonusCollectAvailable(userId, isPartner, totals.remaining);
  if (!eligibility.available || !eligibility.bonus) {
    throw validationError(
      eligibility.reason ||
        (isPartner ? 'No partner bonus available at the moment.' : 'Bonuses are not available at the moment.'),
    );
  }

  const accountValid = await accountExistsForUser(userId, accountType, accountId);
  if (!accountValid) {
    throw validationError('Selected receiving account was not found.');
  }

  const rate = await getLatestPointWithdrawalRate(accountType);
  const bonusAmount = Number(eligibility.bonus.bonus_amount);
  const resolvedBonusAmount = Number.isFinite(bonusAmount) && bonusAmount > 0 ? bonusAmount : 1;
  const accountCurrencyAmount = resolvedBonusAmount * rate;

  const insert = await query(
    `INSERT INTO loyalty_bonus_collects
      (user_id, loyalty_management_bonus_id, amount, account_currency_amount, payment_option, account_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'Pending', NOW(), NOW())`,
    [
      userId,
      eligibility.bonus.id || 0,
      resolvedBonusAmount,
      accountCurrencyAmount,
      accountType,
      accountId,
    ],
  );

  await notifyBonusClaimPending(userId);

  const claimId = insert.insertId;
  return {
    ok: true,
    error: false,
    message: isPartner
      ? 'Successfully redeemed your affiliate bonus'
      : 'Successfully redeemed your bonus',
    amount: resolvedBonusAmount,
    transaction_id: displayBonusTransactionId(claimId),
    claim: mapUserBonusClaimRow({
      id: claimId,
      amount: resolvedBonusAmount,
      account_currency_amount: accountCurrencyAmount,
      payment_option: accountType,
      status: 'Pending',
      created_at: new Date(),
    }),
  };
}

function mapUserBonusClaimRow(row) {
  const amount = Number(row.amount || 0);
  return {
    id: displayBonusTransactionId(row.id),
    claim_id: row.id,
    date: formatYmdHis(row.created_at),
    amount: amount.toFixed(2),
    method: formatPaymentMethodLabel(row.payment_option),
    received: formatBonusReceivedAmount(row.payment_option, row.account_currency_amount),
    status: mapBonusUserStatus(row.status),
    raw_status: row.status,
  };
}

export async function listUserBonusClaims(userId, params = {}) {
  await assertLoyaltyAccess(userId);

  const page = Math.max(1, Number(params.page) || 1);
  const perPage = Math.min(50, Math.max(1, Number(params.per_page) || 20));
  const offset = (page - 1) * perPage;
  const statusInput = params.status && params.status !== 'All Statuses' ? params.status : null;
  const status = statusInput ? mapBonusAdminStatus(statusInput) : null;
  const search = String(params.search ?? params.keyword ?? '').trim();
  const { fromDate, toDate } = resolveFilterDates(
    params.filter,
    params.from_date ?? params.fromDate,
    params.to_date ?? params.toDate,
  );

  let sql = `SELECT * FROM loyalty_bonus_collects WHERE user_id = ?`;
  const values = [userId];

  if (status && status !== 'All') {
    sql += ` AND status = ?`;
    values.push(status);
  }
  if (fromDate) {
    sql += ` AND DATE(created_at) >= ?`;
    values.push(fromDate);
  }
  if (toDate) {
    sql += ` AND DATE(created_at) <= ?`;
    values.push(toDate);
  }
  if (search) {
    const term = `%${search}%`;
    sql += ` AND (
      CAST(id AS CHAR) LIKE ? OR
      CAST(amount AS CHAR) LIKE ? OR
      payment_option LIKE ? OR
      status LIKE ?
    )`;
    values.push(term, term, term, term);
  }

  const countRows = await query(`SELECT COUNT(*) AS total FROM (${sql}) AS user_bonus_claims`, values);
  const total = Number(countRows[0]?.total || 0);

  const rows = await query(`${sql} ORDER BY created_at DESC LIMIT ? OFFSET ?`, [
    ...values,
    perPage,
    offset,
  ]);

  return {
    claims: rows.map(mapUserBonusClaimRow),
    pagination: {
      page,
      per_page: perPage,
      total,
      total_pages: Math.max(1, Math.ceil(total / perPage)),
    },
  };
}
