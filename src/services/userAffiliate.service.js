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

const CLIENT_BASE_FROM = `
  FROM partner_clients pc
  INNER JOIN account_holders a ON pc.client_ah_id = a.id
  LEFT JOIN (
    SELECT user_id, MIN(created_at) AS first_deposit_date, MAX(created_at) AS latest_deposit_date
    FROM deposits
    WHERE transaction_status = 'Completed'
    GROUP BY user_id
  ) AS d ON a.user_id = d.user_id
  LEFT JOIN (
    SELECT user_id, SUM(point_earning_amount) AS total_points
    FROM point_earnings
    GROUP BY user_id
  ) AS pe ON a.user_id = pe.user_id
`;

export async function listPartnerClients(userId, options = {}) {
  const accountHolder = await assertAffiliateAccess(userId);
  const page = Math.max(1, Number(options.page) || 1);
  const perPage = Math.min(100, Math.max(1, Number(options.perPage || options.per_page) || 20));
  const offset = (page - 1) * perPage;
  const keyword = String(options.keyword || options.search || '').trim();

  let whereSql = `WHERE pc.partner_ah_id = ? AND a.account_number IS NOT NULL`;
  const params = [accountHolder.id];

  if (keyword) {
    whereSql += ` AND (
      a.account_number LIKE ?
      OR CAST(a.user_id AS CHAR) LIKE ?
    )`;
    const like = `%${keyword}%`;
    params.push(like, like);
  }

  const countRows = await query(
    `SELECT COUNT(*) AS total
     ${CLIENT_BASE_FROM}
     ${whereSql}`,
    params,
  );
  const total = Number(countRows[0]?.total || 0);

  const rows = await query(
    `SELECT a.id, a.user_id, a.account_number, a.is_patner,
            d.first_deposit_date, d.latest_deposit_date, pe.total_points
     ${CLIENT_BASE_FROM}
     ${whereSql}
     ORDER BY d.latest_deposit_date DESC, a.id DESC
     LIMIT ${perPage} OFFSET ${offset}`,
    params,
  );

  return {
    clients: rows.map(mapClientRow),
    pagination: {
      page,
      per_page: perPage,
      total,
      total_pages: Math.max(1, Math.ceil(total / perPage)),
    },
  };
}

export async function listSubPartnerClients(userId, options = {}) {
  const accountHolder = await assertAffiliateAccess(userId);
  const page = Math.max(1, Number(options.page) || 1);
  const perPage = Math.min(100, Math.max(1, Number(options.perPage || options.per_page) || 20));
  const offset = (page - 1) * perPage;
  const keyword = String(options.keyword || options.search || '').trim();

  let whereSql = `
    WHERE pc.partner_ah_id IN (
      SELECT spc.client_ah_id
      FROM partner_clients AS spc
      WHERE spc.partner_ah_id = ?
    )
    AND a.account_number IS NOT NULL`;
  const params = [accountHolder.id];

  if (keyword) {
    whereSql += ` AND (
      a.account_number LIKE ?
      OR CAST(a.user_id AS CHAR) LIKE ?
    )`;
    const like = `%${keyword}%`;
    params.push(like, like);
  }

  const countRows = await query(
    `SELECT COUNT(*) AS total
     ${CLIENT_BASE_FROM}
     ${whereSql}`,
    params,
  );
  const total = Number(countRows[0]?.total || 0);

  const rows = await query(
    `SELECT a.id, a.user_id, a.account_number, a.is_patner,
            d.first_deposit_date, d.latest_deposit_date, pe.total_points
     ${CLIENT_BASE_FROM}
     ${whereSql}
     ORDER BY d.latest_deposit_date DESC, a.id DESC
     LIMIT ${perPage} OFFSET ${offset}`,
    params,
  );

  return {
    clients: rows.map(mapClientRow),
    pagination: {
      page,
      per_page: perPage,
      total,
      total_pages: Math.max(1, Math.ceil(total / perPage)),
    },
  };
}
