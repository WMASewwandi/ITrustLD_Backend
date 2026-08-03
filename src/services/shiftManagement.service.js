import { query } from '../config/database.js';
import {
  colomboLocalToDate,
  computeShiftForDate,
  getShiftDateString,
  normalizeShiftDateKey,
  shiftDateMinusOneDay,
} from '../utils/slTime.js';
import {
  resolveShiftFromSchedule,
  setShiftAndCascadeFuture,
} from './shiftAssignment.service.js';

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

function pad2(n) {
  return String(n).padStart(2, '0');
}

function validationError(message, status = 422) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function getWeekdayColombo(year, month, day) {
  const date = colomboLocalToDate({ year, month, day, hour: 12 });
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Colombo',
    weekday: 'short',
  }).format(date);
  return { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[weekday] ?? 0;
}

async function loadShiftHistoryUpTo(endDate) {
  const rows = await query(
    `SELECT shift_date, active_shift
     FROM shift_history
     WHERE shift_date <= ?
     ORDER BY shift_date ASC`,
    [endDate],
  );

  return rows
    .map((row) => ({
      shiftDate: normalizeShiftDateKey(row.shift_date),
      activeShift: row.active_shift,
    }))
    .filter((row) => row.shiftDate && (row.activeShift === 'A' || row.activeShift === 'B'));
}

async function repairFutureShiftHistory(todayShiftDate, anchorShift) {
  const rows = await query(
    `SELECT shift_date, active_shift FROM shift_history WHERE shift_date > ? ORDER BY shift_date ASC`,
    [todayShiftDate],
  );

  for (const row of rows) {
    const date = normalizeShiftDateKey(row.shift_date);
    if (!date) continue;

    const fromToday = computeShiftForDate(date, todayShiftDate, anchorShift);
    const previousDate = shiftDateMinusOneDay(date);
    const previousShift = computeShiftForDate(previousDate, todayShiftDate, anchorShift);

    const matchesTodayChain = row.active_shift === fromToday;
    const breaksAlternation = row.active_shift === previousShift;

    if (matchesTodayChain || breaksAlternation) {
      await query(`DELETE FROM shift_history WHERE shift_date = ?`, [date]);
    }
  }
}

export async function getShiftCalendar({ year, month }) {
  const y = Number(year);
  const m = Number(month);

  if (!Number.isInteger(y) || y < 2000 || y > 2100) {
    throw validationError('Invalid year.');
  }
  if (!Number.isInteger(m) || m < 1 || m > 12) {
    throw validationError('Invalid month.');
  }

  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const startWeekday = getWeekdayColombo(y, m, 1);
  const todayShiftDate = getShiftDateString();
  const preRows = await loadShiftHistoryUpTo(todayShiftDate);
  const todayActiveShift = resolveShiftFromSchedule(todayShiftDate, preRows, todayShiftDate);
  await repairFutureShiftHistory(todayShiftDate, todayActiveShift);

  const lastShiftDate = `${y}-${pad2(m)}-${pad2(daysInMonth)}`;
  const historyRows = await loadShiftHistoryUpTo(lastShiftDate);

  const days = [];
  for (let d = 1; d <= daysInMonth; d += 1) {
    const shiftDate = `${y}-${pad2(m)}-${pad2(d)}`;
    const activeShift = resolveShiftFromSchedule(shiftDate, historyRows, todayShiftDate);
    days.push({
      date: shiftDate,
      day: d,
      weekday: getWeekdayColombo(y, m, d),
      active_shift: activeShift,
      is_today: shiftDate === todayShiftDate,
      can_edit: shiftDate >= todayShiftDate,
    });
  }

  const shiftACount = days.filter((day) => day.active_shift === 'A').length;
  const shiftBCount = days.filter((day) => day.active_shift === 'B').length;

  return {
    year: y,
    month: m,
    month_name: MONTH_NAMES[m - 1],
    days_in_month: daysInMonth,
    start_weekday: startWeekday,
    today_shift_date: todayShiftDate,
    today_active_shift: todayActiveShift,
    summary: {
      shift_a_days: shiftACount,
      shift_b_days: shiftBCount,
    },
    days,
  };
}

export async function updateShiftSchedule({ shiftDate, activeShift }) {
  return setShiftAndCascadeFuture(shiftDate, activeShift);
}
