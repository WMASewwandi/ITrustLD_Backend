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

function validationError(message, status = 422) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function formatYmdHis(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return '—';
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${d} ${hh}:${mm}`;
}

function hasDiamondTierBenefits(levelId) {
  return [4, 5, 6].includes(Number(levelId));
}

function isAutoRejected(row) {
  if (Number(row.is_claimed) === 1 || row.rejection_reason) return false;
  const created = new Date(row.created_at);
  if (Number.isNaN(created.getTime())) return false;
  const days = (Date.now() - created.getTime()) / (1000 * 60 * 60 * 24);
  return days >= 30;
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

async function isLevelClientBonusActive(loyaltyLevel) {
  const level = await getActiveLevelData(loyaltyLevel);
  return Boolean(level?.is_active);
}

async function getIssuedVoucherCount(userId, lmcbId) {
  const rows = await query(
    `SELECT COUNT(*) AS total
     FROM loyalty_client_bonus_vouchers
     WHERE loyalty_management_client_bonus_id = ?
       AND user_id = ?`,
    [lmcbId, userId],
  );
  return Number(rows[0]?.total || 0);
}

async function isSilverClientBonusAvailable(userId) {
  const master = await fetchMasterConfig('SILVER-BONUS');
  if (!master?.is_active || !(await isLevelClientBonusActive('SILVER'))) return false;

  const pointLevel = await getUserPointLevel(userId);
  if (Number(pointLevel?.point_level_id) !== 2) return false;

  const loyaltyLevel = await getActiveLevelData('SILVER');
  if (!loyaltyLevel) return false;

  const count = await getIssuedVoucherCount(userId, loyaltyLevel.id);
  return count < Number(loyaltyLevel.client_count);
}

async function isGoldClientBonusAvailable(userId) {
  const master = await fetchMasterConfig('GOLD-BONUS');
  if (!master?.is_active || !(await isLevelClientBonusActive('GOLD'))) return false;

  const pointLevel = await getUserPointLevel(userId);
  if (Number(pointLevel?.point_level_id) !== 3) return false;

  const loyaltyLevel = await getActiveLevelData('GOLD');
  if (!loyaltyLevel) return false;

  const count = await getIssuedVoucherCount(userId, loyaltyLevel.id);
  return count < Number(loyaltyLevel.client_count);
}

async function isDiamondClientBonusAvailable(userId) {
  const master = await fetchMasterConfig('DIAMOND-BONUS');
  if (!master?.is_active || !(await isLevelClientBonusActive('DIAMOND'))) return false;

  const pointLevel = await getUserPointLevel(userId);
  if (!hasDiamondTierBenefits(pointLevel?.point_level_id)) return false;

  const loyaltyLevel = await getActiveLevelData('DIAMOND');
  if (!loyaltyLevel) return false;

  const count = await getIssuedVoucherCount(userId, loyaltyLevel.id);
  return count < Number(loyaltyLevel.client_count);
}

function buildTierSummary(available, loyaltyLevel, issuedCount) {
  if (!available || !loyaltyLevel) {
    return {
      available: false,
      remaining: 0,
      amount_per_client: 0,
      loyalty_level_id: null,
    };
  }

  const clientCount = Number(loyaltyLevel.client_count) || 0;
  const bonusAmount = Number(loyaltyLevel.client_bonus_amount) || 0;
  const remaining = Math.max(0, clientCount - issuedCount);
  const amountPerClient = clientCount > 0 ? bonusAmount / clientCount : 0;

  return {
    available: remaining > 0,
    remaining,
    amount_per_client: Number(amountPerClient.toFixed(2)),
    loyalty_level_id: loyaltyLevel.id,
  };
}

export async function getClientBonusSummaryForUser(userId, isPartner) {
  if (!isPartner) {
    return {
      can_issue: false,
      remaining_slots: 0,
      amount_per_client: 0,
      tier: null,
      loyalty_management_client_bonus_id: null,
      silver: { available: false, remaining: 0, amount_per_client: 0, loyalty_level_id: null },
      gold: { available: false, remaining: 0, amount_per_client: 0, loyalty_level_id: null },
      diamond: { available: false, remaining: 0, amount_per_client: 0, loyalty_level_id: null },
    };
  }

  const [silverAvailable, goldAvailable, diamondAvailable, silverLevel, goldLevel, diamondLevel] =
    await Promise.all([
      isSilverClientBonusAvailable(userId),
      isGoldClientBonusAvailable(userId),
      isDiamondClientBonusAvailable(userId),
      getActiveLevelData('SILVER'),
      getActiveLevelData('GOLD'),
      getActiveLevelData('DIAMOND'),
    ]);

  const [silverIssued, goldIssued, diamondIssued, pointLevel] = await Promise.all([
    silverLevel ? getIssuedVoucherCount(userId, silverLevel.id) : Promise.resolve(0),
    goldLevel ? getIssuedVoucherCount(userId, goldLevel.id) : Promise.resolve(0),
    diamondLevel ? getIssuedVoucherCount(userId, diamondLevel.id) : Promise.resolve(0),
    getUserPointLevel(userId),
  ]);

  const silver = buildTierSummary(silverAvailable, silverLevel, silverIssued);
  const gold = buildTierSummary(goldAvailable, goldLevel, goldIssued);
  const diamond = buildTierSummary(diamondAvailable, diamondLevel, diamondIssued);

  const level = Number(pointLevel?.point_level_id) || 1;
  let activeTier = null;
  let activeSummary = null;

  if (level === 2 && silver.available) {
    activeTier = 'silver';
    activeSummary = silver;
  } else if (level === 3 && gold.available) {
    activeTier = 'gold';
    activeSummary = gold;
  } else if (hasDiamondTierBenefits(level) && diamond.available) {
    activeTier = 'diamond';
    activeSummary = diamond;
  }

  return {
    can_issue: Boolean(activeSummary?.available),
    remaining_slots: activeSummary?.remaining || 0,
    amount_per_client: activeSummary?.amount_per_client || 0,
    tier: activeTier,
    loyalty_management_client_bonus_id: activeSummary?.loyalty_level_id || null,
    silver,
    gold,
    diamond,
  };
}

function mapUserVoucherRow(row) {
  const amount = Number(row.amount || 0);
  const method = row.topup_method_name || '—';
  const status = mapVoucherStatus(row);
  const token = row.voucher_token || '';

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
    voucher_url: token ? `${env.userAppUrl}/dashboard/earnings/vouchers/${token}` : null,
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
    `SELECT v.*, tm.topup_method_name
     FROM loyalty_client_bonus_vouchers v
     LEFT JOIN topup_methods tm ON tm.id = v.topup_method_id
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

  const validUntil = new Date();
  validUntil.setDate(validUntil.getDate() + 30);
  const validUntilLabel = validUntil.toLocaleDateString('en-US', {
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

  const topupRows = await query(
    `SELECT id, topup_method_name
     FROM topup_methods
     WHERE id = ?
       AND UPPER(availability) = 'AVAILABLE'
       AND (is_deleted = 0 OR is_deleted IS NULL)
     LIMIT 1`,
    [topupMethodId],
  );
  if (!topupRows[0]) {
    throw validationError('Selected topup method was not found.');
  }

  const { amount, loyaltyLevelId } = await resolveClientBonusAmount(userId, true);
  if (!amount || !loyaltyLevelId) {
    throw validationError('Sorry! You are not eligible to claim a client bonus.');
  }

  const token = await generateVoucherToken();
  const insert = await query(
    `INSERT INTO loyalty_client_bonus_vouchers
      (user_id, topup_method_id, platform_id, voucher_token, loyalty_management_client_bonus_id, amount, is_claimed, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, NOW(), NOW())`,
    [userId, topupMethodId, platformId, token, loyaltyLevelId, amount],
  );

  const voucherId = insert.insertId;
  const voucherUrl = `${env.userAppUrl}/dashboard/earnings/vouchers/${token}`;

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
    `SELECT v.*, tm.topup_method_name
     FROM loyalty_client_bonus_vouchers v
     LEFT JOIN topup_methods tm ON tm.id = v.topup_method_id
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
  const rows = await query(
    `SELECT tm.id, tm.topup_method_name
     FROM topup_methods tm
     WHERE UPPER(tm.availability) = 'AVAILABLE'
       AND (tm.is_deleted = 0 OR tm.is_deleted IS NULL)
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
