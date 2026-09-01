import { env } from '../config/env.js';

export const SL_TIMEZONE = env.shiftTimezone || 'Asia/Colombo';
export const SHIFT_TIMEZONE = SL_TIMEZONE;
/** MySQL session / mysql2 offset for Asia/Colombo wall-clock storage. */
export const SL_MYSQL_OFFSET = '+05:30';
const SL_OFFSET = SL_MYSQL_OFFSET;
const BUSINESS_DAY_START_MINUTES = 10; // 0:10 AM

function pad2(n) {
  return String(n).padStart(2, '0');
}

export function getColomboDateParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: SL_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const parts = Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value]),
  );

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour === '24' ? '0' : parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/** Wall-clock in Sri Lanka as a UTC instant. */
export function colomboLocalToDate({ year, month, day, hour = 0, minute = 0, second = 0 }) {
  return new Date(
    `${year}-${pad2(month)}-${pad2(day)}T${pad2(hour)}:${pad2(minute)}:${pad2(second)}${SL_OFFSET}`,
  );
}

/** Parse Laravel/MySQL naive datetimes as Sri Lanka local time. */
export function parseDbDateTime(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  const raw = String(value).trim();
  if (!raw) return null;

  if (/[zZ]$/.test(raw) || /[+-]\d{2}:\d{2}$/.test(raw)) {
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T');
  const parsed = new Date(`${normalized}${SL_OFFSET}`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Parse MySQL DATETIME values for this app.
 * Pool reads literal strings (UTC session + dateStrings); naive values
 * are Sri Lanka wall-clock as written by Laravel and nowSqlDateTime().
 */
export function parseMysqlWallClockDateTime(value) {
  return parseDbDateTime(value);
}

/** Format a MySQL DATETIME as SL `YYYY-MM-DD HH:mm:ss`. */
export function formatMysqlTimestampSl(value) {
  return formatTimestampSl(value);
}

export function normalizeShiftDateKey(value) {
  if (value == null || value === '') return null;

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const parts = getColomboDateParts(value);
    return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
  }

  const raw = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
    return raw.slice(0, 10);
  }

  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) {
    const parts = getColomboDateParts(parsed);
    return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
  }

  return null;
}

export function alternateShift(shift) {
  return shift === 'A' ? 'B' : 'A';
}

export function shiftDateMinusOneDay(shiftDate) {
  const [year, month, day] = String(shiftDate).slice(0, 10).split('-').map(Number);
  const anchor = colomboLocalToDate({ year, month, day, hour: 0, minute: BUSINESS_DAY_START_MINUTES });
  const prevParts = getColomboDateParts(new Date(anchor.getTime() - 24 * 60 * 60 * 1000));
  return `${prevParts.year}-${pad2(prevParts.month)}-${pad2(prevParts.day)}`;
}

export function shiftDatePlusOneDay(shiftDate) {
  const [year, month, day] = String(shiftDate).slice(0, 10).split('-').map(Number);
  const anchor = colomboLocalToDate({ year, month, day, hour: 0, minute: BUSINESS_DAY_START_MINUTES });
  const nextParts = getColomboDateParts(new Date(anchor.getTime() + 24 * 60 * 60 * 1000));
  return `${nextParts.year}-${pad2(nextParts.month)}-${pad2(nextParts.day)}`;
}

function shiftDateDiffDays(fromShiftDate, toShiftDate) {
  const toMs = (value) => {
    const normalized = normalizeShiftDateKey(value);
    if (!normalized) return null;
    const [year, month, day] = normalized.split('-').map(Number);
    return colomboLocalToDate({
      year,
      month,
      day,
      hour: 0,
      minute: BUSINESS_DAY_START_MINUTES,
    }).getTime();
  };

  const fromMs = toMs(fromShiftDate);
  const targetMs = toMs(toShiftDate);
  if (fromMs == null || targetMs == null) return null;
  return Math.round((targetMs - fromMs) / (24 * 60 * 60 * 1000));
}

/** Resolve shift for a date given a known anchor date/shift (strict A/B alternation). */
export function computeShiftForDate(targetShiftDate, anchorShiftDate, anchorShift) {
  const target = normalizeShiftDateKey(targetShiftDate);
  const anchorDate = normalizeShiftDateKey(anchorShiftDate);
  if (!target || !anchorDate || !anchorShift) {
    return null;
  }

  const dayDiff = shiftDateDiffDays(anchorDate, target);
  if (dayDiff == null) return null;
  if (dayDiff % 2 === 0) return anchorShift;
  return alternateShift(anchorShift);
}

/** Shift/business day key (rolls at 0:10 AM SL). */
export function getShiftDateString(date = new Date()) {
  const parts = getColomboDateParts(date);
  if (parts.hour === 0 && parts.minute < BUSINESS_DAY_START_MINUTES) {
    return shiftDateMinusOneDay(`${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`);
  }
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

/** Start of current business day (0:10 AM SL) as Date. */
export function getBusinessDayStart(date = new Date()) {
  const shiftDate = getShiftDateString(date);
  const [year, month, day] = shiftDate.split('-').map(Number);
  return colomboLocalToDate({
    year,
    month,
    day,
    hour: 0,
    minute: BUSINESS_DAY_START_MINUTES,
    second: 0,
  });
}

export function startOfColomboDay(date = new Date()) {
  const parts = getColomboDateParts(date);
  return colomboLocalToDate({ year: parts.year, month: parts.month, day: parts.day });
}

/** Calendar day in Sri Lanka as naive SQL bounds (excludes yesterday). */
export function currentColomboDaySqlRange(date = new Date()) {
  const from = startOfColomboDay(date);
  return {
    from: formatTimestampSl(from),
    to: formatTimestampSl(addColomboDays(from, 1)),
  };
}

/**
 * Laravel similar/duplicate window: `now()->startOfDay()->addMinutes(10)`
 * with APP_TIMEZONE=UTC. Same SQL literal Eloquent sends; no end bound.
 */
export function laravelSimilarCountSinceSql(date = new Date()) {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())} 00:10:00`;
}

export function startOfColomboWeek(date = new Date()) {
  const parts = getColomboDateParts(date);
  const anchor = colomboLocalToDate({ year: parts.year, month: parts.month, day: parts.day });
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: SL_TIMEZONE,
    weekday: 'short',
  }).format(date);
  const dayIndex = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 }[weekday] ?? 0;
  return new Date(anchor.getTime() - dayIndex * 24 * 60 * 60 * 1000);
}

export function startOfColomboMonth(date = new Date()) {
  const parts = getColomboDateParts(date);
  return colomboLocalToDate({ year: parts.year, month: parts.month, day: 1 });
}

export function addColomboDays(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

export function formatYmdColombo(date = new Date()) {
  const parts = getColomboDateParts(date);
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

export function getCurrentMinutesInColombo(date = new Date()) {
  const parts = getColomboDateParts(date);
  return parts.hour * 60 + parts.minute;
}

export function yearRangeStartSl(year) {
  return formatTimestampSl(
    colomboLocalToDate({ year, month: 1, day: 1, hour: 0, minute: 0, second: 0 }),
  );
}

export function yearRangeEndSl(year) {
  return formatTimestampSl(
    colomboLocalToDate({ year: year + 1, month: 1, day: 1, hour: 0, minute: 0, second: 0 }),
  );
}

export function formatTimestampSl(value) {
  if (value == null || value === '') return '';
  if (!(value instanceof Date)) {
    const raw = String(value).trim();
    const naive = raw.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/);
    if (naive && !/[zZ]$/.test(raw) && !/[+-]\d{2}:\d{2}$/.test(raw)) {
      return `${naive[1]} ${naive[2]}`;
    }
  }
  const date = parseDbDateTime(value);
  if (!date) return value == null ? '' : String(value);
  const parts = getColomboDateParts(date);
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)} ${pad2(parts.hour)}:${pad2(parts.minute)}:${pad2(parts.second)}`;
}

export function formatDateTimeParts(value) {
  const date = parseDbDateTime(value);
  if (!date) {
    return { date: '—', time: '—', iso: null };
  }
  const parts = getColomboDateParts(date);
  return {
    date: `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`,
    time: `${pad2(parts.hour)}:${pad2(parts.minute)}:${pad2(parts.second)}`,
    iso: date.toISOString(),
  };
}

export function formatDateSl(value, options = {}) {
  const date = parseDbDateTime(value);
  if (!date) return '—';
  return date.toLocaleDateString('en-GB', {
    timeZone: SL_TIMEZONE,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    ...options,
  });
}

export function formatDateTimeDisplaySl(value, options = {}) {
  const date = parseDbDateTime(value);
  if (!date) return '—';
  return date.toLocaleString('en-GB', {
    timeZone: SL_TIMEZONE,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    ...options,
  });
}

export function nowSqlDateTime() {
  return formatTimestampSl(new Date());
}

/**
 * Transaction list date filters (business day boundary 0:10 AM SL).
 */
export function parseDateWindow(filter, fromDate, toDate) {
  const now = new Date();

  switch (filter) {
    case 'today': {
      const from = getBusinessDayStart(now);
      const to = addColomboDays(from, 1);
      return { from, to };
    }
    case 'yesterday': {
      const todayStart = getBusinessDayStart(now);
      const from = addColomboDays(todayStart, -1);
      return { from, to: todayStart };
    }
    case 'last7days':
      return { from: addColomboDays(now, -7), to: null };
    case 'lastmonth':
      return { from: addColomboDays(now, -30), to: null };
    case 'last6months':
      return { from: addColomboDays(now, -180), to: null };
    case 'currentyear': {
      const parts = getColomboDateParts(now);
      const from = colomboLocalToDate({
        year: parts.year,
        month: 1,
        day: 1,
        hour: 0,
        minute: BUSINESS_DAY_START_MINUTES,
      });
      return { from, to: null };
    }
    case 'lastyear': {
      const parts = getColomboDateParts(now);
      const from = colomboLocalToDate({
        year: parts.year - 1,
        month: 1,
        day: 1,
        hour: 0,
        minute: BUSINESS_DAY_START_MINUTES,
      });
      const to = colomboLocalToDate({
        year: parts.year,
        month: 1,
        day: 1,
        hour: 0,
        minute: BUSINESS_DAY_START_MINUTES,
      });
      return { from, to };
    }
    case 'customdate': {
      if (!fromDate) return { from: null, to: null };
      const [y, m, d] = String(fromDate).slice(0, 10).split('-').map(Number);
      const from = colomboLocalToDate({
        year: y,
        month: m,
        day: d,
        hour: 0,
        minute: BUSINESS_DAY_START_MINUTES,
      });
      let to = null;
      if (toDate) {
        const [y2, m2, d2] = String(toDate).slice(0, 10).split('-').map(Number);
        to = addColomboDays(
          colomboLocalToDate({
            year: y2,
            month: m2,
            day: d2,
            hour: 0,
            minute: BUSINESS_DAY_START_MINUTES,
          }),
          1,
        );
      }
      return { from, to };
    }
    default:
      return { from: null, to: null };
  }
}

export function resolveFilterDateRange(filterTemplate, fromDate, toDate) {
  const template = String(filterTemplate || '').trim().toUpperCase();
  const today = new Date();

  if (template === 'LAST_7_DAYS') {
    return { fromDate: formatYmdColombo(addColomboDays(today, -7)), toDate: formatYmdColombo(today) };
  }
  if (template === 'LAST_MONTH') {
    const parts = getColomboDateParts(today);
    const from = colomboLocalToDate({ year: parts.year, month: parts.month, day: 1 });
    const prevMonth = getColomboDateParts(new Date(from.getTime() - 24 * 60 * 60 * 1000));
    const monthStart = colomboLocalToDate({
      year: prevMonth.year,
      month: prevMonth.month,
      day: 1,
    });
    return { fromDate: formatYmdColombo(monthStart), toDate: formatYmdColombo(today) };
  }
  if (template === 'LAST_6_MONTHS') {
    const parts = getColomboDateParts(today);
    const from = colomboLocalToDate({
      year: parts.year,
      month: parts.month,
      day: 1,
    });
    const sixMonthsAgo = getColomboDateParts(
      new Date(colomboLocalToDate({ year: parts.year, month: parts.month, day: 1 }).getTime()),
    );
    // subtract 6 months approximately via date math
    let month = parts.month - 6;
    let year = parts.year;
    while (month <= 0) {
      month += 12;
      year -= 1;
    }
    const fromAnchor = colomboLocalToDate({ year, month, day: 1 });
    return { fromDate: formatYmdColombo(fromAnchor), toDate: formatYmdColombo(today) };
  }

  return {
    fromDate: fromDate ? String(fromDate).slice(0, 10) : null,
    toDate: toDate ? String(toDate).slice(0, 10) : null,
  };
}
