import { query } from '../config/database.js';
import {
  findAccountHolderByUserId,
  isAccountBanned,
  needsVerification,
} from './accountHolder.service.js';

function validationError(message, status = 422) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function formatDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${d} ${hh}:${mm}`;
}

async function assertAffiliateAccess(userId) {
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

function mapClientRow(row) {
  const points = Number(row.total_points || 0);
  return {
    id: row.id,
    account_id: row.account_number,
    accountId: row.account_number,
    is_partner: row.is_patner === 'YES',
    isPartner: row.is_patner === 'YES',
    first_transaction: formatDateTime(row.first_deposit_date),
    firstTransaction: formatDateTime(row.first_deposit_date),
    last_transaction: formatDateTime(row.latest_deposit_date),
    lastTransaction: formatDateTime(row.latest_deposit_date),
    points: points.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    points_raw: points,
  };
}

function buildClientWhere({ partnerWhereSql, keyword, params }) {
  let whereSql = partnerWhereSql;
  if (keyword) {
    whereSql += ` AND (
      a.account_number LIKE ?
      OR CAST(a.user_id AS CHAR) LIKE ?
    )`;
    const like = `%${keyword}%`;
    params.push(like, like);
  }
  return whereSql;
}

async function attachDepositAndPoints(rows) {
  if (!rows.length) return rows;

  const userIds = [...new Set(rows.map((row) => Number(row.user_id)).filter(Boolean))];
  if (!userIds.length) {
    return rows.map((row) => ({ ...row, first_deposit_date: null, latest_deposit_date: null, total_points: 0 }));
  }

  const placeholders = userIds.map(() => '?').join(', ');
  const [depositRows, pointRows] = await Promise.all([
    query(
      `SELECT user_id,
              MIN(created_at) AS first_deposit_date,
              MAX(created_at) AS latest_deposit_date
       FROM deposits
       WHERE transaction_status = 'Completed'
         AND user_id IN (${placeholders})
       GROUP BY user_id`,
      userIds,
    ),
    query(
      `SELECT user_id, COALESCE(SUM(point_earning_amount), 0) AS total_points
       FROM point_earnings
       WHERE user_id IN (${placeholders})
       GROUP BY user_id`,
      userIds,
    ),
  ]);

  const depositsByUser = new Map(
    depositRows.map((row) => [
      Number(row.user_id),
      {
        first_deposit_date: row.first_deposit_date,
        latest_deposit_date: row.latest_deposit_date,
      },
    ]),
  );
  const pointsByUser = new Map(
    pointRows.map((row) => [Number(row.user_id), Number(row.total_points) || 0]),
  );

  return rows.map((row) => {
    const userId = Number(row.user_id);
    const deposits = depositsByUser.get(userId) || {};
    return {
      ...row,
      first_deposit_date: deposits.first_deposit_date || null,
      latest_deposit_date: deposits.latest_deposit_date || null,
      total_points: pointsByUser.get(userId) || 0,
    };
  });
}

async function listClientsForPartnerScope({
  partnerWhereSql,
  partnerParams,
  page,
  perPage,
  keyword,
  countOnly = false,
}) {
  const countParams = [...partnerParams];
  const countWhereSql = buildClientWhere({
    partnerWhereSql,
    keyword,
    params: countParams,
  });

  const countPromise = query(
    `SELECT COUNT(*) AS total
     FROM partner_clients pc
     INNER JOIN account_holders a ON pc.client_ah_id = a.id
     ${countWhereSql}`,
    countParams,
  );

  if (countOnly) {
    const countRows = await countPromise;
    const total = Number(countRows[0]?.total || 0);
    return {
      clients: [],
      pagination: {
        page: 1,
        per_page: perPage,
        total,
        total_pages: Math.max(1, Math.ceil(total / Math.max(1, perPage))),
      },
    };
  }

  const listParams = [...partnerParams];
  const listWhereSql = buildClientWhere({
    partnerWhereSql,
    keyword,
    params: listParams,
  });
  const offset = (page - 1) * perPage;

  const [countRows, rows] = await Promise.all([
    countPromise,
    query(
      `SELECT a.id, a.user_id, a.account_number, a.is_patner
       FROM partner_clients pc
       INNER JOIN account_holders a ON pc.client_ah_id = a.id
       ${listWhereSql}
       ORDER BY a.id DESC
       LIMIT ${perPage} OFFSET ${offset}`,
      listParams,
    ),
  ]);

  const total = Number(countRows[0]?.total || 0);
  const enriched = await attachDepositAndPoints(rows);
  enriched.sort((a, b) => {
    const aTime = a.latest_deposit_date ? new Date(a.latest_deposit_date).getTime() : 0;
    const bTime = b.latest_deposit_date ? new Date(b.latest_deposit_date).getTime() : 0;
    if (bTime !== aTime) return bTime - aTime;
    return Number(b.id) - Number(a.id);
  });

  return {
    clients: enriched.map(mapClientRow),
    pagination: {
      page,
      per_page: perPage,
      total,
      total_pages: Math.max(1, Math.ceil(total / Math.max(1, perPage))),
    },
  };
}

export async function listPartnerClients(userId, options = {}) {
  const accountHolder = await assertAffiliateAccess(userId);
  const page = Math.max(1, Number(options.page) || 1);
  const perPage = Math.min(100, Math.max(1, Number(options.perPage || options.per_page) || 20));
  const keyword = String(options.keyword || options.search || '').trim();
  const countOnly =
    options.countOnly === true ||
    options.count_only === true ||
    options.countOnly === 'true' ||
    options.count_only === '1';

  return listClientsForPartnerScope({
    partnerWhereSql: `WHERE pc.partner_ah_id = ? AND a.account_number IS NOT NULL`,
    partnerParams: [accountHolder.id],
    page,
    perPage,
    keyword,
    countOnly,
  });
}

export async function listSubPartnerClients(userId, options = {}) {
  const accountHolder = await assertAffiliateAccess(userId);
  const page = Math.max(1, Number(options.page) || 1);
  const perPage = Math.min(100, Math.max(1, Number(options.perPage || options.per_page) || 20));
  const keyword = String(options.keyword || options.search || '').trim();
  const countOnly =
    options.countOnly === true ||
    options.count_only === true ||
    options.countOnly === 'true' ||
    options.count_only === '1';

  return listClientsForPartnerScope({
    partnerWhereSql: `
      WHERE pc.partner_ah_id IN (
        SELECT spc.client_ah_id
        FROM partner_clients AS spc
        WHERE spc.partner_ah_id = ?
      )
      AND a.account_number IS NOT NULL`,
    partnerParams: [accountHolder.id],
    page,
    perPage,
    keyword,
    countOnly,
  });
}
