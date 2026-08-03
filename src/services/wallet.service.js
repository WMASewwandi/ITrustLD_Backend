import { query } from '../config/database.js';
import { resolveWalletLogoPublicUrl, storeWalletLogo } from './walletLogoStorage.service.js';

const WALLET_CONFIG = {
  topup: {
    table: 'topup_methods',
    nameColumn: 'topup_method_name',
    currencyColumn: 'topup_method_currency',
    logoColumn: 'topup_method_logo',
    idTypeColumn: 'topup_method_id_type',
    walletType: 'topup',
  },
  cashout: {
    table: 'cashout_methods',
    nameColumn: 'cashout_method_name',
    currencyColumn: 'cashout_method_currency',
    logoColumn: 'cashout_method_logo',
    idTypeColumn: 'cashout_method_id_type',
    walletType: 'cashout',
  },
};

function validationError(message, status = 422) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function parsePaymentMethodIds(value) {
  if (Array.isArray(value)) {
    return value.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0);
  }
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0);
      }
    } catch {
      return value
        .split(',')
        .map((part) => Number(part.trim()))
        .filter((id) => Number.isInteger(id) && id > 0);
    }
  }
  return [];
}

function validateWalletPayload({ name, currency, minLimit, maxLimit, platformType, terms }) {
  const walletName = String(name || '').trim();
  const walletCurrency = String(currency || '').trim();
  const walletPlatformType = String(platformType || '').trim();
  const walletTerms = String(terms ?? '').trim();
  const minimumLimit = Number(minLimit);
  const maximumLimit = Number(maxLimit);

  if (!walletName) throw validationError('Wallet name is required.');
  if (!walletCurrency) throw validationError('Currency is required.');
  if (!walletPlatformType) throw validationError('Platform type is required.');
  if (!walletTerms) throw validationError('Terms & conditions are required.');
  if (!Number.isFinite(minimumLimit)) throw validationError('Minimum limit is required.');
  if (!Number.isFinite(maximumLimit)) throw validationError('Maximum limit is required.');

  return {
    name: walletName,
    currency: walletCurrency,
    platformType: walletPlatformType,
    terms: walletTerms,
    minimumLimit,
    maximumLimit,
  };
}

async function getActivePaymentOptionsForWallet(walletId, walletType) {
  const rows = await query(
    `SELECT po.id, po.payment_option_name
     FROM wallet_supported_payment_options wspo
     INNER JOIN payment_options po ON po.id = wspo.payment_option_id
     WHERE wspo.wallet_id = ?
       AND wspo.wallet_type = ?
       AND UPPER(wspo.status) = 'ACTIVE'
       AND (po.is_deleted = 0 OR po.is_deleted IS NULL)
     ORDER BY po.id`,
    [walletId, walletType],
  );
  return rows;
}

async function mapWalletRow(row, kind) {
  const config = WALLET_CONFIG[kind];
  const paymentOptions = await getActivePaymentOptionsForWallet(row.id, config.walletType);
  const logo = row[config.logoColumn];

  return {
    id: row.id,
    name: row[config.nameColumn] || '',
    currency: row[config.currencyColumn] || '',
    platformType: row.platform_id_type || row[config.idTypeColumn] || '',
    minLimit: Number(row.minimum_limit ?? 0),
    maxLimit: Number(row.maximum_limit ?? 0),
    terms: row.tnc || '',
    active: row.availability === 'AVAILABLE',
    availability: row.availability,
    logo,
    logoName: logo,
    logoUrl: resolveWalletLogoPublicUrl(logo),
    paymentMethodIds: paymentOptions.map((option) => option.id),
    paymentMethods: paymentOptions.map((option) => option.payment_option_name),
  };
}

async function findWalletById(kind, walletId) {
  const config = WALLET_CONFIG[kind];
  const rows = await query(
    `SELECT *
     FROM ${config.table}
     WHERE id = ?
       AND (is_deleted = 0 OR is_deleted IS NULL)
     LIMIT 1`,
    [walletId],
  );
  if (!rows[0]) return null;
  return mapWalletRow(rows[0], kind);
}

async function syncWalletPaymentOptions(walletId, walletType, checkedPaymentMethodIds) {
  const paymentMethods = await query(
    `SELECT id FROM payment_options WHERE is_deleted = 0 OR is_deleted IS NULL`,
  );

  for (const paymentMethod of paymentMethods) {
    const shouldBeActive = checkedPaymentMethodIds.includes(paymentMethod.id);
    const existing = await query(
      `SELECT id
       FROM wallet_supported_payment_options
       WHERE wallet_id = ?
         AND wallet_type = ?
         AND payment_option_id = ?
       LIMIT 1`,
      [walletId, walletType, paymentMethod.id],
    );

    if (existing[0]) {
      await query(
        `UPDATE wallet_supported_payment_options
         SET status = ?, updated_at = NOW()
         WHERE id = ?`,
        [shouldBeActive ? 'ACTIVE' : 'INACTIVE', existing[0].id],
      );
    } else if (shouldBeActive) {
      await query(
        `INSERT INTO wallet_supported_payment_options
           (wallet_id, wallet_type, payment_option_id, status, created_at, updated_at)
         VALUES (?, ?, ?, 'ACTIVE', NOW(), NOW())`,
        [walletId, walletType, paymentMethod.id],
      );
    }
  }
}

async function createWalletPaymentOptions(walletId, walletType, checkedPaymentMethodIds) {
  for (const paymentOptionId of checkedPaymentMethodIds) {
    await query(
      `INSERT INTO wallet_supported_payment_options
         (wallet_id, wallet_type, payment_option_id, status, created_at, updated_at)
       VALUES (?, ?, ?, 'ACTIVE', NOW(), NOW())`,
      [walletId, walletType, paymentOptionId],
    );
  }
}

export async function getTopupWalletById(walletId) {
  return findWalletById('topup', walletId);
}

export async function getCashoutWalletById(walletId) {
  return findWalletById('cashout', walletId);
}

export async function getWalletFormMeta() {
  const [paymentOptions, currencyTypes] = await Promise.all([
    query(
      `SELECT id, payment_option_name
       FROM payment_options
       WHERE is_deleted = 0 OR is_deleted IS NULL
       ORDER BY id`,
    ),
    query(
      `SELECT code
       FROM currency_types
       WHERE (is_deleted = 0 OR is_deleted IS NULL)
         AND UPPER(status) = 'ACTIVE'
       ORDER BY id`,
    ),
  ]);

  return {
    paymentOptions: paymentOptions.map((row) => ({
      id: row.id,
      name: row.payment_option_name,
    })),
    currencyTypes: currencyTypes.map((row) => row.code),
    platformTypes: ['INT', 'Email', 'Mobile', 'Text', 'Vachar'],
  };
}

export async function listTopupWallets() {
  const config = WALLET_CONFIG.topup;
  const rows = await query(
    `SELECT *
     FROM ${config.table}
     WHERE is_deleted = 0 OR is_deleted IS NULL
     ORDER BY id DESC`,
  );
  return Promise.all(rows.map((row) => mapWalletRow(row, 'topup')));
}

export async function listCashoutWallets() {
  const config = WALLET_CONFIG.cashout;
  const rows = await query(
    `SELECT *
     FROM ${config.table}
     WHERE is_deleted = 0 OR is_deleted IS NULL
     ORDER BY id DESC`,
  );
  return Promise.all(rows.map((row) => mapWalletRow(row, 'cashout')));
}

export async function createTopupWallet(payload, logoFile) {
  const validated = validateWalletPayload(payload);
  const paymentMethodIds = parsePaymentMethodIds(payload.paymentMethodIds);
  if (paymentMethodIds.length === 0) {
    throw validationError('At least one payment method is required.');
  }

  const config = WALLET_CONFIG.topup;
  const logo = logoFile ? await storeWalletLogo(logoFile) : null;

  const result = await query(
    `INSERT INTO ${config.table}
       (${config.nameColumn}, ${config.currencyColumn}, minimum_limit, maximum_limit,
        platform_id_type, ${config.idTypeColumn}, tnc, availability, ${config.logoColumn},
        is_deleted, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'AVAILABLE', ?, 0, NOW(), NOW())`,
    [
      validated.name,
      validated.currency,
      validated.minimumLimit,
      validated.maximumLimit,
      validated.platformType,
      validated.platformType,
      validated.terms,
      logo,
    ],
  );

  const walletId = result.insertId;
  await createWalletPaymentOptions(walletId, config.walletType, paymentMethodIds);
  return findWalletById('topup', walletId);
}

export async function createCashoutWallet(payload, logoFile) {
  const validated = validateWalletPayload(payload);
  const paymentMethodIds = parsePaymentMethodIds(payload.paymentMethodIds);
  if (paymentMethodIds.length === 0) {
    throw validationError('At least one payment method is required.');
  }

  const config = WALLET_CONFIG.cashout;
  const logo = logoFile ? await storeWalletLogo(logoFile) : null;

  const result = await query(
    `INSERT INTO ${config.table}
       (${config.nameColumn}, ${config.currencyColumn}, minimum_limit, maximum_limit,
        platform_id_type, ${config.idTypeColumn}, tnc, availability, ${config.logoColumn},
        is_deleted, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'AVAILABLE', ?, 0, NOW(), NOW())`,
    [
      validated.name,
      validated.currency,
      validated.minimumLimit,
      validated.maximumLimit,
      validated.platformType,
      validated.platformType,
      validated.terms,
      logo,
    ],
  );

  const walletId = result.insertId;
  await createWalletPaymentOptions(walletId, config.walletType, paymentMethodIds);
  return findWalletById('cashout', walletId);
}

export async function updateTopupWallet(walletId, payload, logoFile) {
  const existing = await findWalletById('topup', walletId);
  if (!existing) throw validationError('Top-up wallet not found.', 404);

  const validated = validateWalletPayload(payload);
  const paymentMethodIds = parsePaymentMethodIds(payload.paymentMethodIds);
  if (paymentMethodIds.length === 0) {
    throw validationError('At least one payment method is required.');
  }

  const config = WALLET_CONFIG.topup;
  const logo = logoFile ? await storeWalletLogo(logoFile) : existing.logo;

  await query(
    `UPDATE ${config.table}
     SET ${config.nameColumn} = ?,
         ${config.currencyColumn} = ?,
         minimum_limit = ?,
         maximum_limit = ?,
         platform_id_type = ?,
         ${config.idTypeColumn} = ?,
         tnc = ?,
         ${config.logoColumn} = ?,
         updated_at = NOW()
     WHERE id = ?`,
    [
      validated.name,
      validated.currency,
      validated.minimumLimit,
      validated.maximumLimit,
      validated.platformType,
      validated.platformType,
      validated.terms,
      logo,
      walletId,
    ],
  );

  await syncWalletPaymentOptions(walletId, config.walletType, paymentMethodIds);
  return findWalletById('topup', walletId);
}

export async function updateCashoutWallet(walletId, payload, logoFile) {
  const existing = await findWalletById('cashout', walletId);
  if (!existing) throw validationError('Cash-out wallet not found.', 404);

  const validated = validateWalletPayload(payload);
  const paymentMethodIds = parsePaymentMethodIds(payload.paymentMethodIds);
  if (paymentMethodIds.length === 0) {
    throw validationError('At least one payment method is required.');
  }

  const config = WALLET_CONFIG.cashout;
  const logo = logoFile ? await storeWalletLogo(logoFile) : existing.logo;

  await query(
    `UPDATE ${config.table}
     SET ${config.nameColumn} = ?,
         ${config.currencyColumn} = ?,
         minimum_limit = ?,
         maximum_limit = ?,
         platform_id_type = ?,
         ${config.idTypeColumn} = ?,
         tnc = ?,
         ${config.logoColumn} = ?,
         updated_at = NOW()
     WHERE id = ?`,
    [
      validated.name,
      validated.currency,
      validated.minimumLimit,
      validated.maximumLimit,
      validated.platformType,
      validated.platformType,
      validated.terms,
      logo,
      walletId,
    ],
  );

  await syncWalletPaymentOptions(walletId, config.walletType, paymentMethodIds);
  return findWalletById('cashout', walletId);
}

export async function deleteTopupWallet(walletId) {
  const existing = await findWalletById('topup', walletId);
  if (!existing) throw validationError('Top-up wallet not found.', 404);

  await query(
    `UPDATE ${WALLET_CONFIG.topup.table}
     SET is_deleted = 1, updated_at = NOW()
     WHERE id = ?`,
    [walletId],
  );

  return { ok: true, id: walletId };
}

export async function deleteCashoutWallet(walletId) {
  const existing = await findWalletById('cashout', walletId);
  if (!existing) throw validationError('Cash-out wallet not found.', 404);

  await query(
    `UPDATE ${WALLET_CONFIG.cashout.table}
     SET is_deleted = 1, updated_at = NOW()
     WHERE id = ?`,
    [walletId],
  );

  return { ok: true, id: walletId };
}

export async function toggleTopupWalletStatus(walletId, active) {
  const existing = await findWalletById('topup', walletId);
  if (!existing) throw validationError('Top-up wallet not found.', 404);

  const availability = active ? 'AVAILABLE' : 'NOT_AVAILABLE';
  await query(
    `UPDATE ${WALLET_CONFIG.topup.table}
     SET availability = ?, updated_at = NOW()
     WHERE id = ?`,
    [availability, walletId],
  );

  return findWalletById('topup', walletId);
}

export async function toggleCashoutWalletStatus(walletId, active) {
  const existing = await findWalletById('cashout', walletId);
  if (!existing) throw validationError('Cash-out wallet not found.', 404);

  const availability = active ? 'AVAILABLE' : 'NOT_AVAILABLE';
  await query(
    `UPDATE ${WALLET_CONFIG.cashout.table}
     SET availability = ?, updated_at = NOW()
     WHERE id = ?`,
    [availability, walletId],
  );

  return findWalletById('cashout', walletId);
}
