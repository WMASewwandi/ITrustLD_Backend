import { getDbDriver, query } from '../config/database.js';
import { getAllSystemUsers } from './systemUser.service.js';
import {
  addColomboDays,
  colomboLocalToDate,
  formatDateTimeDisplaySl,
  formatTimestampSl,
  formatYmdColombo,
  getColomboDateParts,
  startOfColomboDay,
  startOfColomboWeek,
} from '../utils/slTime.js';

const COMMISSION_BASE_TX = 1000;
const COMMISSION_STEP_TX = 500;
const COMMISSION_STEP_AMOUNT = 5000;
const CACHE_TTL_MS = 30_000;
const cache = new Map();

const PERIOD_LABELS = {
  daily: { current: 'today', previous: 'yesterday' },
  weekly: { current: 'this week', previous: 'last week' },
  monthly: { current: 'this cycle (25–24)', previous: 'last cycle (25–24)' },
  custom: { current: 'selected range', previous: 'previous range' },
};

function normalizePeriod(period) {
  const value = String(period || 'weekly').toLowerCase();
  if (value === 'daily' || value === 'weekly' || value === 'monthly' || value === 'custom') {
    return value;
  }
  return 'weekly';
}

function parseYmd(value) {
  const match = String(value || '')
    .trim()
    .match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

/** Commission month: 25th 00:00 SL through next month 24th (next 25th exclusive). */
function getCommissionMonthWindow(now = new Date(), offset = 0) {
  const parts = getColomboDateParts(now);
  let startYear = parts.year;
  let startMonth = parts.month;
  if (parts.day < 25) {
    startMonth -= 1;
    if (startMonth < 1) {
      startMonth = 12;
      startYear -= 1;
    }
  }
  startMonth -= offset;
  while (startMonth <= 0) {
    startMonth += 12;
    startYear -= 1;
  }
  while (startMonth > 12) {
    startMonth -= 12;
    startYear += 1;
  }
  const start = colomboLocalToDate({ year: startYear, month: startMonth, day: 25 });
  let endMonth = startMonth + 1;
  let endYear = startYear;
  if (endMonth > 12) {
    endMonth = 1;
    endYear += 1;
  }
  const end = colomboLocalToDate({ year: endYear, month: endMonth, day: 25 });
  return { start, end };
}

function getPeriodWindow(period, offset = 0, range = {}) {
  const now = new Date();
  if (period === 'custom') {
    const fromParts = parseYmd(range.from);
    const toParts = parseYmd(range.to);
    const start = fromParts
      ? colomboLocalToDate(fromParts)
      : getCommissionMonthWindow(now, 0).start;
    let end = toParts
      ? addColomboDays(colomboLocalToDate(toParts), 1)
      : addColomboDays(startOfColomboDay(now), 1);
    if (end <= start) {
      end = addColomboDays(start, 1);
    }
    if (offset === 1) {
      const ms = end.getTime() - start.getTime();
      return { start: new Date(start.getTime() - ms), end: start };
    }
    return { start, end };
  }
  if (period === 'daily') {
    const start = addColomboDays(startOfColomboDay(now), -offset);
    return { start, end: addColomboDays(start, 1) };
  }
  if (period === 'weekly') {
    const start = addColomboDays(startOfColomboWeek(now), -7 * offset);
    return { start, end: addColomboDays(start, 7) };
  }
  return getCommissionMonthWindow(now, offset);
}

function rangePayload(window) {
  return {
    from: formatYmdColombo(window.start),
    to: formatYmdColombo(addColomboDays(window.end, -1)),
  };
}

/**
 * [((X - 1000) / 500) + 1] * 5000
 * Below 1000 txs: 0. Then 5000, 10000, 15000… every 500 txs.
 */
export function calculateCommission(transactionCount) {
  const x = Math.max(0, Math.floor(Number(transactionCount) || 0));
  if (x < COMMISSION_BASE_TX) return 0;
  return (Math.floor((x - COMMISSION_BASE_TX) / COMMISSION_STEP_TX) + 1) * COMMISSION_STEP_AMOUNT;
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

function emptyTypeStats() {
  return { completed: 0, rejected: 0, handleSeconds: 0, buckets: {} };
}

function sqlHandleSeconds(decisionColumn = null) {
  const endExpr = decisionColumn ? `COALESCE(${decisionColumn}, updated_at)` : 'updated_at';
  if (getDbDriver() === 'sqlite') {
    return `MAX(CAST((julianday(${endExpr}) - julianday(created_at)) * 86400 AS INTEGER), 0)`;
  }
  return `GREATEST(COALESCE(TIMESTAMPDIFF(SECOND, created_at, ${endExpr}), 0), 0)`;
}

export function formatHandleDuration(totalSeconds) {
  const seconds = Math.max(0, Math.round(Number(totalSeconds) || 0));
  if (!seconds) return '—';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (days > 0) return hours ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0) return rest && minutes < 10 ? `${minutes}m ${rest}s` : `${minutes}m`;
  return `${rest}s`;
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
  const handleSeconds =
    (Number(deposits.handleSeconds) || 0) +
    (Number(withdrawals.handleSeconds) || 0) +
    (Number(loyalty.handleSeconds) || 0);
  const avgHandleSeconds = handled ? handleSeconds / handled : 0;
  const successRate = handled ? (completed / handled) * 100 : 0;
  const commission = calculateCommission(handled);

  return {
    handled,
    completed,
    rejected,
    handleSeconds,
    avgHandleSeconds,
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

function formatHandleTimeDelta(currentSeconds, previousSeconds) {
  if (!previousSeconds) return 'Avg create → status update';
  const diff = Math.round((Number(currentSeconds) || 0) - (Number(previousSeconds) || 0));
  if (!diff) return 'Same handle time vs last period';
  const faster = diff < 0;
  return `${faster ? '' : '+'}${formatHandleDuration(Math.abs(diff))} ${faster ? 'faster' : 'slower'} vs last period`;
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
  const totalCommission = metrics.commission || 0;
  return rows.map((row) => {
    const count = row.stats.completed + row.stats.rejected;
    const pct = Math.round((count / totalHandled) * 100);
    const share = metrics.handled ? (count / metrics.handled) * totalCommission : 0;
    return {
      label: row.label,
      count,
      pct,
      commission: formatUsd(share),
    };
  });
}

function buildTrend(period, bucketMaps, window) {
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

  const resolvedWindow = window || getPeriodWindow(period, 0);

  if (period === 'weekly') {
    const labels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const values = labels.map((_, index) => {
      const day = addColomboDays(resolvedWindow.start, index);
      return merged[formatYmdColombo(day)] || 0;
    });
    return {
      labels,
      values,
      subtitle: 'Daily volume — current week',
    };
  }

  const dayCount = Math.max(
    1,
    Math.round((resolvedWindow.end.getTime() - resolvedWindow.start.getTime()) / 86400000),
  );
  const rangeLabel = `${formatYmdColombo(resolvedWindow.start)} to ${formatYmdColombo(addColomboDays(resolvedWindow.end, -1))}`;

  if (period === 'custom' && dayCount <= 16) {
    const labels = [];
    const values = [];
    for (let i = 0; i < dayCount; i += 1) {
      const day = addColomboDays(resolvedWindow.start, i);
      const parts = getColomboDateParts(day);
      labels.push(`${parts.day}/${parts.month}`);
      values.push(merged[formatYmdColombo(day)] || 0);
    }
    return {
      labels,
      values,
      subtitle: `Daily volume — ${rangeLabel}`,
    };
  }

  const weekCount = Math.min(8, Math.max(1, Math.ceil(dayCount / 7)));
  const labels = [];
  const values = [];
  for (let i = 0; i < weekCount; i += 1) {
    labels.push(`W${i + 1}`);
    const weekStart = addColomboDays(resolvedWindow.start, i * 7);
    const weekEnd = addColomboDays(weekStart, 7);
    let sum = 0;
    for (const [key, val] of Object.entries(merged)) {
      const parts = parseYmd(key);
      if (!parts) continue;
      const day = colomboLocalToDate(parts);
      if (day >= weekStart && day < weekEnd && day < resolvedWindow.end) {
        sum += val;
      }
    }
    values.push(sum);
  }

  return {
    labels,
    values,
    subtitle:
      period === 'monthly'
        ? `Weekly volume — commission cycle (25–24)`
        : `Weekly volume — ${rangeLabel}`,
  };
}

function bucketExpr(period) {
  if (period === 'daily') return sqlHour('updated_at');
  return sqlDate('updated_at');
}

async function fetchGroupedActions({ adminId, start, end, period }) {
  const startSql = toSqlDate(start);
  const endSql = toSqlDate(end);
  const bucket = bucketExpr(period);
  const adminCompletedFilter = adminId ? 'AND approved_by_admin = ?' : '';
  const adminRejectedFilter = adminId ? 'AND rejected_by_admin = ?' : '';

  const sql = `
    SELECT source, outcome, admin_id, bucket_key,
           COUNT(*) AS total,
           COALESCE(SUM(handle_seconds), 0) AS handle_seconds
    FROM (
      SELECT 'deposits' AS source,
             'completed' AS outcome,
             approved_by_admin AS admin_id,
             ${bucket} AS bucket_key,
             ${sqlHandleSeconds('approved_date')} AS handle_seconds
      FROM deposits
      WHERE transaction_status = 'Completed'
        AND approved_by_admin IS NOT NULL
        AND updated_at >= ? AND updated_at < ?
        ${adminCompletedFilter}

      UNION ALL

      SELECT 'deposits', 'rejected', rejected_by_admin, ${bucket},
             ${sqlHandleSeconds('rejected_date')}
      FROM deposits
      WHERE transaction_status = 'Rejected'
        AND rejected_by_admin IS NOT NULL
        AND updated_at >= ? AND updated_at < ?
        ${adminRejectedFilter}

      UNION ALL

      SELECT 'withdrawals', 'completed', approved_by_admin, ${bucket},
             ${sqlHandleSeconds('approved_date')}
      FROM withdrawals
      WHERE transaction_status = 'Completed'
        AND approved_by_admin IS NOT NULL
        AND updated_at >= ? AND updated_at < ?
        ${adminCompletedFilter}

      UNION ALL

      SELECT 'withdrawals', 'rejected', rejected_by_admin, ${bucket},
             ${sqlHandleSeconds('rejected_date')}
      FROM withdrawals
      WHERE transaction_status = 'Rejected'
        AND rejected_by_admin IS NOT NULL
        AND updated_at >= ? AND updated_at < ?
        ${adminRejectedFilter}

      UNION ALL

      SELECT 'loyalty', 'completed', approved_by_admin, ${bucket},
             ${sqlHandleSeconds()}
      FROM point_withdrawals
      WHERE status = 'Approved'
        AND approved_by_admin IS NOT NULL
        AND updated_at >= ? AND updated_at < ?
        ${adminCompletedFilter}

      UNION ALL

      SELECT 'loyalty', 'rejected', rejected_by_admin, ${bucket},
             ${sqlHandleSeconds()}
      FROM point_withdrawals
      WHERE status = 'Rejected'
        AND rejected_by_admin IS NOT NULL
        AND updated_at >= ? AND updated_at < ?
        ${adminRejectedFilter}

      UNION ALL

      SELECT 'loyalty', 'completed', approved_by_admin, ${bucket},
             ${sqlHandleSeconds()}
      FROM loyalty_bonus_collects
      WHERE status = 'Approved'
        AND approved_by_admin IS NOT NULL
        AND updated_at >= ? AND updated_at < ?
        ${adminCompletedFilter}

      UNION ALL

      SELECT 'loyalty', 'rejected', rejected_by_admin, ${bucket},
             ${sqlHandleSeconds()}
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
    stats[source].handleSeconds += Number(row.handle_seconds) || 0;

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

function buildResponseFromStats(period, currentStats, previousStats, audit = {}, window) {
  const currentMetrics = buildMetrics(currentStats);
  const previousMetrics = buildMetrics(previousStats);
  const resolvedWindow = window || getPeriodWindow(period, 0);

  return {
    period,
    range: rangePayload(resolvedWindow),
    metrics: {
      handled: currentMetrics.handled,
      handledDelta: formatDelta(currentMetrics.handled, previousMetrics.handled, period),
      successRate: `${currentMetrics.successRate.toFixed(1)}%`,
      successDelta: formatPercentDelta(currentMetrics.successRate, previousMetrics.successRate),
      avgHandleTime: formatHandleDuration(currentMetrics.avgHandleSeconds),
      avgHandleSeconds: Math.round(currentMetrics.avgHandleSeconds),
      handleTimeDelta: formatHandleTimeDelta(
        currentMetrics.avgHandleSeconds,
        previousMetrics.avgHandleSeconds,
      ),
      commission: formatUsd(currentMetrics.commission),
      commissionDelta: formatMoneyDelta(currentMetrics.commission, previousMetrics.commission),
      commissionHint:
        currentMetrics.handled < COMMISSION_BASE_TX
          ? `${currentMetrics.handled} txs · $0 until 1,000`
          : `${currentMetrics.handled} txs · $5,000 per 500 after 1,000`,
    },
    trend: buildTrend(period, [currentStats.buckets], resolvedWindow),
    breakdown: buildBreakdown(currentMetrics),
    audit: {
      by: audit.by || 'System',
      at: audit.at || formatDateTimeDisplaySl(new Date()),
    },
  };
}

async function loadStatsForWindow(adminId, period, offset, range = {}) {
  const { start, end } = getPeriodWindow(period, offset, range);
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

export async function getMyPerformance(userId, periodInput, auditUser = {}, range = {}) {
  const period = normalizePeriod(periodInput);
  const cacheKey = `me:${userId}:${period}:${range.from || ''}:${range.to || ''}`;
  const cached = readCache(cacheKey);
  if (cached) return cached;

  const window = getPeriodWindow(period, 0, range);
  const [currentStats, previousStats] = await Promise.all([
    loadStatsForWindow(userId, period, 0, range),
    loadStatsForWindow(userId, period, 1, range),
  ]);

  const data = buildResponseFromStats(
    period,
    currentStats,
    previousStats,
    {
      by: auditUser.name || auditUser.email || 'You',
      at: formatDateTimeDisplaySl(new Date()),
    },
    window,
  );

  writeCache(cacheKey, data);
  return data;
}

export async function getTeamPerformance(periodInput, range = {}) {
  const period = normalizePeriod(periodInput);
  const cacheKey = `team:${period}:${range.from || ''}:${range.to || ''}`;
  const cached = readCache(cacheKey);
  if (cached) return cached;

  const window = getPeriodWindow(period, 0, range);
  const [currentByAdmin, previousByAdmin, users] = await Promise.all([
    loadStatsForWindow(null, period, 0, range),
    loadStatsForWindow(null, period, 1, range),
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
    aggregateCurrent.deposits.handleSeconds += stats.deposits.handleSeconds;
    aggregateCurrent.withdrawals.completed += stats.withdrawals.completed;
    aggregateCurrent.withdrawals.rejected += stats.withdrawals.rejected;
    aggregateCurrent.withdrawals.handleSeconds += stats.withdrawals.handleSeconds;
    aggregateCurrent.loyalty.completed += stats.loyalty.completed;
    aggregateCurrent.loyalty.rejected += stats.loyalty.rejected;
    aggregateCurrent.loyalty.handleSeconds += stats.loyalty.handleSeconds;
    mergeBucketMaps(aggregateCurrent.buckets, stats.buckets);
  }

  for (const stats of previousByAdmin.values()) {
    aggregatePrevious.deposits.completed += stats.deposits.completed;
    aggregatePrevious.deposits.rejected += stats.deposits.rejected;
    aggregatePrevious.deposits.handleSeconds += stats.deposits.handleSeconds;
    aggregatePrevious.withdrawals.completed += stats.withdrawals.completed;
    aggregatePrevious.withdrawals.rejected += stats.withdrawals.rejected;
    aggregatePrevious.withdrawals.handleSeconds += stats.withdrawals.handleSeconds;
    aggregatePrevious.loyalty.completed += stats.loyalty.completed;
    aggregatePrevious.loyalty.rejected += stats.loyalty.rejected;
    aggregatePrevious.loyalty.handleSeconds += stats.loyalty.handleSeconds;
  }

  const currentMetrics = buildMetrics(aggregateCurrent);
  const previousMetrics = buildMetrics(aggregatePrevious);
  const trend = buildTrend(period, [aggregateCurrent.buckets], window);

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
        avgHandleTime: formatHandleDuration(metrics.avgHandleSeconds),
        avgHandleSeconds: Math.round(metrics.avgHandleSeconds),
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

  const memberCommissionTotal = members.reduce((sum, member) => sum + member.commission, 0);

  const data = {
    period,
    range: rangePayload(window),
    aggregate: {
      transactions: currentMetrics.handled,
      success: `${currentMetrics.successRate.toFixed(1)}%`,
      avgHandleTime: formatHandleDuration(currentMetrics.avgHandleSeconds),
      avgHandleSeconds: Math.round(currentMetrics.avgHandleSeconds),
      handleTimeDelta: formatHandleTimeDelta(
        currentMetrics.avgHandleSeconds,
        previousMetrics.avgHandleSeconds,
      ),
      commission: formatUsd(memberCommissionTotal),
      commissionHint:
        memberCommissionTotal > 0
          ? `${currentMetrics.handled} txs · $5,000 per 500 after 1,000 (per admin)`
          : `${currentMetrics.handled} txs · $0 until 1,000 per admin`,
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
