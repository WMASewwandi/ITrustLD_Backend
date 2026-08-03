import { getDbDriver, query } from '../config/database.js';
import { getAllSystemUsers } from './systemUser.service.js';
import {
  addColomboDays,
  colomboLocalToDate,
  formatDateTimeDisplaySl,
  formatTimestampSl,
  getColomboDateParts,
  startOfColomboDay,
  startOfColomboWeek,
} from '../utils/slTime.js';

const COMMISSION_PER_COMPLETED = 8;
const CACHE_TTL_MS = 30_000;
const cache = new Map();

const PERIOD_LABELS = {
  daily: { current: 'today', previous: 'yesterday' },
  weekly: { current: 'this week', previous: 'last week' },
  monthly: { current: 'this month', previous: 'last month' },
};

function normalizePeriod(period) {
  const value = String(period || 'weekly').toLowerCase();
  if (value === 'daily' || value === 'weekly' || value === 'monthly') return value;
  return 'weekly';
}

function getPeriodWindow(period, offset = 0) {
  const now = new Date();
  if (period === 'daily') {
    const start = addColomboDays(startOfColomboDay(now), -offset);
    return { start, end: addColomboDays(start, 1) };
  }
  if (period === 'weekly') {
    const start = addColomboDays(startOfColomboWeek(now), -7 * offset);
    return { start, end: addColomboDays(start, 7) };
  }

  const parts = getColomboDateParts(now);
  let month = parts.month - offset;
  let year = parts.year;
  while (month <= 0) {
    month += 12;
    year -= 1;
  }
  const start = colomboLocalToDate({ year, month, day: 1 });
  let endMonth = month + 1;
  let endYear = year;
  if (endMonth > 12) {
    endMonth = 1;
    endYear += 1;
  }
  const end = colomboLocalToDate({ year: endYear, month: endMonth, day: 1 });
  return { start, end };
}

function toSqlDate(date) {
  return formatTimestampSl(date);
}

function sqlHour(column) {
  return getDbDriver() === 'sqlite'
    ? `CAST(strftime('%H', ${column}) AS INTEGER)`
    : `HOUR(${column})`;
}

function sqlDate(column) {
  return getDbDriver() === 'sqlite' ? `date(${column})` : `DATE(${column})`;
}

function sqlWeekOfMonth(column) {
  if (getDbDriver() === 'sqlite') {
    return `CAST((CAST(strftime('%d', ${column}) AS INTEGER) - 1) / 7 + 1 AS INTEGER)`;
  }
  return `FLOOR((DAYOFMONTH(${column}) - 1) / 7) + 1`;
}

function emptyTypeStats() {
  return { completed: 0, rejected: 0, buckets: {} };
}

function mergeBucketMaps(target, source) {
  for (const [key, value] of Object.entries(source || {})) {
    target[key] = (target[key] || 0) + value;
  }
}

function buildMetrics(typeStats) {
  const deposits = typeStats.deposits || emptyTypeStats();
  const withdrawals = typeStats.withdrawals || emptyTypeStats();
  const loyalty = typeStats.loyalty || emptyTypeStats();

  const completed = deposits.completed + withdrawals.completed + loyalty.completed;
  const rejected = deposits.rejected + withdrawals.rejected + loyalty.rejected;
  const handled = completed + rejected;
  const successRate = handled ? (completed / handled) * 100 : 0;
  const commission = completed * COMMISSION_PER_COMPLETED;

  return {
    handled,
    completed,
    rejected,
    successRate,
    commission,
    deposits,
    withdrawals,
    loyalty,
  };
}

function formatUsd(amount) {
  return `$ ${Number(amount || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatDelta(current, previous, period) {
  const labels = PERIOD_LABELS[period];
  const diff = current - previous;
  const sign = diff > 0 ? '+' : '';
  if (period === 'daily' && labels) {
    return `${sign}${diff} vs ${labels.previous}`;
  }
  if (labels) {
    return `${sign}${diff} vs ${labels.previous}`;
  }
  return `${sign}${diff}`;
}

function formatPercentDelta(current, previous) {
  const diff = current - previous;
  const sign = diff > 0 ? '+' : '';
  return `${sign}${diff.toFixed(1)}%`;
}

function formatMoneyDelta(current, previous) {
  const diff = current - previous;
  const sign = diff > 0 ? '+' : diff < 0 ? '-' : '';
  return `${sign}$${Math.abs(diff).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

function buildBreakdown(metrics) {
  const rows = [
    { key: 'deposits', label: 'Deposits', stats: metrics.deposits },
    { key: 'withdrawals', label: 'Withdrawals', stats: metrics.withdrawals },
    { key: 'loyalty', label: 'Loyalty', stats: metrics.loyalty },
  ];

  const totalHandled = metrics.handled || 1;
  return rows.map((row) => {
    const count = row.stats.completed + row.stats.rejected;
    const pct = Math.round((count / totalHandled) * 100);
    return {
      label: row.label,
      count,
      pct,
      commission: formatUsd(row.stats.completed * COMMISSION_PER_COMPLETED),
    };
  });
}

function buildTrend(period, bucketMaps) {
  const merged = {};
  for (const map of bucketMaps) {
    mergeBucketMaps(merged, map);
  }

  if (period === 'daily') {
    const labels = ['6a', '8a', '10a', '12p', '2p', '4p', '6p', '8p'];
    const hours = [6, 8, 10, 12, 14, 16, 18, 20];
    const values = hours.map((hour) => merged[String(hour)] || 0);
    return {
      labels,
      values,
      subtitle: 'Transactions by hour — today',
    };
  }

  if (period === 'weekly') {
    const labels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const { start } = getPeriodWindow('weekly', 0);
    const values = labels.map((_, index) => {
      const day = addDays(start, index);
      const key = day.toISOString().slice(0, 10);
      return merged[key] || 0;
    });
    return {
      labels,
      values,
      subtitle: 'Daily volume — current week',
    };
  }

  const labels = ['W1', 'W2', 'W3', 'W4'];
  const values = labels.map((_, index) => merged[String(index + 1)] || 0);
  return {
    labels,
    values,
    subtitle: `Weekly volume — ${new Date().toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'Asia/Colombo' })}`,
  };
}

function bucketExpr(period) {
  if (period === 'daily') return sqlHour('updated_at');
  if (period === 'weekly') return sqlDate('updated_at');
  return sqlWeekOfMonth('updated_at');
}

async function fetchGroupedActions({ adminId, start, end, period }) {
  const startSql = toSqlDate(start);
  const endSql = toSqlDate(end);
  const bucket = bucketExpr(period);
  const adminCompletedFilter = adminId ? 'AND approved_by_admin = ?' : '';
  const adminRejectedFilter = adminId ? 'AND rejected_by_admin = ?' : '';

  const sql = `
    SELECT source, outcome, admin_id, bucket_key, COUNT(*) AS total
    FROM (
      SELECT 'deposits' AS source,
             'completed' AS outcome,
             approved_by_admin AS admin_id,
             ${bucket} AS bucket_key
      FROM deposits
      WHERE transaction_status = 'Completed'
        AND approved_by_admin IS NOT NULL
        AND updated_at >= ? AND updated_at < ?
        ${adminCompletedFilter}

      UNION ALL

      SELECT 'deposits', 'rejected', rejected_by_admin, ${bucket}
      FROM deposits
      WHERE transaction_status = 'Rejected'
        AND rejected_by_admin IS NOT NULL
        AND updated_at >= ? AND updated_at < ?
        ${adminRejectedFilter}

      UNION ALL

      SELECT 'withdrawals', 'completed', approved_by_admin, ${bucket}
      FROM withdrawals
      WHERE transaction_status = 'Completed'
        AND approved_by_admin IS NOT NULL
        AND updated_at >= ? AND updated_at < ?
        ${adminCompletedFilter}

      UNION ALL

      SELECT 'withdrawals', 'rejected', rejected_by_admin, ${bucket}
      FROM withdrawals
      WHERE transaction_status = 'Rejected'
        AND rejected_by_admin IS NOT NULL
        AND updated_at >= ? AND updated_at < ?
        ${adminRejectedFilter}

      UNION ALL

      SELECT 'loyalty', 'completed', approved_by_admin, ${bucket}
      FROM point_withdrawals
      WHERE status = 'Approved'
        AND approved_by_admin IS NOT NULL
        AND updated_at >= ? AND updated_at < ?
        ${adminCompletedFilter}

      UNION ALL

      SELECT 'loyalty', 'rejected', rejected_by_admin, ${bucket}
      FROM point_withdrawals
      WHERE status = 'Rejected'
        AND rejected_by_admin IS NOT NULL
        AND updated_at >= ? AND updated_at < ?
        ${adminRejectedFilter}

      UNION ALL

      SELECT 'loyalty', 'completed', approved_by_admin, ${bucket}
      FROM loyalty_bonus_collects
      WHERE status = 'Approved'
        AND approved_by_admin IS NOT NULL
        AND updated_at >= ? AND updated_at < ?
        ${adminCompletedFilter}

      UNION ALL

      SELECT 'loyalty', 'rejected', rejected_by_admin, ${bucket}
      FROM loyalty_bonus_collects
      WHERE status = 'Rejected'
        AND rejected_by_admin IS NOT NULL
        AND updated_at >= ? AND updated_at < ?
        ${adminRejectedFilter}
    ) actions
    WHERE admin_id IS NOT NULL
    GROUP BY source, outcome, admin_id, bucket_key`;

  const fullParams = [];
  for (let i = 0; i < 8; i += 1) {
    fullParams.push(startSql, endSql);
    if (adminId) fullParams.push(adminId);
  }

  const rows = await query(sql, fullParams);
  return rows;
}

function aggregateRows(rows, { adminId = null } = {}) {
  const byAdmin = new Map();

  function ensureStats(map, id) {
    if (!map.has(id)) {
      map.set(id, {
        deposits: emptyTypeStats(),
        withdrawals: emptyTypeStats(),
        loyalty: emptyTypeStats(),
        buckets: {},
      });
    }
    return map.get(id);
  }

  for (const row of rows) {
    const id = Number(row.admin_id);
    if (!id || (adminId && id !== adminId)) continue;

    const stats = ensureStats(byAdmin, id);
    const source =
      row.source === 'withdrawals'
        ? 'withdrawals'
        : row.source === 'loyalty'
          ? 'loyalty'
          : 'deposits';
    const count = Number(row.total) || 0;
    const bucketKey = String(row.bucket_key);

    if (row.outcome === 'completed') {
      stats[source].completed += count;
    } else {
      stats[source].rejected += count;
    }

    mergeBucketMaps(stats.buckets, { [bucketKey]: count });
    mergeBucketMaps(stats[source].buckets, { [bucketKey]: count });
  }

  if (adminId) {
    return byAdmin.get(adminId) || {
      deposits: emptyTypeStats(),
      withdrawals: emptyTypeStats(),
      loyalty: emptyTypeStats(),
      buckets: {},
    };
  }

  return byAdmin;
}

function buildResponseFromStats(period, currentStats, previousStats, audit = {}) {
  const currentMetrics = buildMetrics(currentStats);
  const previousMetrics = buildMetrics(previousStats);

  return {
    period,
    metrics: {
      handled: currentMetrics.handled,
      handledDelta: formatDelta(currentMetrics.handled, previousMetrics.handled, period),
      successRate: `${currentMetrics.successRate.toFixed(1)}%`,
      successDelta: formatPercentDelta(currentMetrics.successRate, previousMetrics.successRate),
      commission: formatUsd(currentMetrics.commission),
      commissionDelta: formatMoneyDelta(currentMetrics.commission, previousMetrics.commission),
    },
    trend: buildTrend(period, [
      currentStats.buckets,
    ]),
    breakdown: buildBreakdown(currentMetrics),
    audit: {
      by: audit.by || 'System',
      at: audit.at || formatDateTimeDisplaySl(new Date()),
    },
  };
}

async function loadStatsForWindow(adminId, period, offset) {
  const { start, end } = getPeriodWindow(period, offset);
  const rows = await fetchGroupedActions({ adminId, start, end, period });
  if (adminId) {
    return aggregateRows(rows, { adminId });
  }
  return aggregateRows(rows);
}

function readCache(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function writeCache(key, data) {
  cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

export async function getMyPerformance(userId, periodInput, auditUser = {}) {
  const period = normalizePeriod(periodInput);
  const cacheKey = `me:${userId}:${period}`;
  const cached = readCache(cacheKey);
  if (cached) return cached;

  const [currentStats, previousStats] = await Promise.all([
    loadStatsForWindow(userId, period, 0),
    loadStatsForWindow(userId, period, 1),
  ]);

  const data = buildResponseFromStats(period, currentStats, previousStats, {
    by: auditUser.name || auditUser.email || 'You',
    at: formatDateTimeDisplaySl(new Date()),
  });

  writeCache(cacheKey, data);
  return data;
}

export async function getTeamPerformance(periodInput) {
  const period = normalizePeriod(periodInput);
  const cacheKey = `team:${period}`;
  const cached = readCache(cacheKey);
  if (cached) return cached;

  const [currentByAdmin, previousByAdmin, users] = await Promise.all([
    loadStatsForWindow(null, period, 0),
    loadStatsForWindow(null, period, 1),
    getAllSystemUsers(),
  ]);

  const aggregateCurrent = {
    deposits: emptyTypeStats(),
    withdrawals: emptyTypeStats(),
    loyalty: emptyTypeStats(),
    buckets: {},
  };
  const aggregatePrevious = {
    deposits: emptyTypeStats(),
    withdrawals: emptyTypeStats(),
    loyalty: emptyTypeStats(),
    buckets: {},
  };

  for (const stats of currentByAdmin.values()) {
    aggregateCurrent.deposits.completed += stats.deposits.completed;
    aggregateCurrent.deposits.rejected += stats.deposits.rejected;
    aggregateCurrent.withdrawals.completed += stats.withdrawals.completed;
    aggregateCurrent.withdrawals.rejected += stats.withdrawals.rejected;
    aggregateCurrent.loyalty.completed += stats.loyalty.completed;
    aggregateCurrent.loyalty.rejected += stats.loyalty.rejected;
    mergeBucketMaps(aggregateCurrent.buckets, stats.buckets);
  }

  for (const stats of previousByAdmin.values()) {
    aggregatePrevious.deposits.completed += stats.deposits.completed;
    aggregatePrevious.deposits.rejected += stats.deposits.rejected;
    aggregatePrevious.withdrawals.completed += stats.withdrawals.completed;
    aggregatePrevious.withdrawals.rejected += stats.withdrawals.rejected;
    aggregatePrevious.loyalty.completed += stats.loyalty.completed;
    aggregatePrevious.loyalty.rejected += stats.loyalty.rejected;
  }

  const currentMetrics = buildMetrics(aggregateCurrent);
  const previousMetrics = buildMetrics(aggregatePrevious);
  const trend = buildTrend(period, [aggregateCurrent.buckets]);

  const trendDelta =
    previousMetrics.handled > 0
      ? ((currentMetrics.handled - previousMetrics.handled) / previousMetrics.handled) * 100
      : currentMetrics.handled > 0
        ? 100
        : 0;

  const members = users
    .map((user) => {
      const stats = currentByAdmin.get(user.id) || {
        deposits: emptyTypeStats(),
        withdrawals: emptyTypeStats(),
        loyalty: emptyTypeStats(),
        buckets: {},
      };
      const metrics = buildMetrics(stats);
      const handledByType = {
        deposits: stats.deposits.completed + stats.deposits.rejected,
        withdrawals: stats.withdrawals.completed + stats.withdrawals.rejected,
        loyalty: stats.loyalty.completed + stats.loyalty.rejected,
      };
      const typeTotal = metrics.handled || 1;

      return {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role_display_name || user.role,
        online: user.is_online,
        shift: user.shift || '—',
        handled: metrics.handled,
        success: Number(metrics.successRate.toFixed(1)),
        commission: metrics.commission,
        breakdown: {
          deposits: Math.round((handledByType.deposits / typeTotal) * 100),
          withdrawals: Math.round((handledByType.withdrawals / typeTotal) * 100),
          loyalty: Math.round((handledByType.loyalty / typeTotal) * 100),
        },
        lastActive: user.is_online ? 'Online now' : '—',
      };
    })
    .sort((a, b) => b.commission - a.commission);

  const data = {
    period,
    aggregate: {
      transactions: currentMetrics.handled,
      success: `${currentMetrics.successRate.toFixed(1)}%`,
      commission: formatUsd(currentMetrics.commission),
      trendDelta: `${trendDelta >= 0 ? '+' : ''}${trendDelta.toFixed(1)}%`,
    },
    trend,
    members,
  };

  writeCache(cacheKey, data);
  return data;
}

export function canViewTeamPerformance(roles = [], permissions = []) {
  return (
    permissions.includes('view_team_performance') ||
    roles.includes('super-admin') ||
    roles.includes('sub-admin')
  );
}
