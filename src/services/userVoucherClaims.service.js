import { query } from '../config/database.js';
import { env } from '../config/env.js';
import {
  findAccountHolderByUserId,
  isAccountBanned,
  needsVerification,
} from './accountHolder.service.js';
import { clientBonusVoucherEmailHtml } from './mail.templates.js';
import { sendEmailAndSms } from './notification.service.js';
import { getUserPointLevel } from './pointEarning.service.js';
import { ensureTopupWalletVoucherFlagSchema } from './wallet.service.js';
import { bumpAdminNavCounts } from './adminNavCountsRevision.service.js';
import {
  SL_TIMEZONE,
  addColomboDays,
  formatTimestampSl,
  nowSqlDateTime,
  parseDbDateTime,
} from '../utils/slTime.js';

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

/**
 * Each partner level reads its own client bonus configuration. Diamond, VIP and
 * VVIP used to share the Diamond row, which meant the VIP/VVIP amounts admins
 * configured were never applied.
 */
const VOUCHER_TIERS = [
  { key: 'silver', label: 'Silver', pointLevelId: 2, configId: 'SILVER-BONUS', loyaltyLevel: 'SILVER' },
  { key: 'gold', label: 'Gold', pointLevelId: 3, configId: 'GOLD-BONUS', loyaltyLevel: 'GOLD' },
  { key: 'diamond', label: 'Diamond', pointLevelId: 4, configId: 'DIAMOND-BONUS', loyaltyLevel: 'DIAMOND' },
  { key: 'vip', label: 'VIP', pointLevelId: 5, configId: 'VIP-BONUS', loyaltyLevel: 'VIP' },
  { key: 'vvip', label: 'VVIP', pointLevelId: 6, configId: 'VVIP-BONUS', loyaltyLevel: 'VVIP' },
];

function voucherTierForPointLevel(levelId) {
  const level = Number(levelId) || 1;
  return VOUCHER_TIERS.find((tier) => tier.pointLevelId === level) || null;
}

const VOUCHER_VALIDITY_DAYS = 30;

function getVoucherExpiresAt(createdAt) {
  const created = parseDbDateTime(createdAt);
  if (!created) return null;
  return addColomboDays(created, VOUCHER_VALIDITY_DAYS);
}

function isAutoRejected(row) {
  if (Number(row.is_claimed) === 1 || row.rejection_reason) return false;
  const created = parseDbDateTime(row.created_at);
  if (!created) return false;
  const days = (Date.now() - created.getTime()) / (1000 * 60 * 60 * 24);
  return days >= VOUCHER_VALIDITY_DAYS;
}

function mapVoucherStatus(row) {
  if (Number(row.is_claimed) === 1) return 'Claimed';
  if (row.rejection_reason) return 'Rejected';
  if (isAutoRejected(row)) return 'Rejected';
  return 'Pending';
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

async function fetchMasterConfig(identifier) {
  const rows = await query(
    `SELECT identifier, is_active
     FROM loyalty_management_configs
     WHERE identifier = ?
     LIMIT 1`,
    [identifier],
  );
  return rows[0] || null;
}

async function getActiveLevelData(loyaltyLevel) {
  const rows = await query(
    `SELECT id, client_bonus_amount, client_count, is_active, loyalty_level
     FROM loyalty_management_levels
     WHERE is_active = 1
       AND loyalty_level = ?
       AND (is_deleted = 0 OR is_deleted IS NULL OR is_deleted = FALSE)
     ORDER BY display_id DESC
     LIMIT 1`,
    [loyaltyLevel],
  );
  return rows[0] || null;
}

async function getIssuedVoucherCount(userId, lmcbId) {
  const rows = await query(
    `SELECT COUNT(*) AS total
     FROM loyalty_client_bonus_vouchers
     WHERE loyalty_management_client_bonus_id = ?
       AND user_id = ?
       AND (rejection_reason IS NULL OR rejection_reason = '')`,
    [lmcbId, userId],
  );
  return Number(rows[0]?.total || 0);
}

function buildTierSummary(available, loyaltyLevel, issuedCount, tier) {
  const clientCount = Number(loyaltyLevel?.client_count) || 0;
  const bonusAmount = Number(loyaltyLevel?.client_bonus_amount) || 0;
  const remaining = loyaltyLevel ? Math.max(0, clientCount - issuedCount) : 0;
  const amountPerClient = clientCount > 0 ? bonusAmount / clientCount : 0;

  return {
    available: Boolean(available && remaining > 0),
    remaining: available ? remaining : 0,
    issued: issuedCount,
    total_slots: clientCount,
    total_pool: Number(bonusAmount.toFixed(2)),
    amount_per_client: Number(amountPerClient.toFixed(2)),
    loyalty_level_id: loyaltyLevel?.id || null,
    tier: tier?.key || null,
    label: tier?.label || null,
  };
}

async function getLastPromotionForUser(userId) {
  const rows = await query(
    `SELECT point_level_id, point_level_label, event_type, created_at
     FROM point_level_customers
     WHERE user_id = ?
       AND event_type = 'PROMOTED'
     ORDER BY id DESC
     LIMIT 1`,
    [userId],
  );
  return rows[0] || null;
}

function tierKeyForPointLevel(levelId) {
  return voucherTierForPointLevel(levelId)?.key || null;
}

export async function getClientBonusSummaryForUser(userId, isPartner) {
  const emptyTier = {
    available: false,
    remaining: 0,
    issued: 0,
    total_slots: 0,
    total_pool: 0,
    amount_per_client: 0,
    loyalty_level_id: null,
    tier: null,
    label: null,
  };

  if (!isPartner) {
    const summaries = Object.fromEntries(VOUCHER_TIERS.map((tier) => [tier.key, emptyTier]));
    return {
      can_issue: false,
      remaining_slots: 0,
      amount_per_client: 0,
      tier: null,
      loyalty_management_client_bonus_id: null,
      new_tier_bonus: null,
      ...summaries,
    };
  }

  const [pointLevel, lastPromotion, tierData] = await Promise.all([
    getUserPointLevel(userId),
    getLastPromotionForUser(userId),
    Promise.all(
      VOUCHER_TIERS.map(async (tier) => {
        const [master, levelRow] = await Promise.all([
          fetchMasterConfig(tier.configId),
          getActiveLevelData(tier.loyaltyLevel),
        ]);
        const issued = levelRow ? await getIssuedVoucherCount(userId, levelRow.id) : 0;
        return { tier, master, levelRow, issued };
      }),
    ),
  ]);

  const level = Number(pointLevel?.point_level_id) || 1;
  const summaries = {};
  let activeTier = null;
  let activeSummary = null;

  for (const { tier, master, levelRow, issued } of tierData) {
    const eligible =
      Boolean(master?.is_active) && Boolean(levelRow?.is_active) && level === tier.pointLevelId;
    const summary = buildTierSummary(
      eligible && issued < Number(levelRow?.client_count || 0),
      levelRow,
      issued,
      tier,
    );
    summaries[tier.key] = summary;

    if (level === tier.pointLevelId && summary.available) {
      activeTier = tier.key;
      activeSummary = summary;
    }
  }

  // Newly unlocked tier bonus: promoted into this voucher tier and still has unused slots.
  // Shown separately from Claim My Bonus / older-tier issued vouchers.
  let newTierBonus = null;
  const promotedTierKey = tierKeyForPointLevel(lastPromotion?.point_level_id);
  if (
    activeSummary?.available &&
    activeTier &&
    promotedTierKey === activeTier &&
    Number(activeSummary.issued || 0) < Number(activeSummary.total_slots || 0)
  ) {
    const promotedAt = lastPromotion?.created_at
      ? parseDbDateTime(lastPromotion.created_at)
      : null;
    const neverIssuedForTier = Number(activeSummary.issued || 0) === 0;
    const recentlyPromoted =
      promotedAt &&
      !Number.isNaN(promotedAt.getTime()) &&
      Date.now() - promotedAt.getTime() <= VOUCHER_VALIDITY_DAYS * 24 * 60 * 60 * 1000;

    if (neverIssuedForTier || recentlyPromoted) {
      newTierBonus = {
        tier: activeTier,
        label: activeSummary.label,
        remaining: activeSummary.remaining,
        total_slots: activeSummary.total_slots,
        issued: activeSummary.issued,
        amount_per_client: activeSummary.amount_per_client,
        total_pool: activeSummary.total_pool,
        loyalty_management_client_bonus_id: activeSummary.loyalty_level_id,
        unlocked_at: promotedAt ? formatYmdHis(promotedAt) : null,
        is_new: true,
        headline: `New ${activeSummary.label} Client Bonus`,
        message: `You unlocked ${activeSummary.remaining} voucher slot${
          activeSummary.remaining === 1 ? '' : 's'
        } (USD ${Number(activeSummary.amount_per_client).toFixed(2)} each) with your ${
          activeSummary.label
        } upgrade.`,
      };
    }
  }

  return {
    can_issue: Boolean(activeSummary?.available),
    remaining_slots: activeSummary?.remaining || 0,
    amount_per_client: activeSummary?.amount_per_client || 0,
    tier: activeTier,
    loyalty_management_client_bonus_id: activeSummary?.loyalty_level_id || null,
    new_tier_bonus: newTierBonus,
    ...summaries,
  };
}

function mapUserVoucherRow(row) {
  const amount = Number(row.amount || 0);
  const method = row.topup_method_name || '—';
  const status = mapVoucherStatus(row);
  const token = row.voucher_token || '';
  const expiresAt = getVoucherExpiresAt(row.created_at);
  const validUntilLabel = expiresAt
    ? expiresAt.toLocaleDateString('en-US', {
        timeZone: SL_TIMEZONE,
        month: 'long',
        day: 'numeric',
        year: 'numeric',
      })
    : null;

  const tierRaw = String(row.loyalty_level || '').trim().toLowerCase();
  const tierMeta = VOUCHER_TIERS.find((entry) => entry.key === tierRaw) || null;
  const tier = tierMeta?.key || null;

  return {
    id: String(row.id),
    voucher_id: row.id,
    token,
    platform_id: row.platform_id || '—',
    amount: amount.toFixed(2),
    amount_display: `USD ${amount.toFixed(2)}`,
    topup_method: method,
    method,
    status,
    is_claimed: Number(row.is_claimed) === 1,
    created_at: formatYmdHis(row.created_at),
    expires_at: expiresAt ? expiresAt.toISOString() : null,
    valid_until: validUntilLabel,
    validity_days: VOUCHER_VALIDITY_DAYS,
    tier,
    tier_label: tierMeta?.label || null,
    loyalty_management_client_bonus_id: row.loyalty_management_client_bonus_id || null,
    voucher_url: token ? `${env.userAppUrl}/dashboard/earnings/vouchers/${token}` : null,
    rejectReason:
      row.rejection_reason || (isAutoRejected(row) ? 'Auto-rejected: Voucher expired after 30 days' : null),
    rejection_reason:
      row.rejection_reason || (isAutoRejected(row) ? 'Auto-rejected: Voucher expired after 30 days' : ''),
  };
}

export async function listUserVoucherClaims(userId, params = {}) {
  await assertLoyaltyAccess(userId);

  const page = Math.max(1, Number(params.page) || 1);
  const perPage = Math.min(50, Math.max(1, Number(params.per_page) || 20));
  const offset = (page - 1) * perPage;

  const countRows = await query(
    `SELECT COUNT(*) AS total
     FROM loyalty_client_bonus_vouchers
     WHERE user_id = ?`,
    [userId],
  );
  const total = Number(countRows[0]?.total || 0);

  const rows = await query(
    `SELECT v.*, tm.topup_method_name, lml.loyalty_level
     FROM loyalty_client_bonus_vouchers v
     LEFT JOIN topup_methods tm ON tm.id = v.topup_method_id
     LEFT JOIN loyalty_management_levels lml ON lml.id = v.loyalty_management_client_bonus_id
     WHERE v.user_id = ?
     ORDER BY v.created_at DESC
     LIMIT ? OFFSET ?`,
    [userId, perPage, offset],
  );

  return {
    vouchers: rows.map(mapUserVoucherRow),
    pagination: {
      page,
      per_page: perPage,
      total,
      total_pages: Math.max(1, Math.ceil(total / perPage)),
    },
  };
}

async function generateVoucherToken() {
  let token = `${Math.floor(Date.now() / 1000)}${Math.floor(Math.random() * 10)}${Math.floor(Math.random() * 10)}${Math.floor(Math.random() * 10)}${Math.floor(Math.random() * 10)}`;

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const rows = await query(
      `SELECT id FROM loyalty_client_bonus_vouchers WHERE voucher_token = ? LIMIT 1`,
      [token],
    );
    if (!rows[0]) return token;
    token = `${Math.floor(Date.now() / 1000)}${Math.floor(Math.random() * 10)}${Math.floor(Math.random() * 10)}${Math.floor(Math.random() * 10)}${Math.floor(Math.random() * 10)}`;
  }

  throw validationError('Unable to generate a unique voucher token. Please try again.', 500);
}

async function resolveClientBonusAmount(userId, isPartner) {
  const summary = await getClientBonusSummaryForUser(userId, isPartner);
  if (!summary.can_issue || !summary.loyalty_management_client_bonus_id) {
    return { amount: 0, loyaltyLevelId: null, summary };
  }

  return {
    amount: summary.amount_per_client,
    loyaltyLevelId: summary.loyalty_management_client_bonus_id,
    summary,
  };
}

async function notifyClientBonusVoucherIssued({ userId, platformId, amount, firstName, email, mobileNumber }) {
  if (!email) return;

  const validUntil = addColomboDays(new Date(), VOUCHER_VALIDITY_DAYS);
  const validUntilLabel = validUntil.toLocaleDateString('en-US', {
    timeZone: SL_TIMEZONE,
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  const voucherUrl = `${env.userAppUrl}/dashboard/earnings`;
  const smsMessage = 'Your client bonus voucher has been issued! Login to iTrustLD to redeem it.';

  try {
    await sendEmailAndSms({
      email,
      subject: 'Client Bonus Voucher',
      html: clientBonusVoucherEmailHtml({
        firstName,
        platformId,
        validUntil: validUntilLabel,
        amount,
        voucherUrl,
      }),
      text: smsMessage,
      smsMessage,
      msisdn: mobileNumber,
      userId,
      smsType: 'CLIENT_VOUCHER_ISSUED',
    });
  } catch (error) {
    console.error('[client-bonus-voucher-notify]', error.message);
  }
}

export async function createUserClientBonusVoucher(userId, payload = {}) {
  const accountHolder = await assertLoyaltyAccess(userId);
  const isPartner = accountHolder.is_patner === 'YES';
  if (!isPartner) {
    throw validationError('Sorry! You are not eligible to claim a client bonus.');
  }

  const topupMethodId = Number(payload.topup_method_id ?? payload.topupMethodId);
  const platformId = String(payload.platform_id ?? payload.platformId ?? '').trim();

  if (!Number.isFinite(topupMethodId) || topupMethodId <= 0) {
    throw validationError('Topup method is required.');
  }
  if (!platformId) {
    throw validationError('Platform ID is required.');
  }
  if (!/^\d{7,9}$/.test(platformId)) {
    throw validationError('Platform ID must be 7–9 digits.');
  }

  await ensureTopupWalletVoucherFlagSchema();

  const topupRows = await query(
    `SELECT id, topup_method_name
     FROM topup_methods
     WHERE id = ?
       AND UPPER(availability) = 'AVAILABLE'
       AND (is_deleted = 0 OR is_deleted IS NULL)
       AND allow_for_voucher = 1
     LIMIT 1`,
    [topupMethodId],
  );
  if (!topupRows[0]) {
    throw validationError('Selected topup method is not allowed for vouchers.');
  }

  // Platform ID is globally unique for 30 days across all customers.
  const recentPlatformRows = await query(
    `SELECT id, user_id, created_at
     FROM loyalty_client_bonus_vouchers
     WHERE platform_id = ?
       AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
       AND (rejection_reason IS NULL OR rejection_reason = '')
     ORDER BY created_at DESC
     LIMIT 1`,
    [platformId, VOUCHER_VALIDITY_DAYS],
  );
  if (recentPlatformRows[0]) {
    throw validationError(
      'This Platform ID was already used for a client bonus voucher in the last 30 days. Please use a different Platform ID.',
    );
  }

  const { amount, loyaltyLevelId } = await resolveClientBonusAmount(userId, true);
  if (!amount || !loyaltyLevelId) {
    throw validationError('Sorry! You are not eligible to claim a client bonus.');
  }

  const token = await generateVoucherToken();
  const issuedAtSl = nowSqlDateTime();
  const insert = await query(
    `INSERT INTO loyalty_client_bonus_vouchers
      (user_id, topup_method_id, platform_id, voucher_token, loyalty_management_client_bonus_id, amount, is_claimed, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    [userId, topupMethodId, platformId, token, loyaltyLevelId, amount, issuedAtSl, issuedAtSl],
  );

  const voucherId = insert.insertId;
  const voucherUrl = `${env.userAppUrl}/dashboard/earnings/vouchers/${token}`;

  bumpAdminNavCounts();

  await notifyClientBonusVoucherIssued({
    userId,
    platformId,
    amount,
    firstName: accountHolder.first_name,
    email: accountHolder.email,
    mobileNumber: accountHolder.mobile_number,
  });

  const updatedSummary = await getClientBonusSummaryForUser(userId, true);

  return {
    ok: true,
    message: 'Client bonus claim voucher issued successfully.',
    voucher_id: voucherId,
    voucher_token: token,
    voucher_url: voucherUrl,
    client_bonus_summary: updatedSummary,
  };
}

export async function getUserVoucherByToken(userId, token) {
  const accountHolder = await assertLoyaltyAccess(userId);
  const voucherToken = String(token || '').trim();
  if (!voucherToken) {
    throw validationError('Voucher token is required.', 400);
  }

  const rows = await query(
    `SELECT v.*, tm.topup_method_name, lml.loyalty_level
     FROM loyalty_client_bonus_vouchers v
     LEFT JOIN topup_methods tm ON tm.id = v.topup_method_id
     LEFT JOIN loyalty_management_levels lml ON lml.id = v.loyalty_management_client_bonus_id
     WHERE v.user_id = ?
       AND v.voucher_token = ?
     LIMIT 1`,
    [userId, voucherToken],
  );

  if (!rows[0]) {
    throw validationError('Voucher not found.', 404);
  }

  const voucher = mapUserVoucherRow(rows[0]);

  return {
    voucher,
    account_holder: {
      account_number: accountHolder.account_number || '—',
      first_name: accountHolder.first_name || '',
      last_name: accountHolder.last_name || '',
      full_name: [accountHolder.first_name, accountHolder.last_name].filter(Boolean).join(' ').trim() || '—',
    },
  };
}

export async function listTopupMethodsForVoucher() {
  await ensureTopupWalletVoucherFlagSchema();

  const rows = await query(
    `SELECT tm.id, tm.topup_method_name
     FROM topup_methods tm
     WHERE UPPER(tm.availability) = 'AVAILABLE'
       AND (tm.is_deleted = 0 OR tm.is_deleted IS NULL)
       AND tm.allow_for_voucher = 1
       AND EXISTS (
         SELECT 1
         FROM deposit_rates dr
         WHERE dr.topup_method_id = tm.id
           AND (dr.is_deleted = 0 OR dr.is_deleted IS NULL)
       )
     ORDER BY tm.id ASC`,
  );

  return {
    topup_methods: rows.map((row) => ({
      id: row.id,
      name: row.topup_method_name,
    })),
  };
}
