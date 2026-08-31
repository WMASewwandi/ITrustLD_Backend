import { query, getDbDriver } from '../config/database.js';
import { AUTHORIZE_WITHDRAWAL_PERMISSION, AUTHORIZER_ROLE_NAME_ALIASES, LARAVEL_USER_MODEL } from '../constants/adminRoles.js';
import { getUserPendingShowCount } from './systemUser.service.js';
import { getUserRoles } from './user.service.js';
import { normalizeToActivityIdentifier } from './role.service.js';
import {
  SL_TIMEZONE,
  alternateShift,
  computeShiftForDate,
  getColomboDateParts,
  getCurrentMinutesInColombo,
  getShiftDateString,
  normalizeShiftDateKey,
  shiftDateMinusOneDay,
} from '../utils/slTime.js';

export { SL_TIMEZONE as SHIFT_TIMEZONE };

const SHIFT_ROLES = ['sub-admin', 'deposit-executive', 'withdrawal-executive'];

let lastAssignedAtColumnReady = false;

async function columnExists(table, column) {
  if (getDbDriver() === 'sqlite') {
    const rows = await query(`PRAGMA table_info(${table})`);
    return rows.some((row) => String(row.name).toLowerCase() === String(column).toLowerCase());
  }
  const rows = await query(`SHOW COLUMNS FROM ${table} LIKE ?`, [column]);
  return rows.length > 0;
}

async function ensureLastAssignedAtColumn() {
  if (lastAssignedAtColumnReady) return lastAssignedAtColumnReady;
  try {
    if (!(await columnExists('users', 'last_assigned_at'))) {
      if (getDbDriver() === 'sqlite') {
        await query(`ALTER TABLE users ADD COLUMN last_assigned_at TEXT NULL`);
      } else {
        try {
          await query(
            `ALTER TABLE users ADD COLUMN last_assigned_at TIMESTAMP NULL AFTER shift_end_time`,
          );
        } catch {
          await query(`ALTER TABLE users ADD COLUMN last_assigned_at TIMESTAMP NULL`);
        }
      }
    }
    lastAssignedAtColumnReady = true;
  } catch (error) {
    console.warn('[shift] last_assigned_at column unavailable:', error.message);
    lastAssignedAtColumnReady = false;
  }
  return lastAssignedAtColumnReady;
}

const USER_SELECT_WITH_LAST_ASSIGNED =
  `SELECT DISTINCT u.id, u.name, u.email, u.is_online, u.shift, u.shift_start_time, u.shift_end_time, u.last_assigned_at`;
const USER_SELECT_WITHOUT_LAST_ASSIGNED =
  `SELECT DISTINCT u.id, u.name, u.email, u.is_online, u.shift, u.shift_start_time, u.shift_end_time`;

function parseTimeToMinutes(value) {
  if (!value) return null;
  const text = String(value).trim();
  const match = text.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

export function isUserInShiftTime(user, activeShift, date = new Date()) {
  if (!user || user.shift !== activeShift) {
    return false;
  }
  if (!user.shift_start_time || !user.shift_end_time) {
    return false;
  }

  const startMinutes = parseTimeToMinutes(user.shift_start_time);
  const endMinutes = parseTimeToMinutes(user.shift_end_time);
  if (startMinutes == null || endMinutes == null) {
    return false;
  }

  const startHi = `${String(Math.floor(startMinutes / 60)).padStart(2, '0')}:${String(startMinutes % 60).padStart(2, '0')}`;
  const endHi = `${String(Math.floor(endMinutes / 60)).padStart(2, '0')}:${String(endMinutes % 60).padStart(2, '0')}`;

  if (startHi === '00:10' && endHi === '00:10') {
    return true;
  }

  const currentMinutes = getCurrentMinutesInColombo(date);
  if (startMinutes > endMinutes) {
    return currentMinutes >= startMinutes || currentMinutes <= endMinutes;
  }
  return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
}

function formatShiftTimeLabel(user) {
  const startMinutes = parseTimeToMinutes(user.shift_start_time);
  const endMinutes = parseTimeToMinutes(user.shift_end_time);
  if (startMinutes == null || endMinutes == null) {
    return '';
  }

  const startHi = `${String(Math.floor(startMinutes / 60)).padStart(2, '0')}:${String(startMinutes % 60).padStart(2, '0')}`;
  const endHi = `${String(Math.floor(endMinutes / 60)).padStart(2, '0')}:${String(endMinutes % 60).padStart(2, '0')}`;

  if ((user.shift === 'A' || user.shift === 'B') && startHi === '00:10' && endHi === '00:10') {
    return '0:10 AM – 0:10 AM (next day)';
  }

  const format12 = (minutes) => {
    const h24 = Math.floor(minutes / 60);
    const m = minutes % 60;
    const period = h24 >= 12 ? 'PM' : 'AM';
    const h12 = h24 % 12 || 12;
    return `${h12}:${String(m).padStart(2, '0')} ${period}`;
  };

  return `${format12(startMinutes)} – ${format12(endMinutes)}`;
}

function roleSlug(role) {
  return String(role || '')
    .trim()
    .toLowerCase()
    .replace(/[_ ]+/g, '-');
}

function isSystemAdminRole(roles = []) {
  return roles.some((role) => {
    const slug = roleSlug(role);
    return slug === 'super-admin' || slug === 'sub-admin';
  });
}

function isWithdrawalAuthorizerRole(roles = []) {
  return roles.some((role) => {
    const slug = roleSlug(role);
    return slug === 'withdrawal-authorizer' || slug === 'withdrawal-authorization';
  });
}

async function withoutSystemAdmins(users) {
  const eligible = [];
  for (const user of users) {
    const roles = await getUserRoles(user.id);
    if (isSystemAdminRole(roles)) continue;
    eligible.push(user);
  }
  return eligible;
}

function roleDisplayName(roles) {
  if (roles.includes('sub-admin')) return 'Sub Admin';
  if (roles.includes('deposit-executive')) return 'Deposit Executive';
  if (roles.includes('withdrawal-executive')) return 'Withdrawal Executive';
  if (isWithdrawalAuthorizerRole(roles)) return 'Withdrawal Authorizer';
  return 'Executive';
}

async function readShiftHistoryRow(shiftDate) {
  const rows = await query(
    `SELECT shift_date, active_shift FROM shift_history WHERE shift_date = ? LIMIT 1`,
    [shiftDate],
  );
  if (!rows[0]) return null;

  return {
    shiftDate: normalizeShiftDateKey(rows[0].shift_date) || shiftDate,
    activeShift: rows[0].active_shift,
  };
}

async function upsertShiftHistory(shiftDate, activeShift) {
  const existing = await readShiftHistoryRow(shiftDate);
  if (existing?.activeShift === activeShift) {
    return activeShift;
  }

  if (getDbDriver() === 'sqlite') {
    if (existing) {
      await query(
        `UPDATE shift_history SET active_shift = ?, updated_at = datetime('now') WHERE shift_date = ?`,
        [activeShift, shiftDate],
      );
    } else {
      await query(
        `INSERT INTO shift_history (shift_date, active_shift, created_at, updated_at)
         VALUES (?, ?, datetime('now'), datetime('now'))`,
        [shiftDate, activeShift],
      );
    }
    return activeShift;
  }

  await query(
    `INSERT INTO shift_history (shift_date, active_shift, created_at, updated_at)
     VALUES (?, ?, NOW(), NOW())
     ON DUPLICATE KEY UPDATE active_shift = VALUES(active_shift), updated_at = NOW()`,
    [shiftDate, activeShift],
  );

  return activeShift;
}

async function readLatestShiftHistoryOnOrBefore(shiftDate) {
  const rows = await query(
    `SELECT shift_date, active_shift
     FROM shift_history
     WHERE shift_date <= ?
     ORDER BY shift_date DESC
     LIMIT 1`,
    [shiftDate],
  );
  if (!rows[0]) return null;

  return {
    shiftDate: normalizeShiftDateKey(rows[0].shift_date) || shiftDate,
    activeShift: rows[0].active_shift,
  };
}

function getTodayAnchor(historyRows, todayShiftDate) {
  let anchorDate = todayShiftDate;
  let anchorShift = 'A';

  let latestOnOrBeforeToday = null;
  for (const row of historyRows) {
    if (row.shiftDate <= todayShiftDate) {
      latestOnOrBeforeToday = row;
    }
  }

  if (latestOnOrBeforeToday) {
    anchorShift =
      latestOnOrBeforeToday.shiftDate === todayShiftDate
        ? latestOnOrBeforeToday.activeShift
        : computeShiftForDate(
            todayShiftDate,
            latestOnOrBeforeToday.shiftDate,
            latestOnOrBeforeToday.activeShift,
          );
  }

  return { anchorDate, anchorShift };
}

export function resolveShiftFromSchedule(shiftDate, historyRows, todayShiftDate) {
  const { anchorDate, anchorShift } = getTodayAnchor(historyRows, todayShiftDate);

  if (shiftDate <= todayShiftDate) {
    return computeShiftForDate(shiftDate, anchorDate, anchorShift);
  }

  let editAnchor = null;
  for (const row of historyRows) {
    if (row.shiftDate >= todayShiftDate && row.shiftDate <= shiftDate) {
      editAnchor = row;
    }
  }

  if (editAnchor) {
    return computeShiftForDate(shiftDate, editAnchor.shiftDate, editAnchor.activeShift);
  }

  return computeShiftForDate(shiftDate, anchorDate, anchorShift);
}

async function resolveShiftAnchor() {
  const todayShiftDate = getShiftDateString();
  const latest = await readLatestShiftHistoryOnOrBefore(todayShiftDate);

  if (!latest?.activeShift) {
    return { anchorShiftDate: todayShiftDate, anchorShift: 'A' };
  }

  const anchorShift = computeShiftForDate(todayShiftDate, latest.shiftDate, latest.activeShift);
  return { anchorShiftDate: todayShiftDate, anchorShift: anchorShift || 'A' };
}

async function getShiftAnchor() {
  const anchor = await resolveShiftAnchor();
  await upsertShiftHistory(anchor.anchorShiftDate, anchor.anchorShift);
  return anchor;
}

export async function resolveShiftForDate(shiftDate) {
  const normalized = normalizeShiftDateKey(shiftDate);
  if (!normalized) return null;

  const todayShiftDate = getShiftDateString();
  const rows = await query(
    `SELECT shift_date, active_shift
     FROM shift_history
     WHERE shift_date <= ?
     ORDER BY shift_date ASC`,
    [normalized],
  );

  const historyRows = rows
    .map((row) => ({
      shiftDate: normalizeShiftDateKey(row.shift_date),
      activeShift: row.active_shift,
    }))
    .filter((row) => row.shiftDate && (row.activeShift === 'A' || row.activeShift === 'B'));

  return resolveShiftFromSchedule(normalized, historyRows, todayShiftDate);
}

export async function setShiftAndCascadeFuture(shiftDate, activeShift) {
  const normalized = normalizeShiftDateKey(shiftDate);
  const today = getShiftDateString();

  if (!normalized || normalized < today) {
    const error = new Error('Cannot edit shifts for past business days.');
    error.status = 422;
    throw error;
  }
  if (activeShift !== 'A' && activeShift !== 'B') {
    const error = new Error('Active shift must be A or B.');
    error.status = 422;
    throw error;
  }

  await upsertShiftHistory(normalized, activeShift);
  await query(`DELETE FROM shift_history WHERE shift_date > ?`, [normalized]);

  return { shift_date: normalized, active_shift: activeShift };
}

export { getShiftAnchor, resolveShiftAnchor };

export async function initializeShiftIfNeeded() {
  await getShiftAnchor();
}

export async function getActiveShiftForDate(date = null) {
  const shiftDate = normalizeShiftDateKey(date) || getShiftDateString();
  const activeShift = await resolveShiftForDate(shiftDate);
  return activeShift || 'A';
}

export async function syncShiftHistoryForDates(shiftDates = []) {
  if (!shiftDates.length) return;

  const { anchorShiftDate, anchorShift } = await getShiftAnchor();
  for (const shiftDate of shiftDates) {
    const normalized = normalizeShiftDateKey(shiftDate);
    if (!normalized) continue;
    const activeShift = computeShiftForDate(normalized, anchorShiftDate, anchorShift);
    await upsertShiftHistory(normalized, activeShift);
  }
}

async function getUsersByPermission(permissionName) {
  const hasLastAssigned = await ensureLastAssignedAtColumn();
  const select = hasLastAssigned ? USER_SELECT_WITH_LAST_ASSIGNED : USER_SELECT_WITHOUT_LAST_ASSIGNED;
  const permissionRows = await query('SELECT id, name FROM permissions');
  const ids = permissionRows
    .filter((row) => normalizeToActivityIdentifier(row.name) === permissionName)
    .map((row) => row.id);
  if (!ids.length) return [];

  const placeholders = ids.map(() => '?').join(', ');
  const byRole = await query(
    `${select}
     FROM users u
     INNER JOIN model_has_roles mhr ON mhr.model_id = u.id AND mhr.model_type = ?
     INNER JOIN role_has_permissions rhp ON rhp.role_id = mhr.role_id
     WHERE rhp.permission_id IN (${placeholders})
     ORDER BY u.id ASC`,
    [LARAVEL_USER_MODEL, ...ids],
  );

  let byDirect = [];
  try {
    byDirect = await query(
      `${select}
       FROM users u
       INNER JOIN model_has_permissions mhp ON mhp.model_id = u.id AND mhp.model_type = ?
       WHERE mhp.permission_id IN (${placeholders})
       ORDER BY u.id ASC`,
      [LARAVEL_USER_MODEL, ...ids],
    );
  } catch {
    byDirect = [];
  }

  return [...new Map([...byRole, ...byDirect].map((user) => [user.id, user])).values()];
}

async function getAuthorizerUsers() {
  const byPermission = await getUsersByPermission(AUTHORIZE_WITHDRAWAL_PERMISSION);
  const byRole = await getUsersByRoles(AUTHORIZER_ROLE_NAME_ALIASES);
  return [...new Map([...byPermission, ...byRole].map((user) => [user.id, user])).values()];
}

async function getUsersByRole(roleName) {
  const hasLastAssigned = await ensureLastAssignedAtColumn();
  const select = hasLastAssigned ? USER_SELECT_WITH_LAST_ASSIGNED : USER_SELECT_WITHOUT_LAST_ASSIGNED;
  return query(
    `${select}
     FROM users u
     INNER JOIN model_has_roles mhr ON mhr.model_id = u.id AND mhr.model_type = ?
     INNER JOIN roles r ON r.id = mhr.role_id
     WHERE r.name = ?
     ORDER BY u.id ASC`,
    [LARAVEL_USER_MODEL, roleName],
  );
}

async function getUsersByRoles(roleNames) {
  if (!roleNames.length) return [];
  const hasLastAssigned = await ensureLastAssignedAtColumn();
  const select = hasLastAssigned ? USER_SELECT_WITH_LAST_ASSIGNED : USER_SELECT_WITHOUT_LAST_ASSIGNED;
  const placeholders = roleNames.map(() => '?').join(', ');
  return query(
    `${select}
     FROM users u
     INNER JOIN model_has_roles mhr ON mhr.model_id = u.id AND mhr.model_type = ?
     INNER JOIN roles r ON r.id = mhr.role_id
     WHERE r.name IN (${placeholders})
     ORDER BY u.id ASC`,
    [LARAVEL_USER_MODEL, ...roleNames],
  );
}

export async function getPendingCountForRole(userId, roles, roleName) {
  if (roles.includes('sub-admin')) {
    const rows = await query(
      `SELECT
         (SELECT COUNT(*) FROM deposits
          WHERE assigned_to = ? AND transaction_status = 'Pending' AND payment_proof IS NOT NULL)
         +
         (SELECT COUNT(*) FROM withdrawals
          WHERE assigned_to = ? AND transaction_status = 'Pending' AND cashout_payment_proof IS NOT NULL)
         AS total`,
      [userId, userId],
    );
    return Number(rows[0]?.total) || 0;
  }

  if (roleName === 'deposit-executive') {
    const rows = await query(
      `SELECT COUNT(*) AS total
       FROM deposits
       WHERE assigned_to = ?
         AND transaction_status = 'Pending'
         AND payment_proof IS NOT NULL`,
      [userId],
    );
    return Number(rows[0]?.total) || 0;
  }

  if (roleName === 'withdrawal-authorizer') {
    const rows = await query(
      `SELECT COUNT(*) AS total
       FROM withdrawals
       WHERE assigned_to = ?
         AND transaction_status = 'Pending Authorization'
         AND cashout_payment_proof IS NOT NULL`,
      [userId],
    );
    return Number(rows[0]?.total) || 0;
  }

  const rows = await query(
    `SELECT COUNT(*) AS total
     FROM withdrawals
     WHERE assigned_to = ?
       AND transaction_status = 'Pending'
       AND cashout_payment_proof IS NOT NULL`,
    [userId],
  );
  return Number(rows[0]?.total) || 0;
}

function compareLastAssignedAt(a, b) {
  const aTime = a.last_assigned_at ? new Date(a.last_assigned_at).getTime() : null;
  const bTime = b.last_assigned_at ? new Date(b.last_assigned_at).getTime() : null;

  if (aTime == null && bTime == null) {
    return a.id - b.id;
  }
  if (aTime == null) return -1;
  if (bTime == null) return 1;
  if (aTime === bTime) {
    return a.id - b.id;
  }
  return aTime - bTime;
}

export async function getCandidateExecutives(roleName) {
  await initializeShiftIfNeeded();
  const activeShift = await getActiveShiftForDate();
  const allInRole =
    roleName === 'withdrawal-authorizer'
      ? await getAuthorizerUsers()
      : await getUsersByRole(roleName);
  const eligible = await withoutSystemAdmins(allInRole);
  if (!eligible.length) return [];

  let shiftFiltered = eligible.filter((user) => user.shift === activeShift);
  if (!shiftFiltered.length) {
    shiftFiltered = eligible;
  }

  const now = new Date();
  let timeFiltered = shiftFiltered.filter((user) => isUserInShiftTime(user, activeShift, now));
  if (!timeFiltered.length) {
    timeFiltered = shiftFiltered;
  }

  const onlineUsers = timeFiltered.filter((user) => Boolean(user.is_online));
  return onlineUsers.length ? onlineUsers : timeFiltered;
}

export async function findExecutiveAmongCandidates(roleName, executiveIds) {
  const idSet = new Set((executiveIds || []).map((id) => Number(id)).filter(Boolean));
  if (!idSet.size) return null;

  const candidates = await getCandidateExecutives(roleName);
  for (const user of candidates) {
    if (!idSet.has(Number(user.id))) continue;
    const roles = await getUserRoles(user.id);
    const pendingCount = await getPendingCountForRole(user.id, roles, roleName);
    const showCount = await getUserPendingShowCount(user.id);
    if (showCount != null && pendingCount >= showCount) continue;
    return user;
  }
  return null;
}

export async function findBestExecutive(roleName) {
  const candidates = await getCandidateExecutives(roleName);
  if (!candidates.length) {
    return null;
  }

  const scored = [];
  for (const user of candidates) {
    const roles = await getUserRoles(user.id);
    const pendingCount = await getPendingCountForRole(user.id, roles, roleName);
    const showCount = await getUserPendingShowCount(user.id);
    const atCapacity = showCount != null && pendingCount >= showCount;
    scored.push({ user, pendingCount, atCapacity });
  }

  scored.sort((a, b) => {
    // Prefer executives still under their pending show count.
    if (a.atCapacity !== b.atCapacity) {
      return a.atCapacity ? 1 : -1;
    }
    if (a.pendingCount !== b.pendingCount) {
      return a.pendingCount - b.pendingCount;
    }
    return compareLastAssignedAt(a.user, b.user);
  });

  return scored[0]?.user || null;
}

export async function buildExecutivesForAssignment(roleName, { includeSubAdmin = true } = {}) {
  await initializeShiftIfNeeded();
  const activeShift = await getActiveShiftForDate();
  const now = new Date();

  const users =
    roleName === 'withdrawal-authorizer'
      ? await getAuthorizerUsers()
      : await getUsersByRoles(includeSubAdmin ? [roleName, 'sub-admin'] : [roleName]);
  const uniqueUsers = [...new Map(users.map((user) => [user.id, user])).values()];

  const executives = [];
  for (const user of uniqueUsers) {
    const roles = await getUserRoles(user.id);
    const pendingCount = await getPendingCountForRole(user.id, roles, roleName);
    const isInActiveShift = user.shift === activeShift;
    const isInShiftTime = isUserInShiftTime(user, activeShift, now);

    executives.push({
      id: user.id,
      name: user.name,
      email: user.email,
      role: roleDisplayName(roles),
      shift: user.shift,
      shift_start_time: user.shift_start_time,
      shift_end_time: user.shift_end_time,
      shift_time_label: formatShiftTimeLabel(user),
      is_online: Boolean(user.is_online),
      is_in_active_shift: isInActiveShift,
      is_in_shift_time: isInShiftTime,
      pending_count: pendingCount,
      sort_key: [
        !isInActiveShift,
        !isInShiftTime,
        !user.is_online,
        pendingCount,
        user.id,
      ],
    });
  }

  executives.sort((a, b) => {
    for (let i = 0; i < a.sort_key.length; i += 1) {
      if (a.sort_key[i] !== b.sort_key[i]) {
        return a.sort_key[i] < b.sort_key[i] ? -1 : 1;
      }
    }
    return 0;
  });

  return {
    active_shift: activeShift,
    executives: executives.map(({ sort_key: _sort, ...rest }) => rest),
  };
}

export async function touchExecutiveLastAssigned(executiveId) {
  if (!executiveId) return;
  const hasLastAssigned = await ensureLastAssignedAtColumn();
  if (!hasLastAssigned) return;
  await query(`UPDATE users SET last_assigned_at = NOW(), updated_at = NOW() WHERE id = ?`, [
    executiveId,
  ]);
}

export async function runShiftEndRollover() {
  await initializeShiftIfNeeded();
  const todayShift = await getActiveShiftForDate();
  const shiftDate = getShiftDateString();
  const yesterday = shiftDateMinusOneDay(shiftDate);
  const endedShift = await getActiveShiftForDate(yesterday);

  const result = await query(`UPDATE users SET is_online = 0, updated_at = NOW() WHERE shift = ?`, [
    endedShift,
  ]);
  const affected = result?.affectedRows ?? result?.changes ?? 0;

  return {
    todayShift,
    endedShift,
    affected,
    message: `Today active shift: ${todayShift}. Set ${affected} Shift ${endedShift} user(s) is_online=false.`,
  };
}

export function isShiftManagedRole(roles = []) {
  return roles.some((role) => SHIFT_ROLES.includes(role));
}

const ADMIN_SHIFT_EXEMPT_ROLES = ['super-admin', 'sub-admin'];

export function isAdminExemptFromShiftRestriction(roles = []) {
  return roles.some((role) => ADMIN_SHIFT_EXEMPT_ROLES.includes(role));
}

export function getAssignedShift(user) {
  const shift = String(user?.shift || '').trim().toUpperCase();
  return shift === 'A' || shift === 'B' ? shift : null;
}

/** System users on the opposite shift cannot sign in. Super/sub admins are exempt. */
export async function assertCanLoginForActiveShift(user, roles = []) {
  if (isAdminExemptFromShiftRestriction(roles)) return null;
  const userShift = getAssignedShift(user);
  if (!userShift) return null;

  const activeShift = await getActiveShiftForDate();
  if (userShift === activeShift) {
    return { activeShift, userShift };
  }

  const error = new Error(
    `Today is Shift ${activeShift}. You are assigned to Shift ${userShift} and cannot sign in.`,
  );
  error.status = 403;
  error.code = 'SHIFT_MISMATCH';
  error.activeShift = activeShift;
  error.userShift = userShift;
  throw error;
}

let lastShiftRolloverDate = null;

export function startShiftRolloverScheduler() {
  const tick = async () => {
    const parts = getColomboDateParts();
    if (parts.hour !== 0 || parts.minute !== 10) {
      return;
    }

    const shiftDate = getShiftDateString();
    if (lastShiftRolloverDate === shiftDate) {
      return;
    }

    lastShiftRolloverDate = shiftDate;
    try {
      const result = await runShiftEndRollover();
      console.log('[shift-rollover]', result.message);
    } catch (error) {
      console.error('[shift-rollover]', error.message);
      lastShiftRolloverDate = null;
    }
  };

  setInterval(tick, 60_000);
  tick().catch((error) => console.error('[shift-rollover:init]', error.message));
}
