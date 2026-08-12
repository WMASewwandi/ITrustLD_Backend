import { getDbDriver, query } from '../config/database.js';
import {
  addColomboDays,
  colomboLocalToDate,
  formatTimestampSl,
  formatYmdColombo,
  getColomboDateParts,
  parseDateWindow,
  yearRangeEndSl,
  yearRangeStartSl,
} from '../utils/slTime.js';
import { resolveWalletLogoPublicUrl } from './walletLogoStorage.service.js';

const PLATFORM_META = {
  1: { name: 'XM', letter: 'X', bg: '#F59E0B', isUsdt: false },
  2: { name: 'Skrill', letter: 'S', bg: '#862165', isUsdt: false },
  3: { name: 'Neteller', letter: 'N', bg: '#6BBE45', isUsdt: false },
  4: { name: 'Perfect Money', letter: 'P', bg: '#E11D48', isUsdt: false },
  5: { name: 'USDT', letter: '₮', bg: '#26A17B', isUsdt: true },
};

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const DASHBOARD_CACHE_TTL_MS = 90_000;
const PLATFORMS_CACHE_TTL_MS = 180_000;
const DEFAULT_DASHBOARD_FILTER = 'currentyear';
const dashboardCacheMap = new Map();
let platformsAllTimeCache = { data: null, expiresAt: 0, version: 0 };
const PLATFORMS_CACHE_VERSION = 3;
let dashboardIndexesReady = false;

function readDashboardCache(key) {
  const hit = dashboardCacheMap.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    dashboardCacheMap.delete(key);
    return null;
  }
  return hit.data;
}

function writeDashboardCache(key, data) {
  dashboardCacheMap.set(key, { data, expiresAt: Date.now() + DASHBOARD_CACHE_TTL_MS });
  // Keep the map small — period filters reuse a handful of keys.
  if (dashboardCacheMap.size > 24) {
    const oldest = dashboardCacheMap.keys().next().value;
    dashboardCacheMap.delete(oldest);
  }
}

async function ensureDashboardIndexes() {
  if (dashboardIndexesReady || getDbDriver() !== 'mysql') {
    dashboardIndexesReady = true;
    return;
  }
  dashboardIndexesReady = true;
  try {
    await query(
      `CREATE INDEX idx_deposits_status_created ON deposits (transaction_status, created_at)`,
    );
  } catch {
    /* already exists or insufficient privileges */
  }
  try {
    await query(
      `CREATE INDEX idx_withdrawals_status_created ON withdrawals (transaction_status, created_at)`,
    );
  } catch {
    /* already exists or insufficient privileges */
  }
}

function sqlMonth(column) {
  return getDbDriver() === 'sqlite'
    ? `CAST(strftime('%m', ${column}) AS INTEGER)`
    : `MONTH(${column})`;
}

function sqlYear(column) {
  return getDbDriver() === 'sqlite'
    ? `CAST(strftime('%Y', ${column}) AS INTEGER)`
    : `YEAR(${column})`;
}

function sqlDayOfMonth(column) {
  return getDbDriver() === 'sqlite'
    ? `CAST(strftime('%d', ${column}) AS INTEGER)`
    : `DAYOFMONTH(${column})`;
}

function yearRangeStart(year) {
  return yearRangeStartSl(year);
}

function yearRangeEnd(year) {
  return yearRangeEndSl(year);
}

function percentChange(current, previous) {
  if (previous !== 0) {
    return ((current - previous) / previous) * 100;
  }
  if (current > 0) return 100;
  return 0;
}

function calcGrowthPercentage(currentYearTotal, lastYearTotal) {
  if (lastYearTotal === 0 && currentYearTotal === 0) return 0;
  if (lastYearTotal === 0) return 100;
  if (currentYearTotal === 0) return -100;
  return ((currentYearTotal - lastYearTotal) / lastYearTotal) * 100;
}

function buildDepositDateFilter(filter, fromDate, toDate) {
  if (!filter) return { conditions: [], values: [] };

  const column = 'created_at';
  const period = resolveDashboardPeriod(filter, fromDate, toDate);
  const conditions = [];
  const values = [];

  if (period.periodStart) {
    conditions.push(`${column} >= ?`);
    values.push(period.periodStart);
  }
  if (period.periodEnd) {
    conditions.push(`${column} < ?`);
    values.push(period.periodEnd);
  }

  return { conditions, values };
}

function resolveDashboardPeriodLabel(filter, fromDate, toDate, parts) {
  const year = parts.year;
  switch (filter) {
    case 'today':
      return 'Today';
    case 'yesterday':
      return 'Yesterday';
    case 'last7days':
      return 'Last 7 days';
    case 'lastmonth':
      return 'Last 30 days';
    case 'last6months':
      return 'Last 6 months';
    case 'lastyear':
      return String(year - 1);
    case 'customdate':
      if (fromDate && toDate) {
        return `${fromDate} – ${toDate}`;
      }
      return 'Custom range';
    case 'currentyear':
    default:
      return String(year);
  }
}

function resolveDashboardPeriod(filter = DEFAULT_DASHBOARD_FILTER, fromDate, toDate) {
  const parts = getColomboDateParts();
  const year = parts.year;
  const f = String(filter || DEFAULT_DASHBOARD_FILTER).trim() || DEFAULT_DASHBOARD_FILTER;

  let periodStart = null;
  let periodEnd = null;
  let compareStart = null;
  let compareEnd = null;
  let chartMode = 'monthly';

  if (f === 'currentyear') {
    periodStart = yearRangeStart(year);
    periodEnd = yearRangeEnd(year);
    compareStart = yearRangeStart(year - 1);
    compareEnd = yearRangeEnd(year - 1);
    chartMode = 'monthly';
  } else if (f === 'lastyear') {
    periodStart = yearRangeStart(year - 1);
    periodEnd = yearRangeEnd(year - 1);
    compareStart = yearRangeStart(year - 2);
    compareEnd = yearRangeEnd(year - 2);
    chartMode = 'monthly';
  } else if (f === 'customdate' && fromDate && toDate) {
    const [y, m, d] = String(fromDate).slice(0, 10).split('-').map(Number);
    const from = colomboLocalToDate({ year: y, month: m, day: d });
    const [y2, m2, d2] = String(toDate).slice(0, 10).split('-').map(Number);
    const toExclusive = addColomboDays(
      colomboLocalToDate({ year: y2, month: m2, day: d2 }),
      1,
    );
    periodStart = formatTimestampSl(from);
    periodEnd = formatTimestampSl(toExclusive);
    const dayCount = Math.max(
      1,
      Math.round((toExclusive.getTime() - from.getTime()) / (24 * 60 * 60 * 1000)),
    );
    chartMode = dayCount <= 31 ? 'daily' : 'monthly';
    compareStart = formatTimestampSl(addColomboDays(from, -dayCount));
    compareEnd = periodStart;
  } else {
    const window = parseDateWindow(f, fromDate, toDate);
    if (window.from) {
      periodStart = formatTimestampSl(window.from);
    }
    if (window.to) {
      periodEnd = formatTimestampSl(window.to);
    } else {
      periodEnd = formatTimestampSl(addColomboDays(new Date(), 1));
    }

    if (f === 'today' || f === 'yesterday') {
      chartMode = 'daily';
      const fromDateObj = window.from;
      compareStart = formatTimestampSl(addColomboDays(fromDateObj, -1));
      compareEnd = periodStart;
    } else if (f === 'last7days' || f === 'lastmonth') {
      chartMode = 'daily';
      const fromDateObj = window.from;
      const spanDays = f === 'last7days' ? 7 : 30;
      compareStart = formatTimestampSl(addColomboDays(fromDateObj, -spanDays));
      compareEnd = periodStart;
    } else if (f === 'last6months') {
      chartMode = 'monthly';
      const fromDateObj = window.from;
      compareStart = formatTimestampSl(addColomboDays(fromDateObj, -180));
      compareEnd = periodStart;
    }
  }

  return {
    filter: f,
    year,
    month: parts.month,
    day: parts.day,
    periodStart,
    periodEnd,
    compareStart,
    compareEnd,
    chartMode,
    periodLabel: resolveDashboardPeriodLabel(f, fromDate, toDate, parts),
  };
}

function periodWhereClause(column, periodStart, periodEnd) {
  const conditions = [];
  const values = [];
  if (periodStart) {
    conditions.push(`${column} >= ?`);
    values.push(periodStart);
  }
  if (periodEnd) {
    conditions.push(`${column} < ?`);
    values.push(periodEnd);
  }
  return { conditions, values };
}

function buildTransactionDateFilter(filter, fromDate, toDate) {
  if (!filter) return { conditions: [], values: [] };

  const period = resolveDashboardPeriod(filter, fromDate, toDate);
  const column = 'd.created_at';
  const conditions = [];
  const values = [];

  if (period.periodStart) {
    conditions.push(`${column} >= ?`);
    values.push(period.periodStart);
  }
  if (period.periodEnd) {
    conditions.push(`${column} < ?`);
    values.push(period.periodEnd);
  }

  return { conditions, values };
}

async function sumCompletedAmount(table, amountColumn, extraWhere = '', params = []) {
  const rows = await query(
    `SELECT COALESCE(SUM(${amountColumn}), 0) AS total
     FROM ${table}
     WHERE transaction_status = 'Completed' ${extraWhere}`,
    params,
  );
  return Number(rows[0]?.total) || 0;
}

function buildDailySeries(byDay, year, month) {
  const lastDay = new Date(year, month, 0).getDate();
  const values = [];
  for (let day = 1; day <= lastDay; day += 1) {
    values.push(Number(byDay[day]) || 0);
  }
  return values;
}

function parsePeriodStartDate(periodStart) {
  const raw = String(periodStart || '').slice(0, 10);
  const [year, month, day] = raw.split('-').map(Number);
  return colomboLocalToDate({ year, month, day });
}

function eachDayInPeriod(periodStart, periodEnd) {
  const days = [];
  let cursor = parsePeriodStartDate(periodStart);
  const endMs = parsePeriodStartDate(periodEnd).getTime();
  while (cursor.getTime() < endMs) {
    days.push(formatYmdColombo(cursor));
    cursor = addColomboDays(cursor, 1);
  }
  return days;
}

function eachMonthInPeriod(periodStart, periodEnd, filter, year) {
  if (filter === 'currentyear' || filter === 'lastyear') {
    return MONTH_NAMES.map((name, index) => ({
      key: String(index + 1),
      label: MONTH_NAMES[index].slice(0, 3),
      month: index + 1,
      year: filter === 'lastyear' ? year - 1 : year,
    }));
  }

  const months = [];
  let cursor = parsePeriodStartDate(periodStart);
  const endMs = parsePeriodStartDate(periodEnd).getTime();
  while (cursor.getTime() < endMs) {
    const parts = getColomboDateParts(cursor);
    const key = `${parts.year}-${String(parts.month).padStart(2, '0')}`;
    if (!months.some((m) => m.key === key)) {
      months.push({
        key,
        label: MONTH_NAMES[parts.month - 1]?.slice(0, 3) || key,
        month: parts.month,
        year: parts.year,
      });
    }
    let nextMonth = parts.month + 1;
    let nextYear = parts.year;
    if (nextMonth > 12) {
      nextMonth = 1;
      nextYear += 1;
    }
    cursor = colomboLocalToDate({ year: nextYear, month: nextMonth, day: 1 });
  }
  return months;
}

function buildRevenueSeries(depositByDay, depositByMonth, period, chartMode) {
  if (chartMode === 'daily') {
    const dayKeys = eachDayInPeriod(period.periodStart, period.periodEnd);
    const labels = dayKeys.map((key) => {
      const [, m, d] = key.split('-');
      return `${m}/${d}`;
    });
    const values = dayKeys.map((key) => (depositByDay[key] || 0) / 1000);
    return { labels, values };
  }

  const monthBuckets = eachMonthInPeriod(
    period.periodStart,
    period.periodEnd,
    period.filter,
    period.year,
  );
  const labels = monthBuckets.map((b) => b.label);
  const values = monthBuckets.map((b) => {
    const total = depositByMonth[`${b.year}-${b.month}`] || 0;
    return total / 1000;
  });
  return { labels, values };
}

/** Real LKR profit = LKR received on deposits − LKR paid on withdrawals (Completed only). */
function buildProfitSeries(profitByDay, profitByMonth, period, chartMode) {
  if (chartMode === 'daily') {
    const dayKeys = eachDayInPeriod(period.periodStart, period.periodEnd);
    return dayKeys.map((key) => Number(profitByDay[key]) || 0);
  }
  return eachMonthInPeriod(
    period.periodStart,
    period.periodEnd,
    period.filter,
    period.year,
  ).map((b) => Number(profitByMonth[`${b.year}-${b.month}`]) || 0);
}

function accumulateGroupedRows(rows, { byDay, amountKey, dayMap, monthMap }) {
  let total = 0;
  for (const row of rows) {
    const rowYear = Number(row.yr);
    const rowMonth = Number(row.mo);
    const amount = Number(row[amountKey]) || 0;
    total += amount;
    const monthKey = `${rowYear}-${rowMonth}`;
    monthMap[monthKey] = (monthMap[monthKey] || 0) + amount;
    if (byDay) {
      const rowDay = Number(row.dy);
      const dayKey = `${rowYear}-${String(rowMonth).padStart(2, '0')}-${String(rowDay).padStart(2, '0')}`;
      dayMap[dayKey] = (dayMap[dayKey] || 0) + amount;
    }
  }
  return total;
}

async function fetchDepositsGrouped(periodStart, periodEnd, { byDay = true } = {}) {
  const yearExpr = sqlYear('created_at');
  const monthExpr = sqlMonth('created_at');
  const dayExpr = sqlDayOfMonth('created_at');
  const { conditions, values } = periodWhereClause('created_at', periodStart, periodEnd);
  const whereSql = conditions.length ? `AND ${conditions.join(' AND ')}` : '';

  const selectDay = byDay ? `, ${dayExpr} AS dy` : '';
  const groupDay = byDay ? ', dy' : '';

  const rows = await query(
    `SELECT ${yearExpr} AS yr,
            ${monthExpr} AS mo
            ${selectDay},
            COALESCE(SUM(deposit_amount), 0) AS total_deposit,
            COALESCE(SUM(
              CASE
                WHEN UPPER(TRIM(COALESCE(payment_amount_currency, ''))) = 'LKR'
                THEN payment_amount
                ELSE 0
              END
            ), 0) AS total_payment_lkr
     FROM deposits
     WHERE transaction_status = 'Completed'
     ${whereSql}
     GROUP BY yr, mo${groupDay}`,
    values,
  );

  const depositByDay = {};
  const depositByMonth = {};
  const paymentLkrByDay = {};
  const paymentLkrByMonth = {};

  const total = accumulateGroupedRows(rows, {
    byDay,
    amountKey: 'total_deposit',
    dayMap: depositByDay,
    monthMap: depositByMonth,
  });
  accumulateGroupedRows(rows, {
    byDay,
    amountKey: 'total_payment_lkr',
    dayMap: paymentLkrByDay,
    monthMap: paymentLkrByMonth,
  });

  return {
    total,
    depositByDay,
    depositByMonth,
    paymentLkrByDay,
    paymentLkrByMonth,
  };
}

async function fetchWithdrawalsLkrGrouped(periodStart, periodEnd, { byDay = true } = {}) {
  const yearExpr = sqlYear('created_at');
  const monthExpr = sqlMonth('created_at');
  const dayExpr = sqlDayOfMonth('created_at');
  const { conditions, values } = periodWhereClause('created_at', periodStart, periodEnd);
  const whereSql = conditions.length ? `AND ${conditions.join(' AND ')}` : '';

  const selectDay = byDay ? `, ${dayExpr} AS dy` : '';
  const groupDay = byDay ? ', dy' : '';

  const rows = await query(
    `SELECT ${yearExpr} AS yr,
            ${monthExpr} AS mo
            ${selectDay},
            COALESCE(SUM(
              CASE
                WHEN UPPER(TRIM(COALESCE(receiving_amount_currency, ''))) = 'LKR'
                THEN receiving_amount
                ELSE 0
              END
            ), 0) AS total_receiving_lkr
     FROM withdrawals
     WHERE transaction_status = 'Completed'
     ${whereSql}
     GROUP BY yr, mo${groupDay}`,
    values,
  );

  const receivingLkrByDay = {};
  const receivingLkrByMonth = {};
  accumulateGroupedRows(rows, {
    byDay,
    amountKey: 'total_receiving_lkr',
    dayMap: receivingLkrByDay,
    monthMap: receivingLkrByMonth,
  });

  return { receivingLkrByDay, receivingLkrByMonth };
}

function mergeProfitMaps(paymentByDay, paymentByMonth, receivingByDay, receivingByMonth) {
  const profitByDay = {};
  const profitByMonth = {};
  const dayKeys = new Set([
    ...Object.keys(paymentByDay || {}),
    ...Object.keys(receivingByDay || {}),
  ]);
  for (const key of dayKeys) {
    profitByDay[key] = (Number(paymentByDay[key]) || 0) - (Number(receivingByDay[key]) || 0);
  }
  const monthKeys = new Set([
    ...Object.keys(paymentByMonth || {}),
    ...Object.keys(receivingByMonth || {}),
  ]);
  for (const key of monthKeys) {
    profitByMonth[key] =
      (Number(paymentByMonth[key]) || 0) - (Number(receivingByMonth[key]) || 0);
  }
  return { profitByDay, profitByMonth };
}

async function fetchDepositTotalInPeriod(periodStart, periodEnd) {
  if (!periodStart && !periodEnd) return 0;
  const { conditions, values } = periodWhereClause('created_at', periodStart, periodEnd);
  const where = conditions.length ? `AND ${conditions.join(' AND ')}` : '';
  return sumCompletedAmount('deposits', 'deposit_amount', where, values);
}

async function fetchDepositsDashboardBundle(period, { includeDaily = true } = {}) {
  const needDailySparkline = includeDaily && period.filter === DEFAULT_DASHBOARD_FILTER;
  const byDay = period.chartMode === 'daily';
  const canMergeCompare =
    !byDay &&
    (period.filter === 'currentyear' || period.filter === 'lastyear') &&
    period.compareStart &&
    period.compareEnd;

  const primaryStart = canMergeCompare ? period.compareStart : period.periodStart;
  const primaryEnd = period.periodEnd;

  const tasks = [
    fetchDepositsGrouped(primaryStart, primaryEnd, { byDay }),
    fetchWithdrawalsLkrGrouped(primaryStart, primaryEnd, { byDay }),
  ];

  if (!canMergeCompare) {
    tasks.push(fetchDepositTotalInPeriod(period.compareStart, period.compareEnd));
  } else {
    tasks.push(Promise.resolve(null));
  }

  if (!byDay && needDailySparkline) {
    // Include previous calendar day so day-1 DoD uses real yesterday profit.
    const monthStartDate = colomboLocalToDate({ year: period.year, month: period.month, day: 1 });
    const sparkStart = formatTimestampSl(addColomboDays(monthStartDate, -1));
    const nextMonth =
      period.month === 12
        ? { year: period.year + 1, month: 1 }
        : { year: period.year, month: period.month + 1 };
    const monthEnd = formatTimestampSl(
      colomboLocalToDate({ year: nextMonth.year, month: nextMonth.month, day: 1 }),
    );
    tasks.push(fetchDepositsGrouped(sparkStart, monthEnd, { byDay: true }));
    tasks.push(fetchWithdrawalsLkrGrouped(sparkStart, monthEnd, { byDay: true }));
  } else {
    tasks.push(Promise.resolve(null));
    tasks.push(Promise.resolve(null));
  }

  const [
    primaryGrouped,
    primaryWithdrawals,
    compareFallback,
    dailyGrouped,
    dailyWithdrawals,
  ] = await Promise.all(tasks);

  if (canMergeCompare) {
    let periodTotal = 0;
    let compareTotal = 0;
    const depositByMonth = {};
    const paymentLkrByMonth = { ...primaryGrouped.paymentLkrByMonth };
    const receivingLkrByMonth = { ...primaryWithdrawals.receivingLkrByMonth };
    const periodYear = period.filter === 'lastyear' ? period.year - 1 : period.year;
    const compareYear = periodYear - 1;

    for (const [monthKey, amount] of Object.entries(primaryGrouped.depositByMonth)) {
      const y = Number(String(monthKey).split('-')[0]);
      if (y === periodYear) {
        periodTotal += amount;
        depositByMonth[monthKey] = amount;
      } else if (y === compareYear) {
        compareTotal += amount;
      }
    }

    const dailyProfitMaps = mergeProfitMaps(
      dailyGrouped?.paymentLkrByDay || {},
      {},
      dailyWithdrawals?.receivingLkrByDay || {},
      {},
    );

    return {
      total: periodTotal,
      compareTotal,
      depositByDay: dailyGrouped?.depositByDay || {},
      depositByMonth,
      paymentLkrByDay: dailyGrouped?.paymentLkrByDay || {},
      paymentLkrByMonth,
      receivingLkrByDay: dailyWithdrawals?.receivingLkrByDay || {},
      receivingLkrByMonth,
      profitByDay: dailyProfitMaps.profitByDay,
      profitByMonth: mergeProfitMaps({}, paymentLkrByMonth, {}, receivingLkrByMonth).profitByMonth,
    };
  }

  const profitMaps = mergeProfitMaps(
    byDay ? primaryGrouped.paymentLkrByDay : dailyGrouped?.paymentLkrByDay || {},
    primaryGrouped.paymentLkrByMonth,
    byDay ? primaryWithdrawals.receivingLkrByDay : dailyWithdrawals?.receivingLkrByDay || {},
    primaryWithdrawals.receivingLkrByMonth,
  );

  // When monthly chart + daily sparkline, month profit uses primary maps; day uses sparkline maps.
  const sparkProfit = mergeProfitMaps(
    dailyGrouped?.paymentLkrByDay || {},
    {},
    dailyWithdrawals?.receivingLkrByDay || {},
    {},
  );

  return {
    total: primaryGrouped.total,
    compareTotal: compareFallback || 0,
    depositByDay: byDay ? primaryGrouped.depositByDay : dailyGrouped?.depositByDay || {},
    depositByMonth: primaryGrouped.depositByMonth,
    paymentLkrByDay: byDay
      ? primaryGrouped.paymentLkrByDay
      : dailyGrouped?.paymentLkrByDay || {},
    paymentLkrByMonth: primaryGrouped.paymentLkrByMonth,
    receivingLkrByDay: byDay
      ? primaryWithdrawals.receivingLkrByDay
      : dailyWithdrawals?.receivingLkrByDay || {},
    receivingLkrByMonth: primaryWithdrawals.receivingLkrByMonth,
    profitByDay: byDay ? profitMaps.profitByDay : sparkProfit.profitByDay,
    profitByMonth: profitMaps.profitByMonth,
  };
}

async function fetchWithdrawalTotalInPeriod(periodStart, periodEnd) {
  const { conditions, values } = periodWhereClause('created_at', periodStart, periodEnd);
  const where = conditions.length ? `AND ${conditions.join(' AND ')}` : '';
  return sumCompletedAmount('withdrawals', 'cashout_amount', where, values);
}

function mapWalletTransactionRow({ id, name, type, amount, logo }) {
  const methodId = Number(id);
  const displayName =
    String(name || '').trim() ||
    (type === 'withdrawal' ? `Cash-out wallet ${methodId}` : `Top-up wallet ${methodId}`);
  const known = type === 'deposit' ? PLATFORM_META[methodId] : null;
  return {
    id: `${type}-${methodId}`,
    methodId,
    type,
    name: displayName,
    letter: known?.letter || displayName.charAt(0).toUpperCase() || '?',
    bg: known?.bg || (type === 'withdrawal' ? '#6366F1' : '#64748B'),
    isUsdt: Boolean(known?.isUsdt) || /usdt|tether/i.test(displayName),
    logoUrl: resolveWalletLogoPublicUrl(logo),
    amount: Number(amount) || 0,
  };
}

async function getAlltimeTotalDeposits(filter, fromDate, toDate) {
  const isUnfiltered = !filter;
  if (
    isUnfiltered &&
    platformsAllTimeCache.version === PLATFORMS_CACHE_VERSION &&
    Array.isArray(platformsAllTimeCache.data) &&
    platformsAllTimeCache.expiresAt > Date.now()
  ) {
    return platformsAllTimeCache.data;
  }

  const { conditions, values: filterValues } = buildTransactionDateFilter(
    filter,
    fromDate,
    toDate,
  );

  const depositWhere = ["d.transaction_status = 'Completed'"];
  const withdrawalWhere = ["w.transaction_status = 'Completed'"];
  const depositValues = [...filterValues];
  const withdrawalValues = [...filterValues];

  for (const condition of conditions) {
    depositWhere.push(condition);
    withdrawalWhere.push(condition.replace(/^d\./, 'w.'));
  }

  const [topupMethods, cashoutMethods, depositTotals, withdrawalTotals] = await Promise.all([
    query(
      `SELECT id, topup_method_name AS name, topup_method_logo AS logo
       FROM topup_methods
       WHERE (is_deleted = 0 OR is_deleted IS NULL)
       ORDER BY id ASC`,
    ),
    query(
      `SELECT id, cashout_method_name AS name, cashout_method_logo AS logo
       FROM cashout_methods
       WHERE (is_deleted = 0 OR is_deleted IS NULL)
       ORDER BY id ASC`,
    ),
    query(
      `SELECT d.topup_method_id AS method_id,
              COALESCE(SUM(d.deposit_amount), 0) AS total_amount
       FROM deposits d
       WHERE ${depositWhere.join(' AND ')}
       GROUP BY d.topup_method_id`,
      depositValues,
    ),
    query(
      `SELECT w.cashout_method_id AS method_id,
              COALESCE(SUM(w.cashout_amount), 0) AS total_amount
       FROM withdrawals w
       WHERE ${withdrawalWhere.join(' AND ')}
       GROUP BY w.cashout_method_id`,
      withdrawalValues,
    ),
  ]);

  const depositTotalsById = {};
  for (const row of depositTotals) {
    depositTotalsById[Number(row.method_id)] = Number(row.total_amount) || 0;
  }
  const withdrawalTotalsById = {};
  for (const row of withdrawalTotals) {
    withdrawalTotalsById[Number(row.method_id)] = Number(row.total_amount) || 0;
  }

  const platforms = [
    ...topupMethods.map((row) =>
      mapWalletTransactionRow({
        id: row.id,
        name: row.name,
        type: 'deposit',
        logo: row.logo,
        amount: depositTotalsById[Number(row.id)] || 0,
      }),
    ),
    ...cashoutMethods.map((row) =>
      mapWalletTransactionRow({
        id: row.id,
        name: row.name,
        type: 'withdrawal',
        logo: row.logo,
        amount: withdrawalTotalsById[Number(row.id)] || 0,
      }),
    ),
  ];

  if (isUnfiltered) {
    platformsAllTimeCache = {
      data: platforms,
      expiresAt: Date.now() + PLATFORMS_CACHE_TTL_MS,
      version: PLATFORMS_CACHE_VERSION,
    };
  }
  return platforms;
}

async function buildAdminDashboard({
  filter,
  fromDate,
  toDate,
  includeDaily = true,
  includePlatforms = true,
} = {}) {
  const period = resolveDashboardPeriod(filter, fromDate, toDate);
  const { year, month, day } = period;
  const lastMonth = month - 1 > 0 ? month - 1 : 12;

  // Platforms list: prefer cache, otherwise load with the rest of the dashboard payload.
  let platformsPromise = Promise.resolve([]);
  let platformsDeferred = false;
  if (includePlatforms) {
    if (
      period.filter === DEFAULT_DASHBOARD_FILTER &&
      platformsAllTimeCache.version === PLATFORMS_CACHE_VERSION &&
      Array.isArray(platformsAllTimeCache.data) &&
      platformsAllTimeCache.data.length > 0 &&
      platformsAllTimeCache.expiresAt > Date.now()
    ) {
      platformsPromise = Promise.resolve(platformsAllTimeCache.data);
    } else if (period.filter === DEFAULT_DASHBOARD_FILTER) {
      platformsPromise = getAlltimeTotalDeposits();
    } else {
      platformsPromise = getAlltimeTotalDeposits(period.filter, fromDate, toDate);
    }
  } else {
    platformsDeferred = true;
  }

  const [depositBundle, totalCompletedWithdrawals, platforms] = await Promise.all([
    fetchDepositsDashboardBundle(period, { includeDaily }),
    fetchWithdrawalTotalInPeriod(period.periodStart, period.periodEnd),
    platformsPromise,
  ]);

  const {
    total: totalCompletedDeposits,
    compareTotal: totalCompletedDepositsCompare,
    depositByDay,
    depositByMonth,
    profitByDay,
    profitByMonth,
  } = depositBundle;

  const growthPercentage = calcGrowthPercentage(
    totalCompletedDeposits,
    totalCompletedDepositsCompare,
  );

  const revenueSeries = buildRevenueSeries(
    depositByDay,
    depositByMonth,
    period,
    period.chartMode,
  );
  const monthlyRevenue = revenueSeries.values;
  const revenueLabels = revenueSeries.labels;

  const profitSeries = buildProfitSeries(
    profitByDay,
    profitByMonth,
    period,
    period.chartMode,
  );

  const profitLabels =
    period.chartMode === 'daily'
      ? eachDayInPeriod(period.periodStart, period.periodEnd).map((key) => {
          const [, m, d] = key.split('-');
          return `${m}/${d}`;
        })
      : eachMonthInPeriod(
          period.periodStart,
          period.periodEnd,
          period.filter,
          period.year,
        ).map((b) => b.label);

  const monthlyProfit = profitSeries;
  const profitChartLabels = profitLabels;

  let dailyProfit = [];
  let dailyProfitLabels = [];
  let currentMonthProfit = 0;
  let todayProfit = 0;
  let lastMonthProfit = 0;
  let yesterdayProfit = 0;

  if (period.chartMode === 'monthly' && period.filter === 'currentyear') {
    const dailyProfitForMonth = {};
    for (const [key, val] of Object.entries(profitByDay || {})) {
      const [y, m, d] = key.split('-').map(Number);
      if (y === year && m === month) {
        dailyProfitForMonth[d] = val;
      }
    }
    dailyProfit = buildDailySeries(dailyProfitForMonth, year, month);
    dailyProfitLabels = Array.from({ length: dailyProfit.length }, (_, i) => String(i + 1));
    currentMonthProfit = profitSeries[month - 1] || 0;
    if (month === 1) {
      lastMonthProfit = Number(profitByMonth[`${year - 1}-12`]) || 0;
    } else {
      lastMonthProfit = profitSeries[lastMonth - 1] || 0;
    }
    todayProfit = dailyProfit[day - 1] || 0;
    if (day > 1) {
      yesterdayProfit = dailyProfit[day - 2] || 0;
    } else {
      const yesterdayDate = addColomboDays(
        colomboLocalToDate({ year, month, day: 1 }),
        -1,
      );
      yesterdayProfit = Number(profitByDay[formatYmdColombo(yesterdayDate)]) || 0;
    }
  } else if (period.chartMode === 'daily') {
    const dayKeys = eachDayInPeriod(period.periodStart, period.periodEnd);
    dailyProfit = dayKeys.map((key) => Number(profitByDay[key]) || 0);
    dailyProfitLabels = dayKeys.map((key) => {
      const [, m, d] = key.split('-');
      return `${m}/${d}`;
    });
    const lastIndex = dailyProfit.length - 1;
    todayProfit = dailyProfit[lastIndex] || 0;
    yesterdayProfit = lastIndex > 0 ? dailyProfit[lastIndex - 1] || 0 : 0;
    currentMonthProfit = dailyProfit.reduce((sum, v) => sum + v, 0);
    lastMonthProfit = yesterdayProfit;
  } else {
    const lastIndex = profitSeries.length - 1;
    currentMonthProfit = profitSeries[lastIndex] || 0;
    lastMonthProfit = lastIndex > 0 ? profitSeries[lastIndex - 1] || 0 : 0;
    todayProfit = currentMonthProfit;
    yesterdayProfit = lastMonthProfit;
    dailyProfit = profitSeries;
    dailyProfitLabels = profitChartLabels;
  }

  const compareLabel =
    period.filter === 'currentyear'
      ? String(year - 1)
      : period.filter === 'lastyear'
        ? String(year - 2)
        : 'Previous period';

  return {
    filter: period.filter,
    periodLabel: period.periodLabel,
    chartMode: period.chartMode,
    year,
    month,
    monthName: MONTH_NAMES[month - 1] || '',
    totalCompletedDeposits,
    totalCompletedWithdrawals,
    monthlyRevenue,
    revenueLabels,
    monthlyProfit,
    profitChartLabels,
    dailyProfit,
    dailyProfitLabels,
    currentMonthProfit,
    todayProfit,
    lastMonthPercentageIncrease: percentChange(currentMonthProfit, lastMonthProfit),
    todayPercentageIncrease: percentChange(todayProfit, yesterdayProfit),
    platforms,
    platformsDeferred,
    growth: {
      growthPercentage,
      currentYearThousands: totalCompletedDeposits / 1000,
      lastYearThousands: totalCompletedDepositsCompare / 1000,
      currentYear: period.periodLabel,
      lastYear: compareLabel,
    },
  };
}

export async function filterDashboardDeposits({ filter, fromDate, toDate } = {}) {
  const { conditions, values } = buildDepositDateFilter(filter, fromDate, toDate);
  const where = conditions.length ? `AND ${conditions.join(' AND ')}` : '';
  return sumCompletedAmount('deposits', 'deposit_amount', where, values);
}

export async function filterDashboardWithdrawals({ filter, fromDate, toDate } = {}) {
  const { conditions, values } = buildDepositDateFilter(filter, fromDate, toDate);
  const where = conditions.length ? `AND ${conditions.join(' AND ')}` : '';
  return sumCompletedAmount('withdrawals', 'cashout_amount', where, values);
}

export async function filterDashboardTransactions({ filter, fromDate, toDate } = {}) {
  const platforms = await getAlltimeTotalDeposits(filter, fromDate, toDate);
  const totals = {};
  for (const platform of platforms) {
    totals[platform.id] = platform.amount;
  }
  return { platforms, totals };
}

function dashboardCacheKey(filter, fromDate, toDate) {
  // v3: real LKR profit (payment − receiving), not deposit×10
  return `${filter}|${fromDate || ''}|${toDate || ''}|${getColomboDateParts().day}|v3`;
}

export async function getAdminDashboard({ filter, fromDate, toDate } = {}) {
  const resolvedFilter = String(filter || DEFAULT_DASHBOARD_FILTER).trim() || DEFAULT_DASHBOARD_FILTER;
  const normalizedFrom = fromDate ? String(fromDate).slice(0, 10) : '';
  const normalizedTo = toDate ? String(toDate).slice(0, 10) : '';
  const cacheKey = dashboardCacheKey(resolvedFilter, normalizedFrom, normalizedTo);
  const cached = readDashboardCache(cacheKey);
  if (cached) return cached;

  // Skip platform scan here — Admin loads it in parallel so cards/charts paint sooner.
  const data = await buildAdminDashboard({
    filter: resolvedFilter,
    fromDate: normalizedFrom || undefined,
    toDate: normalizedTo || undefined,
    includeDaily: true,
    includePlatforms: false,
  });

  // Attach cached platforms when available so the client can skip a second wait.
  if (
    resolvedFilter === DEFAULT_DASHBOARD_FILTER &&
    platformsAllTimeCache.version === PLATFORMS_CACHE_VERSION &&
    Array.isArray(platformsAllTimeCache.data) &&
    platformsAllTimeCache.expiresAt > Date.now()
  ) {
    data.platforms = platformsAllTimeCache.data;
    data.platformsDeferred = false;
  }

  writeDashboardCache(cacheKey, data);
  return data;
}

/** Preload default dashboard (+ indexes) so the first admin page hit is warm. */
export async function warmAdminDashboardCache() {
  try {
    await ensureDashboardIndexes();
  } catch {
    /* ignore */
  }

  try {
    await getAlltimeTotalDeposits();
  } catch (error) {
    console.warn('[dashboard] platform warm failed:', error.message);
  }

  try {
    const data = await buildAdminDashboard({
      filter: DEFAULT_DASHBOARD_FILTER,
      includeDaily: true,
      includePlatforms: true,
    });
    // Force platforms into the payload even if build deferred them.
    if (!data.platforms?.length) {
      data.platforms = await getAlltimeTotalDeposits();
      data.platformsDeferred = false;
    }
    writeDashboardCache(dashboardCacheKey(DEFAULT_DASHBOARD_FILTER, '', ''), data);
    console.log('[dashboard] default cache warmed');
  } catch (error) {
    console.warn('[dashboard] warm failed:', error.message);
  }
}
