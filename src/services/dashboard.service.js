import { query } from '../config/database.js';
import { formatTimestampSl, formatYmdColombo, parseDbDateTime } from '../utils/slTime.js';
import { findAccountHolderByUserId } from './accountHolder.service.js';
import { listPublishedBlogPostsForUser } from './blog.service.js';
import { getDashboardPromotionalContent } from './promotionalBanner.service.js';
import { buildDocumentRows } from './userDocuments.service.js';
import { getUserSession } from './userAuth.service.js';
import { resolveWalletLogoPublicUrl } from './walletLogoStorage.service.js';
import {
  getPendingDepositIds,
  getPendingDepositsCount,
  getPendingWithdrawalIds,
  getPendingWithdrawalsCount,
  resolveUserType,
} from './userSummary.service.js';

function formatTransactionDate(value) {
  return formatTimestampSl(value);
}

function formatAmount(currency, amount) {
  const code = currency || 'USD';
  const value = Number(amount || 0);
  return `${code} ${value.toFixed(2)}`;
}

function mapDepositRow(row) {
  return {
    id: String(row.id),
    transaction_id: row.transaction_id || String(row.id),
    type: 'deposit',
    method: row.payment_option_name || 'Top-up',
    amount: formatAmount(row.deposit_amount_currency, row.deposit_amount),
    datetime: formatTransactionDate(row.created_at),
    status: row.transaction_status || 'Pending',
    created_at: row.created_at,
  };
}

function mapWithdrawalRow(row) {
  return {
    id: String(row.id),
    transaction_id: row.transaction_id || String(row.id),
    type: 'withdrawal',
    method: row.payment_option_name || 'Cash-out',
    amount: formatAmount(row.cashout_amount_currency, row.cashout_amount),
    datetime: formatTransactionDate(row.created_at),
    status: row.transaction_status || 'Pending',
    created_at: row.created_at,
  };
}

async function getRecentTransactions(userId, limit = 5) {
  const [deposits, withdrawals] = await Promise.all([
    query(
      `SELECT d.id, d.transaction_id, d.created_at, d.deposit_amount, d.deposit_amount_currency,
              d.transaction_status, po.payment_option_name
       FROM deposits d
       LEFT JOIN payment_options po ON po.id = d.payment_option_id
       WHERE d.user_id = ? AND d.payment_proof IS NOT NULL
       ORDER BY d.created_at DESC
       LIMIT 10`,
      [userId],
    ),
    query(
      `SELECT w.id, w.transaction_id, w.created_at, w.cashout_amount, w.cashout_amount_currency,
              w.transaction_status, po.payment_option_name
       FROM withdrawals w
       LEFT JOIN payment_options po ON po.id = w.receiving_payment_option_id
       WHERE w.user_id = ? AND w.cashout_payment_proof IS NOT NULL
       ORDER BY w.created_at DESC
       LIMIT 10`,
      [userId],
    ),
  ]);

  return [...deposits.map(mapDepositRow), ...withdrawals.map(mapWithdrawalRow)]
    .sort((a, b) => {
      const bMs = parseDbDateTime(b.created_at)?.getTime() || 0;
      const aMs = parseDbDateTime(a.created_at)?.getTime() || 0;
      return bMs - aMs;
    })
    .slice(0, limit)
    .map(({ created_at: _createdAt, ...tx }) => tx);
}

function buildNotifications({ accountHolder, summary, documents }) {
  const items = [];
  let id = 1;

  const pendingDepositIds = Array.isArray(summary.pending_deposit_ids)
    ? summary.pending_deposit_ids
    : [];
  const pendingWithdrawalIds = Array.isArray(summary.pending_withdrawal_ids)
    ? summary.pending_withdrawal_ids
    : [];

  if (pendingDepositIds.length > 0) {
    for (const transactionId of pendingDepositIds) {
      items.push({
        id: id++,
        title: 'Top-up pending',
        body: `Your top-up request #${transactionId} is being reviewed.`,
        time: 'Recently',
        transaction_id: transactionId,
      });
    }
  } else if (summary.pending_deposits_count > 0) {
    items.push({
      id: id++,
      title: 'Top-up pending',
      body:
        summary.pending_deposits_count === 1
          ? 'Your top-up request is being reviewed.'
          : `${summary.pending_deposits_count} top-up requests are being reviewed.`,
      time: 'Recently',
    });
  }

  if (pendingWithdrawalIds.length > 0) {
    for (const transactionId of pendingWithdrawalIds) {
      items.push({
        id: id++,
        title: 'Cash-out pending',
        body: `Your cash-out request #${transactionId} is being reviewed.`,
        time: 'Recently',
        transaction_id: transactionId,
      });
    }
  } else if (summary.pending_withdrawals_count > 0) {
    items.push({
      id: id++,
      title: 'Cash-out pending',
      body:
        summary.pending_withdrawals_count === 1
          ? 'Your cash-out request is being reviewed.'
          : `${summary.pending_withdrawals_count} cash-out requests are being reviewed.`,
      time: 'Recently',
    });
  }

  const inProgressDoc = documents.find((doc) => doc.status === 'In-Progress');
  if (inProgressDoc) {
    items.push({
      id: id++,
      title: 'Document update',
      body: `${inProgressDoc.name} is under review.`,
      time: 'Recently',
    });
  }

  const rejectedDoc = documents.find((doc) => doc.status === 'Rejected');
  if (rejectedDoc) {
    items.push({
      id: id++,
      title: 'Action required',
      body: `${rejectedDoc.name} was rejected. Please re-upload from Documents.`,
      time: 'Recently',
    });
  }

  if (
    accountHolder &&
    (accountHolder.identity_verification !== 'VERIFIED' ||
      accountHolder.address_verification !== 'VERIFIED')
  ) {
    const pendingDoc = documents.find((doc) => doc.status === 'Pending');
    if (pendingDoc && !rejectedDoc) {
      items.push({
        id: id++,
        title: 'Complete verification',
        body: `Upload ${pendingDoc.name} to unlock all top-up methods.`,
        time: 'Reminder',
      });
    }
  }

  return items;
}

function rateMethodKey(row) {
  if (row.wallet_id != null) return `w:${row.wallet_id}`;
  return `n:${String(row.name || '').trim().toLowerCase()}`;
}

function pickFirstPerMethod(rows) {
  const seen = new Set();
  const picked = [];
  for (const row of rows) {
    const key = rateMethodKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push({ ...row, key });
  }
  return picked;
}

function rateDateYmd(value) {
  const parsed = parseDbDateTime(value);
  if (parsed) return formatYmdColombo(parsed);
  const raw = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : '';
}

function rateUpdatedSortMs(row) {
  const parsed = parseDbDateTime(row.updated_at) || parseDbDateTime(row.applicable_date);
  return parsed ? parsed.getTime() : 0;
}

async function loadAvailableTopupMethods() {
  return query(
    `SELECT tm.topup_method_name AS name,
            tm.topup_method_logo AS logo,
            tm.wallet_id
     FROM topup_methods tm
     WHERE (tm.is_deleted = 0 OR tm.is_deleted IS NULL)
       AND UPPER(tm.availability) = 'AVAILABLE'
     ORDER BY tm.topup_method_name ASC, tm.id DESC`,
  );
}

async function loadAvailableCashoutMethods() {
  return query(
    `SELECT cm.cashout_method_name AS name,
            cm.cashout_method_logo AS logo,
            cm.wallet_id
     FROM cashout_methods cm
     WHERE (cm.is_deleted = 0 OR cm.is_deleted IS NULL)
       AND UPPER(cm.availability) = 'AVAILABLE'
     ORDER BY cm.cashout_method_name ASC, cm.id DESC`,
  );
}

async function loadLatestDepositRates() {
  return query(
    `SELECT tm.topup_method_name AS name,
            tm.topup_method_logo AS logo,
            tm.wallet_id,
            po.payment_option_name,
            po.payment_option_currency,
            dr.rate,
            dr.applicable_date,
            dr.updated_at
     FROM deposit_rates dr
     INNER JOIN topup_methods tm ON tm.id = dr.topup_method_id
     INNER JOIN payment_options po ON po.id = dr.payment_option_id
     WHERE (dr.is_deleted = 0 OR dr.is_deleted IS NULL)
       AND (tm.is_deleted = 0 OR tm.is_deleted IS NULL)
       AND UPPER(tm.availability) = 'AVAILABLE'
       AND (po.is_deleted = 0 OR po.is_deleted IS NULL)
       AND UPPER(po.availability) = 'AVAILABLE'
     ORDER BY dr.applicable_date DESC, dr.id DESC`,
  );
}

async function loadLatestWithdrawalRates() {
  return query(
    `SELECT cm.cashout_method_name AS name,
            cm.cashout_method_logo AS logo,
            cm.wallet_id,
            po.payment_option_name,
            po.payment_option_currency,
            wr.rate,
            wr.applicable_date,
            wr.updated_at
     FROM withdrawal_rates wr
     INNER JOIN cashout_methods cm ON cm.id = wr.cashout_method_id
     INNER JOIN payment_options po ON po.id = wr.payment_option_id
     WHERE (wr.is_deleted = 0 OR wr.is_deleted IS NULL)
       AND (cm.is_deleted = 0 OR cm.is_deleted IS NULL)
       AND UPPER(cm.availability) = 'AVAILABLE'
       AND (po.is_deleted = 0 OR po.is_deleted IS NULL)
       AND UPPER(po.availability) = 'AVAILABLE'
     ORDER BY wr.applicable_date DESC, wr.id DESC`,
  );
}

function mergeTodayRates(depositMethods, withdrawalMethods, depositRows, withdrawalRows) {
  const map = new Map();

  function ensure(row) {
    const key = rateMethodKey(row);
    if (!map.has(key)) {
      map.set(key, {
        name: row.name,
        logoUrl: resolveWalletLogoPublicUrl(row.logo),
        buyRate: null,
        sellRate: null,
        currency: row.payment_option_currency || '',
        paymentOption: row.payment_option_name || '',
        updatedAt: '',
        updatedSort: 0,
      });
    }
    return map.get(key);
  }

  for (const row of pickFirstPerMethod(depositMethods)) ensure(row);
  for (const row of pickFirstPerMethod(withdrawalMethods)) ensure(row);

  for (const row of pickFirstPerMethod(depositRows)) {
    const item = ensure(row);
    const rate = Number(row.rate);
    if (Number.isFinite(rate) && rate > 0) item.buyRate = rate;
    if (row.payment_option_name) item.paymentOption = row.payment_option_name;
    if (row.payment_option_currency) item.currency = row.payment_option_currency;
    const updatedAt = rateDateYmd(row.applicable_date);
    if (updatedAt && updatedAt > item.updatedAt) item.updatedAt = updatedAt;
    item.updatedSort = Math.max(item.updatedSort || 0, rateUpdatedSortMs(row));
  }

  for (const row of pickFirstPerMethod(withdrawalRows)) {
    const item = ensure(row);
    const rate = Number(row.rate);
    if (Number.isFinite(rate) && rate > 0) item.sellRate = rate;
    if (!item.paymentOption && row.payment_option_name) item.paymentOption = row.payment_option_name;
    if (!item.currency && row.payment_option_currency) item.currency = row.payment_option_currency;
    const updatedAt = rateDateYmd(row.applicable_date);
    if (updatedAt && updatedAt > item.updatedAt) item.updatedAt = updatedAt;
    item.updatedSort = Math.max(item.updatedSort || 0, rateUpdatedSortMs(row));
  }

  return Array.from(map.values())
    .sort((a, b) => (b.updatedSort || 0) - (a.updatedSort || 0))
    .map(({ updatedSort, ...item }) => item);
}

export async function getDashboardTodayRates() {
  const [depositMethods, withdrawalMethods, depositRows, withdrawalRows] = await Promise.all([
    loadAvailableTopupMethods(),
    loadAvailableCashoutMethods(),
    loadLatestDepositRates(),
    loadLatestWithdrawalRates(),
  ]);

  const methods = mergeTodayRates(depositMethods, withdrawalMethods, depositRows, withdrawalRows);
  const latestDate = methods.reduce(
    (max, item) => (item.updatedAt && item.updatedAt > max ? item.updatedAt : max),
    '',
  );
  const today = formatYmdColombo();

  return {
    date: latestDate || today,
    from_today: Boolean(latestDate) && latestDate === today,
    methods,
  };
}

export async function getUserNotifications(userId) {
  const accountHolder = await findAccountHolderByUserId(userId);
  const [
    pendingDepositsCount,
    pendingWithdrawalsCount,
    pendingDepositIds,
    pendingWithdrawalIds,
    documents,
  ] = await Promise.all([
    getPendingDepositsCount(userId),
    getPendingWithdrawalsCount(userId),
    getPendingDepositIds(userId),
    getPendingWithdrawalIds(userId),
    buildDocumentRows(accountHolder, { checkStorage: false }),
  ]);

  return {
    ok: true,
    notifications: buildNotifications({
      accountHolder,
      summary: {
        pending_deposits_count: pendingDepositsCount,
        pending_withdrawals_count: pendingWithdrawalsCount,
        pending_deposit_ids: pendingDepositIds,
        pending_withdrawal_ids: pendingWithdrawalIds,
      },
      documents,
    }),
  };
}

export async function getUserDashboard(userId) {
  const accountHolder = await findAccountHolderByUserId(userId);
  const userType = resolveUserType(accountHolder);
  const [user, documents, recentTransactions, blogPosts, promotionalContent, todayRates] =
    await Promise.all([
      getUserSession(userId, { accountHolder }),
      buildDocumentRows(accountHolder, { checkStorage: false }),
      getRecentTransactions(userId),
      listPublishedBlogPostsForUser(6),
      getDashboardPromotionalContent(userType),
      getDashboardTodayRates(),
    ]);

  const summary = {
    trust_points: user.trust_points ?? 0,
    earned_for_year: user.earned_for_year ?? 0,
    saved_banks_count: user.saved_banks_count ?? 0,
    pending_deposits_count: user.pending_deposits_count ?? 0,
    pending_withdrawals_count: user.pending_withdrawals_count ?? 0,
    pending_deposit_ids: Array.isArray(user.pending_deposit_ids) ? user.pending_deposit_ids : [],
    pending_withdrawal_ids: Array.isArray(user.pending_withdrawal_ids)
      ? user.pending_withdrawal_ids
      : [],
  };
  const notifications = buildNotifications({ accountHolder, summary, documents });
  const verificationComplete =
    accountHolder?.email_verification === 'VERIFIED' &&
    accountHolder?.mobile_number_verification === 'VERIFIED' &&
    accountHolder?.identity_verification === 'VERIFIED' &&
    accountHolder?.address_verification === 'VERIFIED';

  return {
    ok: true,
    user: {
      ...user,
      user_type: userType,
      ...summary,
    },
    documents,
    verification_complete: verificationComplete,
    recent_transactions: recentTransactions,
    blog_posts: blogPosts,
    promo_banner: promotionalContent.promo_banner,
    promotional_slider_banners: promotionalContent.promotional_slider_banners,
    promotional_sliders: promotionalContent.promotional_sliders,
    promotional_banners: promotionalContent.promotional_banners,
    notifications,
    today_rates: todayRates,
    affiliate_code: accountHolder?.affiliate_code || null,
  };
}
