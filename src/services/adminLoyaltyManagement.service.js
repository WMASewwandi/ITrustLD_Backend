import { query } from '../config/database.js';
import { formatTimestampSl } from '../utils/slTime.js';

const VALID_IDENTIFIERS = [
  'POINT-COLLECTION',
  'POINT-COLLECTION-AFFILIATE',
  'BONUS',
  'BONUS-AFFILIATE',
  'SILVER-BONUS',
  'GOLD-BONUS',
  'DIAMOND-BONUS',
  'VIP-BONUS',
  'VVIP-BONUS',
];

const VALID_LOYALTY_LEVELS = ['SILVER', 'GOLD', 'DIAMOND', 'VIP', 'VVIP'];

function validationError(message, status = 422) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function normalizeAudience(audience) {
  const value = String(audience || 'standard').trim().toLowerCase();
  if (value === 'partner' || value === 'affiliate') return 'partner';
  return 'standard';
}

function formatYmdHis(value) {
  const formatted = formatTimestampSl(value);
  if (!formatted) return '—';
  return formatted;
}

function mapPointCollectionRow(row) {
  return {
    id: row.id,
    display_id: row.display_id,
    admin_id: row.admin_user_id,
    cal_amount: Number(row.cal_amount),
    is_active: Boolean(row.is_active),
    changed_date: formatYmdHis(row.updated_at),
  };
}

function mapBonusRow(row) {
  return {
    id: row.id,
    display_id: row.display_id,
    admin_id: row.admin_user_id,
    bonus_amount: Number(row.bonus_amount),
    is_active: Boolean(row.is_active),
    changed_date: formatYmdHis(row.updated_at),
  };
}

function mapLevelRow(row) {
  return {
    id: row.id,
    display_id: row.display_id,
    admin_id: row.admin_user_id,
    client_bonus_amount: Number(row.client_bonus_amount),
    client_count: Number(row.client_count),
    loyalty_level: row.loyalty_level,
    is_active: Boolean(row.is_active),
    changed_date: formatYmdHis(row.updated_at),
  };
}

function mapConfigRow(row) {
  return {
    identifier: row.identifier,
    is_active: Boolean(row.is_active),
    date_activated: row.date_activated,
    date_deactivated: row.date_deactivated,
  };
}

async function fetchMasterConfigs() {
  const rows = await query(
    `SELECT identifier, is_active, date_activated, date_deactivated
     FROM loyalty_management_configs`,
  );
  const map = {};
  for (const row of rows) {
    map[row.identifier] = mapConfigRow(row);
  }
  return map;
}

async function fetchTopPointEarners(isPartner) {
  const partnerFlag = isPartner ? 'YES' : 'NO';
  const rows = await query(
    `SELECT
       ah.id AS account_holder_id,
       ah.account_number,
       ah.first_name,
       ah.last_name,
       ah.email,
       ah.mobile_number,
       ranked.total_points
     FROM (
       SELECT pe.user_id, SUM(pe.point_earning_amount) AS total_points
       FROM point_earnings pe
       INNER JOIN account_holders ah2 ON pe.user_id = ah2.user_id
       WHERE ah2.is_patner = ?
       GROUP BY pe.user_id
       ORDER BY total_points DESC
       LIMIT 50
     ) ranked
     INNER JOIN account_holders ah ON ah.user_id = ranked.user_id
     ORDER BY ranked.total_points DESC`,
    [partnerFlag],
  );

  return rows.map((row) => ({
    account_holder_id: row.account_holder_id,
    user_id: row.account_number,
    name: [row.first_name, row.last_name].filter(Boolean).join(' ').trim() || '—',
    email: row.email || '—',
    mobile_number: row.mobile_number || '—',
    total_points: Number(row.total_points) || 0,
    total_points_display: Number(row.total_points || 0).toLocaleString('en-US'),
  }));
}

export async function getLoyaltyManagementData(audience) {
  const normalizedAudience = normalizeAudience(audience);
  const isAffiliate = normalizedAudience === 'partner';

  const [masterConfigs, pointRows, bonusRows] = await Promise.all([
    fetchMasterConfigs(),
    query(
      `SELECT id, display_id, cal_amount, is_affiliate, is_active, is_deleted, admin_user_id, updated_at
       FROM loyalty_management_point_collections
       WHERE is_affiliate = ?
         AND (is_deleted = 0 OR is_deleted IS NULL OR is_deleted = FALSE)
       ORDER BY display_id DESC
       LIMIT 5`,
      [isAffiliate ? 1 : 0],
    ),
    query(
      `SELECT id, display_id, bonus_amount, is_affiliate, is_active, is_deleted, admin_user_id, updated_at
       FROM loyalty_management_bonuses
       WHERE is_affiliate = ?
         AND (is_deleted = 0 OR is_deleted IS NULL OR is_deleted = FALSE)
       ORDER BY display_id DESC
       LIMIT 5`,
      [isAffiliate ? 1 : 0],
    ),
  ]);

  let loyaltyLevels = null;
  if (isAffiliate) {
    const levelRows = await query(
      `SELECT id, display_id, client_bonus_amount, client_count, is_active, loyalty_level, is_deleted, admin_user_id, updated_at
       FROM loyalty_management_levels
       WHERE loyalty_level IN ('SILVER', 'GOLD', 'DIAMOND', 'VIP', 'VVIP')
         AND (is_deleted = 0 OR is_deleted IS NULL OR is_deleted = FALSE)
       ORDER BY FIELD(loyalty_level, 'SILVER', 'GOLD', 'DIAMOND', 'VIP', 'VVIP'), display_id DESC`,
    );

    loyaltyLevels = {
      SILVER: [],
      GOLD: [],
      DIAMOND: [],
      VIP: [],
      VVIP: [],
    };

    for (const row of levelRows) {
      const key = String(row.loyalty_level || '').trim().toUpperCase();
      if (!loyaltyLevels[key]) continue;
      if (loyaltyLevels[key].length >= 5) continue;
      loyaltyLevels[key].push(mapLevelRow({ ...row, loyalty_level: key }));
    }
  }

  const topEarners = await fetchTopPointEarners(isAffiliate);

  return {
    audience: normalizedAudience,
    configs: {
      point_collection: masterConfigs[isAffiliate ? 'POINT-COLLECTION-AFFILIATE' : 'POINT-COLLECTION'] || null,
      bonus: masterConfigs[isAffiliate ? 'BONUS-AFFILIATE' : 'BONUS'] || null,
      silver_bonus: masterConfigs['SILVER-BONUS'] || null,
      gold_bonus: masterConfigs['GOLD-BONUS'] || null,
      diamond_bonus: masterConfigs['DIAMOND-BONUS'] || null,
      vip_bonus: masterConfigs['VIP-BONUS'] || null,
      vvip_bonus: masterConfigs['VVIP-BONUS'] || null,
    },
    point_collections: pointRows.map(mapPointCollectionRow),
    bonuses: bonusRows.map(mapBonusRow),
    loyalty_levels: loyaltyLevels,
    top_earners: topEarners,
  };
}

export async function updateMasterConfigActivationState({ identifier, activationState }) {
  const configIdentifier = String(identifier || '').trim();
  if (!VALID_IDENTIFIERS.includes(configIdentifier)) {
    throw validationError('Invalid loyalty management config identifier.');
  }

  const active = Boolean(activationState);
  const rows = await query(
    `SELECT id FROM loyalty_management_configs WHERE identifier = ? LIMIT 1`,
    [configIdentifier],
  );
  if (!rows[0]) {
    throw validationError('Invalid loyalty management config identifier.');
  }

  if (active) {
    await query(
      `UPDATE loyalty_management_configs
       SET is_active = 1, date_activated = NOW(), updated_at = NOW()
       WHERE identifier = ?`,
      [configIdentifier],
    );
  } else {
    await query(
      `UPDATE loyalty_management_configs
       SET is_active = 0, date_deactivated = NOW(), updated_at = NOW()
       WHERE identifier = ?`,
      [configIdentifier],
    );
  }

  return {
    ok: true,
    error: false,
    message: active
      ? `Loyalty management config ${configIdentifier} activated successfully.`
      : `Loyalty management config ${configIdentifier} de-activated successfully.`,
  };
}

async function getNextDisplayId(table, extraWhere = '', params = []) {
  const rows = await query(
    `SELECT display_id
     FROM ${table}
     ${extraWhere}
     ORDER BY display_id DESC
     LIMIT 1`,
    params,
  );
  return rows[0] ? Number(rows[0].display_id) + 1 : 1;
}

export async function createPointCollection(adminUserId, { calAmount, isAffiliate }) {
  const amount = Number(calAmount);
  if (!Number.isInteger(amount) || amount < 0) {
    throw validationError('Cal amount must be a valid integer.');
  }

  const affiliate = Boolean(isAffiliate);
  const displayId = await getNextDisplayId(
    'loyalty_management_point_collections',
    'WHERE is_affiliate = ?',
    [affiliate ? 1 : 0],
  );

  const result = await query(
    `INSERT INTO loyalty_management_point_collections
       (display_id, cal_amount, is_affiliate, is_active, is_deleted, admin_user_id, created_at, updated_at)
     VALUES (?, ?, ?, 1, 0, ?, NOW(), NOW())`,
    [displayId, amount, affiliate ? 1 : 0, adminUserId],
  );

  const rows = await query(
    `SELECT id, display_id, cal_amount, is_affiliate, is_active, is_deleted, admin_user_id, updated_at
     FROM loyalty_management_point_collections
     WHERE id = ?
     LIMIT 1`,
    [result.insertId],
  );

  return {
    ok: true,
    error: false,
    point_collection: mapPointCollectionRow(rows[0]),
  };
}

export async function updatePointCollectionAmount({ pointCollectionId, calAmount }) {
  const id = Number(pointCollectionId);
  const amount = Number(calAmount);
  if (!Number.isInteger(id) || id <= 0) {
    throw validationError('Invalid loyalty management point collection id.');
  }
  if (!Number.isInteger(amount) || amount < 0) {
    throw validationError('Cal amount must be a valid integer.');
  }

  const rows = await query(
    `SELECT id FROM loyalty_management_point_collections WHERE id = ? LIMIT 1`,
    [id],
  );
  if (!rows[0]) {
    throw validationError('Invalid loyalty management point collection id.');
  }

  await query(
    `UPDATE loyalty_management_point_collections
     SET cal_amount = ?, updated_at = NOW()
     WHERE id = ?`,
    [amount, id],
  );

  return {
    ok: true,
    error: false,
    message: 'Loyalty management point collection cal amount is updated successfully.',
  };
}

export async function updatePointCollectionActivationState({ pointCollectionId, activationState }) {
  const id = Number(pointCollectionId);
  if (!Number.isInteger(id) || id <= 0) {
    throw validationError('Invalid loyalty management point collection id.');
  }

  const rows = await query(
    `SELECT id FROM loyalty_management_point_collections WHERE id = ? LIMIT 1`,
    [id],
  );
  if (!rows[0]) {
    throw validationError('Invalid loyalty management point collection id.');
  }

  const active = Boolean(activationState);
  await query(
    `UPDATE loyalty_management_point_collections
     SET is_active = ?, updated_at = NOW()
     WHERE id = ?`,
    [active ? 1 : 0, id],
  );

  return {
    ok: true,
    error: false,
    message: active
      ? 'Loyalty management point collection activated successfully.'
      : 'Loyalty management point collection de-activated successfully.',
  };
}

export async function deletePointCollection({ pointCollectionId }) {
  const id = Number(pointCollectionId);
  if (!Number.isInteger(id) || id <= 0) {
    throw validationError('Invalid loyalty management point collection id.');
  }

  const rows = await query(
    `SELECT id FROM loyalty_management_point_collections WHERE id = ? LIMIT 1`,
    [id],
  );
  if (!rows[0]) {
    throw validationError('Invalid loyalty management point collection id.');
  }

  await query(
    `UPDATE loyalty_management_point_collections
     SET is_deleted = 1, updated_at = NOW()
     WHERE id = ?`,
    [id],
  );

  return {
    ok: true,
    error: false,
    message: 'Loyalty management point collection deleted successfully.',
  };
}

export async function createBonus(adminUserId, { bonusAmount, isAffiliate }) {
  const amount = Number(bonusAmount);
  if (!Number.isInteger(amount) || amount < 0) {
    throw validationError('Bonus amount must be a valid integer.');
  }

  const affiliate = Boolean(isAffiliate);
  const displayId = await getNextDisplayId(
    'loyalty_management_bonuses',
    'WHERE is_affiliate = ?',
    [affiliate ? 1 : 0],
  );

  const result = await query(
    `INSERT INTO loyalty_management_bonuses
       (display_id, bonus_amount, is_affiliate, is_active, is_deleted, admin_user_id, created_at, updated_at)
     VALUES (?, ?, ?, 1, 0, ?, NOW(), NOW())`,
    [displayId, amount, affiliate ? 1 : 0, adminUserId],
  );

  const rows = await query(
    `SELECT id, display_id, bonus_amount, is_affiliate, is_active, is_deleted, admin_user_id, updated_at
     FROM loyalty_management_bonuses
     WHERE id = ?
     LIMIT 1`,
    [result.insertId],
  );

  return {
    ok: true,
    error: false,
    bonus: mapBonusRow(rows[0]),
  };
}

export async function updateBonusAmount({ bonusId, bonusAmount }) {
  const id = Number(bonusId);
  const amount = Number(bonusAmount);
  if (!Number.isInteger(id) || id <= 0) {
    throw validationError('Invalid loyalty management bonus id.');
  }
  if (!Number.isInteger(amount) || amount < 0) {
    throw validationError('Bonus amount must be a valid integer.');
  }

  const rows = await query(
    `SELECT id FROM loyalty_management_bonuses WHERE id = ? LIMIT 1`,
    [id],
  );
  if (!rows[0]) {
    throw validationError('Invalid loyalty management bonus id.');
  }

  await query(
    `UPDATE loyalty_management_bonuses
     SET bonus_amount = ?, updated_at = NOW()
     WHERE id = ?`,
    [amount, id],
  );

  return {
    ok: true,
    error: false,
    message: 'Loyalty management bonus amount is updated successfully.',
  };
}

export async function updateBonusActivationState({ bonusId, activationState }) {
  const id = Number(bonusId);
  if (!Number.isInteger(id) || id <= 0) {
    throw validationError('Invalid loyalty management bonus id.');
  }

  const rows = await query(
    `SELECT id FROM loyalty_management_bonuses WHERE id = ? LIMIT 1`,
    [id],
  );
  if (!rows[0]) {
    throw validationError('Invalid loyalty management bonus id.');
  }

  const active = Boolean(activationState);
  await query(
    `UPDATE loyalty_management_bonuses
     SET is_active = ?, updated_at = NOW()
     WHERE id = ?`,
    [active ? 1 : 0, id],
  );

  return {
    ok: true,
    error: false,
    message: active
      ? 'Loyalty management bonus activated successfully.'
      : 'Loyalty management bonus de-activated successfully.',
  };
}

export async function deleteBonus({ bonusId }) {
  const id = Number(bonusId);
  if (!Number.isInteger(id) || id <= 0) {
    throw validationError('Invalid loyalty management bonus id.');
  }

  const rows = await query(
    `SELECT id FROM loyalty_management_bonuses WHERE id = ? LIMIT 1`,
    [id],
  );
  if (!rows[0]) {
    throw validationError('Invalid loyalty management bonus id.');
  }

  await query(
    `UPDATE loyalty_management_bonuses
     SET is_deleted = 1, updated_at = NOW()
     WHERE id = ?`,
    [id],
  );

  return {
    ok: true,
    error: false,
    message: 'Loyalty management bonus deleted successfully.',
  };
}

export async function createLoyaltyLevel(adminUserId, { clientBonusAmount, clientCount, loyaltyLevel }) {
  const bonusAmount = Number(clientBonusAmount);
  const count = Number(clientCount);
  const level = String(loyaltyLevel || '').trim().toUpperCase();

  if (!Number.isInteger(bonusAmount) || bonusAmount < 0) {
    throw validationError('Client bonus amount must be a valid integer.');
  }
  if (!Number.isInteger(count) || count < 0) {
    throw validationError('Client count must be a valid integer.');
  }
  if (!VALID_LOYALTY_LEVELS.includes(level)) {
    throw validationError('Invalid loyalty level.');
  }

  const displayId = await getNextDisplayId(
    'loyalty_management_levels',
    'WHERE loyalty_level = ?',
    [level],
  );

  const result = await query(
    `INSERT INTO loyalty_management_levels
       (display_id, client_bonus_amount, client_count, is_active, loyalty_level, is_deleted, admin_user_id, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, 0, ?, NOW(), NOW())`,
    [displayId, bonusAmount, count, level, adminUserId],
  );

  const rows = await query(
    `SELECT id, display_id, client_bonus_amount, client_count, is_active, loyalty_level, is_deleted, admin_user_id, updated_at
     FROM loyalty_management_levels
     WHERE id = ?
     LIMIT 1`,
    [result.insertId],
  );

  return {
    ok: true,
    error: false,
    loyalty_level: mapLevelRow(rows[0]),
  };
}

export async function updateLoyaltyLevel({ loyaltyLevelId, clientBonusAmount, clientCount }) {
  const id = Number(loyaltyLevelId);
  const bonusAmount = Number(clientBonusAmount);
  const count = Number(clientCount);

  if (!Number.isInteger(id) || id <= 0) {
    throw validationError('Invalid loyalty management level reference.');
  }
  if (!Number.isInteger(bonusAmount) || bonusAmount < 0) {
    throw validationError('Client bonus amount must be a valid integer.');
  }
  if (!Number.isInteger(count) || count < 0) {
    throw validationError('Client count must be a valid integer.');
  }

  const rows = await query(
    `SELECT id FROM loyalty_management_levels WHERE id = ? LIMIT 1`,
    [id],
  );
  if (!rows[0]) {
    throw validationError('Invalid loyalty management level reference.');
  }

  await query(
    `UPDATE loyalty_management_levels
     SET client_bonus_amount = ?, client_count = ?, updated_at = NOW()
     WHERE id = ?`,
    [bonusAmount, count, id],
  );

  return {
    ok: true,
    error: false,
    message: 'Loyalty management level is updated successfully.',
  };
}

export async function updateLoyaltyLevelActivationState({ loyaltyLevelId, activationState }) {
  const id = Number(loyaltyLevelId);
  if (!Number.isInteger(id) || id <= 0) {
    throw validationError('Invalid loyalty management level reference.');
  }

  const rows = await query(
    `SELECT id FROM loyalty_management_levels WHERE id = ? LIMIT 1`,
    [id],
  );
  if (!rows[0]) {
    throw validationError('Invalid loyalty management level reference.');
  }

  const active = Boolean(activationState);
  await query(
    `UPDATE loyalty_management_levels
     SET is_active = ?, updated_at = NOW()
     WHERE id = ?`,
    [active ? 1 : 0, id],
  );

  return {
    ok: true,
    error: false,
    message: active
      ? 'Loyalty management level activated successfully.'
      : 'Loyalty management level de-activated successfully.',
  };
}

export async function deleteLoyaltyLevel({ loyaltyLevelId }) {
  const id = Number(loyaltyLevelId);
  if (!Number.isInteger(id) || id <= 0) {
    throw validationError('Invalid loyalty management level id.');
  }

  const rows = await query(
    `SELECT id FROM loyalty_management_levels WHERE id = ? LIMIT 1`,
    [id],
  );
  if (!rows[0]) {
    throw validationError('Invalid loyalty management level id.');
  }

  await query(
    `UPDATE loyalty_management_levels
     SET is_deleted = 1, updated_at = NOW()
     WHERE id = ?`,
    [id],
  );

  return {
    ok: true,
    error: false,
    message: 'Loyalty management level deleted successfully.',
  };
}
