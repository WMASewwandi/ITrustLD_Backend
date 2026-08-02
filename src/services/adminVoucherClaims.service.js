import { query } from '../config/database.js';

function validationError(message, status = 422) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function formatYmd(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return null;
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function formatYmdHis(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return '—';
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${d} ${hh}:${mm}`;
}

function buildAdminDateFilter(filter, fromDate, toDate) {
  const normalized = String(filter || '').trim().toLowerCase();
  const today = new Date();
  const end = formatYmd(today);

  switch (normalized) {
    case 'today':
      return { fromDate: end, toDate: end };
    case 'yesterday': {
      const y = new Date(today);
      y.setDate(y.getDate() - 1);
      const day = formatYmd(y);
      return { fromDate: day, toDate: day };
    }
    case 'last7days': {
      const from = new Date(today);
      from.setDate(from.getDate() - 7);
      return { fromDate: formatYmd(from), toDate: end };
    }
    case 'lastmonth': {
      const from = new Date(today);
      from.setMonth(from.getMonth() - 1);
      return { fromDate: formatYmd(from), toDate: end };
    }
    case 'last6months': {
      const from = new Date(today);
      from.setMonth(from.getMonth() - 6);
      return { fromDate: formatYmd(from), toDate: end };
    }
    case 'currentyear':
      return { fromDate: `${today.getFullYear()}-01-01`, toDate: end };
    case 'lastyear':
      return {
        fromDate: `${today.getFullYear() - 1}-01-01`,
        toDate: `${today.getFullYear() - 1}-12-31`,
      };
    case 'customdate':
      return {
        fromDate: fromDate ? String(fromDate).slice(0, 10) : null,
        toDate: toDate ? String(toDate).slice(0, 10) : null,
      };
    default:
      return { fromDate: null, toDate: null };
  }
}

async function fetchAdminNames(adminIds) {
  const ids = [...new Set(adminIds.filter(Boolean))];
  if (!ids.length) return {};
  const rows = await query(
    `SELECT id, name FROM users WHERE id IN (${ids.map(() => '?').join(', ')})`,
    ids,
  );
  return Object.fromEntries(rows.map((row) => [row.id, row.name]));
}

function mapVoucherStatus(row) {
  if (Number(row.is_claimed) === 1) return 'Claimed';
  if (row.rejection_reason) return 'Rejected';
  if (isAutoRejected(row)) return 'Rejected';
  return 'Pending';
}

function isAutoRejected(row) {
  if (Number(row.is_claimed) === 1 || row.rejection_reason) return false;
  const created = new Date(row.created_at);
  if (Number.isNaN(created.getTime())) return false;
  const days = (Date.now() - created.getTime()) / (1000 * 60 * 60 * 24);
  return days >= 30;
}

function applyVoucherStatusFilter(sql, values, statusInput) {
  const status = String(statusInput || 'Pending');
  if (status === 'All') return sql;

  if (status === 'Claimed') {
    return `${sql} AND v.is_claimed = 1`;
  }
  if (status === 'Rejected') {
    return `${sql} AND (
      v.rejection_reason IS NOT NULL
      OR (v.is_claimed = 0 AND DATEDIFF(NOW(), v.created_at) >= 30)
    )`;
  }
  return `${sql} AND v.is_claimed = 0 AND v.rejection_reason IS NULL`;
}

const VOUCHER_BASE_FROM = `
  FROM loyalty_client_bonus_vouchers v
  INNER JOIN account_holders ah ON ah.user_id = v.user_id
  LEFT JOIN topup_methods tm ON tm.id = v.topup_method_id
`;

async function countPlatformDuplicates(platformId, createdAt) {
  if (!platformId) {
    return { daily_count: 0, monthly_count: 0, is_daily_duplicate: false, is_monthly_duplicate: false };
  }

  const created = new Date(createdAt);
  const createdDay = formatYmd(created);
  const monthStart = new Date(created);
  monthStart.setDate(monthStart.getDate() - 30);

  const duplicateScope = `
    rejection_reason IS NULL
    AND (
      is_claimed = 1
      OR DATEDIFF(NOW(), created_at) < 30
    )
  `;

  const dailyRows = await query(
    `SELECT COUNT(*) AS total
     FROM loyalty_client_bonus_vouchers
     WHERE platform_id = ?
       AND DATE(created_at) = ?
       AND ${duplicateScope}`,
    [platformId, createdDay],
  );

  const monthlyRows = await query(
    `SELECT COUNT(*) AS total
     FROM loyalty_client_bonus_vouchers
     WHERE platform_id = ?
       AND created_at >= ?
       AND ${duplicateScope}`,
    [platformId, formatYmd(monthStart)],
  );

  const dailyCount = Number(dailyRows[0]?.total || 0);
  const monthlyCount = Number(monthlyRows[0]?.total || 0);

  return {
    daily_count: dailyCount,
    monthly_count: monthlyCount,
    is_daily_duplicate: dailyCount > 1,
    is_monthly_duplicate: monthlyCount > 1,
  };
}

function mapAdminVoucherRow(row, adminUsers, duplicates = null) {
  const amount = Number(row.amount || 0);
  const method = row.topup_method_name || '—';
  const status = mapVoucherStatus(row);
  const claimedAdmin = row.claimed_by_admin ? adminUsers[row.claimed_by_admin] : null;
  const rejectedAdmin = row.rejected_by_admin ? adminUsers[row.rejected_by_admin] : null;

  return {
    id: String(row.id),
    voucher_id: row.id,
    date: formatYmdHis(row.created_at),
    userId: row.account_number || `U-${row.user_id}`,
    customer: row.first_name || row.customer_name || '—',
    email: row.email || '—',
    platformId: row.platform_id || '—',
    amount: `$${amount.toFixed(2)}`,
    platform: method,
    method,
    token: row.voucher_token || '—',
    status,
    admin: claimedAdmin || rejectedAdmin || (status === 'Rejected' && isAutoRejected(row) ? 'Auto-rejected' : '—'),
    claimedBy: claimedAdmin || '—',
    claimedDate: row.claimed_at ? formatYmdHis(row.claimed_at) : null,
    rejectedDate: row.rejected_at ? formatYmdHis(row.rejected_at) : isAutoRejected(row) ? formatYmdHis(row.created_at) : null,
    rejectReason: row.rejection_reason || (isAutoRejected(row) ? 'Auto-rejected: Voucher expired after 30 days' : null),
    duplicates,
  };
}

export async function listVoucherClaimsForAdmin(params = {}) {
  const page = Math.max(1, Number(params.page) || 1);
  const perPage = Math.min(50, Math.max(1, Number(params.per_page) || 20));
  const offset = (page - 1) * perPage;
  const statusInput = params.status || 'Pending';
  const keyword = String(params.keyword ?? params.q ?? '').trim();
  const { fromDate, toDate } = buildAdminDateFilter(
    params.filter ?? params.duration,
    params.from_date ?? params.fromDate,
    params.to_date ?? params.toDate,
  );

  let sql = `SELECT v.*, ah.account_number, ah.first_name, ah.last_name, ah.email,
                    CONCAT(ah.first_name, ' ', ah.last_name) AS customer_name,
                    tm.topup_method_name
             ${VOUCHER_BASE_FROM}
             WHERE 1=1`;
  const values = [];

  sql = applyVoucherStatusFilter(sql, values, statusInput);

  if (fromDate) {
    sql += ` AND DATE(v.created_at) >= ?`;
    values.push(fromDate);
  }
  if (toDate) {
    sql += ` AND DATE(v.created_at) <= ?`;
    values.push(toDate);
  }
  if (keyword) {
    const term = `%${keyword}%`;
    sql += ` AND (
      CAST(v.id AS CHAR) LIKE ? OR
      v.platform_id LIKE ? OR
      v.voucher_token LIKE ? OR
      ah.account_number LIKE ? OR
      ah.first_name LIKE ? OR
      ah.last_name LIKE ? OR
      CAST(v.amount AS CHAR) LIKE ?
    )`;
    values.push(term, term, term, term, term, term, term);
  }

  const countRows = await query(`SELECT COUNT(*) AS total FROM (${sql}) AS voucher_claims`, values);
  const total = Number(countRows[0]?.total || 0);

  const orderBy =
    statusInput === 'Claimed' || statusInput === 'Rejected'
      ? 'v.updated_at DESC'
      : 'v.created_at DESC';

  const rows = await query(`${sql} ORDER BY ${orderBy} LIMIT ? OFFSET ?`, [
    ...values,
    perPage,
    offset,
  ]);

  const adminIds = rows.flatMap((row) => [row.claimed_by_admin, row.rejected_by_admin]);
  const adminUsers = await fetchAdminNames(adminIds);

  const includeDuplicates = statusInput === 'Pending';
  const claims = [];
  for (const row of rows) {
    const duplicates = includeDuplicates
      ? await countPlatformDuplicates(row.platform_id, row.created_at)
      : null;
    claims.push(mapAdminVoucherRow(row, adminUsers, duplicates));
  }

  return {
    claims,
    pagination: {
      page,
      per_page: perPage,
      total,
      total_pages: Math.max(1, Math.ceil(total / perPage)),
    },
  };
}

export async function completeVoucherClaim(adminUserId, payload = {}) {
  const voucherId = Number(payload.voucher_id ?? payload.voucherId ?? payload.id);

  if (!Number.isInteger(voucherId)) {
    throw validationError('Voucher id is required.');
  }

  const rows = await query(`SELECT * FROM loyalty_client_bonus_vouchers WHERE id = ? LIMIT 1`, [voucherId]);
  const voucher = rows[0];
  if (!voucher) {
    throw validationError('Voucher not found.', 404);
  }
  if (Number(voucher.is_claimed) === 1) {
    throw validationError('Voucher already claimed.', 400);
  }
  if (voucher.rejection_reason) {
    throw validationError('Voucher has been rejected.', 400);
  }

  await query(
    `UPDATE loyalty_client_bonus_vouchers
     SET is_claimed = 1, claimed_at = NOW(), claimed_by_admin = ?, updated_at = NOW()
     WHERE id = ?`,
    [adminUserId, voucherId],
  );

  await query(
    `INSERT INTO system_user_action_logs (system_user_action_id, admin_user_id, created_at, updated_at)
     VALUES (47, ?, NOW(), NOW())`,
    [adminUserId],
  );

  return {
    ok: true,
    error: false,
    message: 'Voucher claim completed successfully.',
    voucher_id: voucherId,
  };
}

export async function rejectVoucherClaim(adminUserId, payload = {}) {
  const voucherId = Number(payload.voucher_id ?? payload.voucherId ?? payload.id);
  const rejectionReason = String(payload.rejection_reason ?? payload.rejectionReason ?? '').trim();

  if (!Number.isInteger(voucherId)) {
    throw validationError('Voucher id is required.');
  }
  if (!rejectionReason) {
    throw validationError('Rejection reason is required.');
  }
  if (rejectionReason.length > 500) {
    throw validationError('Rejection reason must be 500 characters or less.');
  }

  const rows = await query(`SELECT * FROM loyalty_client_bonus_vouchers WHERE id = ? LIMIT 1`, [voucherId]);
  const voucher = rows[0];
  if (!voucher) {
    throw validationError('Voucher not found.', 404);
  }
  if (Number(voucher.is_claimed) === 1) {
    throw validationError('Voucher already claimed.', 400);
  }

  await query(
    `UPDATE loyalty_client_bonus_vouchers
     SET rejection_reason = ?, rejected_at = NOW(), rejected_by_admin = ?, is_claimed = 0, updated_at = NOW()
     WHERE id = ?`,
    [rejectionReason, adminUserId, voucherId],
  );

  await query(
    `INSERT INTO system_user_action_logs (system_user_action_id, admin_user_id, created_at, updated_at)
     VALUES (48, ?, NOW(), NOW())`,
    [adminUserId],
  );

  return {
    ok: true,
    error: false,
    message: 'Voucher claim rejected successfully.',
    voucher_id: voucherId,
  };
}

export async function checkVoucherDuplicatePlatformId(voucherId) {
  const id = Number(voucherId);
  if (!Number.isInteger(id)) {
    throw validationError('Voucher id is required.');
  }

  const rows = await query(`SELECT id, platform_id, created_at FROM loyalty_client_bonus_vouchers WHERE id = ? LIMIT 1`, [
    id,
  ]);
  const voucher = rows[0];
  if (!voucher) {
    throw validationError('Voucher not found.', 404);
  }

  const duplicates = await countPlatformDuplicates(voucher.platform_id, voucher.created_at);
  return {
    voucher_id: id,
    platform_id: voucher.platform_id,
    ...duplicates,
  };
}
