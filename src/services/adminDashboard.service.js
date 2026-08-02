import { getDbDriver, query } from '../config/database.js';

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

const DASHBOARD_CACHE_TTL_MS = 30_000;
let dashboardCache = { key: '', data: null, expiresAt: 0 };

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
  return `${year}-01-01 00:00:00`;
}

function yearRangeEnd(year) {
  return `${year + 1}-01-01 00:00:00`;
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
  const conditions = [];
  const values = [];
  const now = new Date();
  const year = now.getFullYear();
  const column = 'created_at';

  switch (filter) {
    case 'last7days':
      conditions.push(`${column} >= ?`);
      values.push(new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString());
      break;
    case 'lastmonth':
      conditions.push(`${column} >= ?`);
      values.push(new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString());
      break;
    case 'last6months':
      conditions.push(`${column} >= ?`);
      values.push(new Date(now.getTime() - 180 * 24 * 60 * 60 * 1000).toISOString());
      break;
    case 'currentyear':
      conditions.push(`${column} >= ? AND ${column} < ?`);
      values.push(yearRangeStart(year), yearRangeEnd(year));
      break;
    case 'lastyear':
      conditions.push(`${column} >= ? AND ${column} < ?`);
      values.push(yearRangeStart(year - 1), yearRangeEnd(year - 1));
      break;
    case 'customdate':
      if (fromDate && toDate) {
        conditions.push(`${column} >= ? AND ${column} <= ?`);
        values.push(fromDate, toDate);
      }
      break;
    default:
      break;
  }

  return { conditions, values };
}

function buildTransactionDateFilter(filter, fromDate, toDate) {
  const conditions = [];
  const values = [];
  const now = new Date();
  const year = now.getFullYear();
  const column = 'd.created_at';

  switch (filter) {
    case 'last7days':
      conditions.push(`${column} >= ?`);
      values.push(new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString());
      break;
    case 'lastmonth':
      conditions.push(`${column} >= ?`);
      values.push(new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString());
      break;
    case 'last6months':
      conditions.push(`${column} >= ?`);
      values.push(new Date(now.getTime() - 180 * 24 * 60 * 60 * 1000).toISOString());
      break;
    case 'currentyear':
      conditions.push(`${column} >= ? AND ${column} < ?`);
      values.push(yearRangeStart(year), yearRangeEnd(year));
      break;
    case 'lastyear':
      conditions.push(`${column} >= ? AND ${column} < ?`);
      values.push(yearRangeStart(year - 1), yearRangeEnd(year - 1));
      break;
    case 'customdate':
      if (fromDate && toDate) {
        conditions.push(`${column} >= ? AND ${column} <= ?`);
        values.push(fromDate, toDate);
      }
      break;
    default:
      break;
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

function buildMonthlyRevenue(byMonth) {
  const values = [];
  for (let month = 1; month <= 12; month += 1) {
    values.push((byMonth[month] || 0) / 1000);
  }
  return values;
}

function buildMonthlyProfit(byMonth) {
  const values = [];
  for (let month = 1; month <= 12; month += 1) {
    values.push((byMonth[month] || 0) * 10);
  }
  return values;
}

function buildDailyProfit(byDay, year, month) {
  const lastDay = new Date(year, month, 0).getDate();
  const values = [];
  for (let day = 1; day <= lastDay; day += 1) {
    values.push((byDay[day] || 0) * 10);
  }
  return values;
}

async function fetchDepositAggregates(year, month) {
  const yearExpr = sqlYear('created_at');
  const monthExpr = sqlMonth('created_at');
  const dayExpr = sqlDayOfMonth('created_at');
  const rows = await query(
    `SELECT ${yearExpr} AS yr,
            ${monthExpr} AS mo,
            ${dayExpr} AS dy,
            COALESCE(SUM(deposit_amount), 0) AS total_deposit
     FROM deposits
     WHERE transaction_status = 'Completed'
       AND created_at >= ?
       AND created_at < ?
     GROUP BY yr, mo, dy`,
    [yearRangeStart(year - 1), yearRangeEnd(year)],
  );

  let totalCompletedDeposits = 0;
  let totalCompletedDepositsLastYear = 0;
  const monthlyDeposits = {};
  const dailyDeposits = {};

  for (const row of rows) {
    const rowYear = Number(row.yr);
    const rowMonth = Number(row.mo);
    const rowDay = Number(row.dy);
    const total = Number(row.total_deposit) || 0;

    if (rowYear === year) {
      totalCompletedDeposits += total;
      monthlyDeposits[rowMonth] = (monthlyDeposits[rowMonth] || 0) + total;
      if (rowMonth === month) {
        dailyDeposits[rowDay] = (dailyDeposits[rowDay] || 0) + total;
      }
    } else if (rowYear === year - 1) {
      totalCompletedDepositsLastYear += total;
    }
  }

  return {
    totalCompletedDeposits,
    totalCompletedDepositsLastYear,
    monthlyDeposits,
    dailyDeposits,
  };
}

async function fetchYearWithdrawalTotal(year) {
  return sumCompletedAmount(
    'withdrawals',
    'cashout_amount',
    'AND created_at >= ? AND created_at < ?',
    [yearRangeStart(year), yearRangeEnd(year)],
  );
}

async function getAlltimeTotalDeposits(filter, fromDate, toDate) {
  let sql = `
    SELECT tm.id AS topup_method_id,
           tm.topup_method_name,
           COALESCE(SUM(d.deposit_amount), 0) AS total_deposit
    FROM topup_methods tm
    LEFT JOIN deposits d
      ON tm.id = d.topup_method_id
     AND d.transaction_status = 'Completed'`;

  const values = [];
  const { conditions, values: filterValues } = buildTransactionDateFilter(
    filter,
    fromDate,
    toDate,
  );

  if (conditions.length) {
    sql += ` AND ${conditions.join(' AND ')}`;
    values.push(...filterValues);
  }

  sql += ' GROUP BY tm.id ORDER BY tm.id ASC';
  const rows = await query(sql, values);

  return rows.map((row) => {
    const id = Number(row.topup_method_id);
    const meta = PLATFORM_META[id] || {
      name: row.topup_method_name || `Platform ${id}`,
      letter: String(row.topup_method_name || id).charAt(0).toUpperCase(),
      bg: '#64748B',
      isUsdt: false,
    };
    return {
      id,
      name: meta.name,
      letter: meta.letter,
      bg: meta.bg,
      isUsdt: meta.isUsdt,
      amount: Number(row.total_deposit) || 0,
    };
  });
}

async function buildAdminDashboard() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const today = now.getDate();
  const lastMonth = month - 1 > 0 ? month - 1 : 12;

  const [depositAggregates, totalCompletedWithdrawals, platforms] = await Promise.all([
    fetchDepositAggregates(year, month),
    fetchYearWithdrawalTotal(year),
    getAlltimeTotalDeposits(),
  ]);

  const {
    totalCompletedDeposits,
    totalCompletedDepositsLastYear,
    monthlyDeposits,
    dailyDeposits,
  } = depositAggregates;

  const growthPercentage = calcGrowthPercentage(
    totalCompletedDeposits,
    totalCompletedDepositsLastYear,
  );

  const monthlyRevenue = buildMonthlyRevenue(monthlyDeposits);
  const monthlyProfit = buildMonthlyProfit(monthlyDeposits);
  const dailyProfit = buildDailyProfit(dailyDeposits, year, month);

  const currentMonthProfit = monthlyProfit[month - 1] || 0;
  const lastMonthProfit = monthlyProfit[lastMonth - 1] || 0;
  const todayProfit = dailyProfit[today - 1] || 0;
  const yesterdayProfit = today > 1 ? dailyProfit[today - 2] || 0 : 0;

  return {
    year,
    month,
    monthName: MONTH_NAMES[month - 1] || '',
    totalCompletedDeposits,
    totalCompletedWithdrawals,
    monthlyRevenue,
    monthlyProfit,
    dailyProfit,
    currentMonthProfit,
    todayProfit,
    lastMonthPercentageIncrease: percentChange(currentMonthProfit, lastMonthProfit),
    todayPercentageIncrease: percentChange(todayProfit, yesterdayProfit),
    platforms,
    growth: {
      growthPercentage,
      currentYearThousands: totalCompletedDeposits / 1000,
      lastYearThousands: totalCompletedDepositsLastYear / 1000,
      currentYear: year,
      lastYear: year - 1,
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

export async function getAdminDashboard() {
  const cacheKey = String(new Date().getFullYear());
  const now = Date.now();
  if (dashboardCache.key === cacheKey && dashboardCache.data && dashboardCache.expiresAt > now) {
    return dashboardCache.data;
  }

  const data = await buildAdminDashboard();
  dashboardCache = {
    key: cacheKey,
    data,
    expiresAt: now + DASHBOARD_CACHE_TTL_MS,
  };
  return data;
}
