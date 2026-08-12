import { getDbDriver, query } from '../config/database.js';
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

let topupVoucherFlagSchemaReady = false;
let walletNavigateSchemaReady = false;

function validationError(message, status = 422) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function parseBooleanFlag(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

async function tableHasColumn(tableName, columnName) {
  if (getDbDriver() === 'sqlite') {
    const rows = await query(`PRAGMA table_info(${tableName})`);
    return rows.some((row) => String(row.name).toLowerCase() === String(columnName).toLowerCase());
  }
  const rows = await query(
    `SELECT COLUMN_NAME AS name
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
       AND COLUMN_NAME = ?
     LIMIT 1`,
    [tableName, columnName],
  );
  return Boolean(rows[0]);
}

function mapPlatformTypeForWalletCatalog(platformTypes) {
  const first = platformTypes?.[0] || 'INT';
  const upper = String(first).trim().toUpperCase();
  if (upper === 'EMAIL') return 'EMAIL';
  if (upper === 'MOBILE') return 'MOBILE';
  if (upper === 'TEXT') return 'TEXT';
  if (upper === 'VACHAR' || upper === 'VARCHAR') return 'VARCHAR';
  return 'INT';
}

async function resolveOrCreateWalletCatalogId(methodName, platformTypes) {
  const name = String(methodName || '').trim();
  if (!name) return null;

  const identifier = name.toUpperCase();
  const existing = await query(
    `SELECT id
     FROM wallets
     WHERE UPPER(wallet_identifier) = ?
        OR UPPER(wallet_name) = ?
     LIMIT 1`,
    [identifier, identifier],
  );
  if (existing[0]) return existing[0].id;

  const platformType = mapPlatformTypeForWalletCatalog(platformTypes);
  const result = await query(
    `INSERT INTO wallets (wallet_identifier, wallet_name, platform_id_type, created_at, updated_at)
     VALUES (?, ?, ?, NOW(), NOW())`,
    [identifier, name, platformType],
  );
  return result.insertId;
}

async function methodHasExchangeRates(kind, methodId) {
  const rateTable = kind === 'topup' ? 'deposit_rates' : 'withdrawal_rates';
  const methodIdColumn = kind === 'topup' ? 'topup_method_id' : 'cashout_method_id';
  const rows = await query(
    `SELECT id
     FROM ${rateTable}
     WHERE ${methodIdColumn} = ?
       AND (is_deleted = 0 OR is_deleted IS NULL)
     LIMIT 1`,
    [methodId],
  );
  return Boolean(rows[0]);
}

async function copyExchangeRatesFromPreviousMethod(kind, newMethodId, catalogWalletId, methodName) {
  const config = WALLET_CONFIG[kind];
  const rateTable = kind === 'topup' ? 'deposit_rates' : 'withdrawal_rates';
  const methodIdColumn = kind === 'topup' ? 'topup_method_id' : 'cashout_method_id';

  let previousMethodId = null;
  if (catalogWalletId) {
    const previousMethods = await query(
      `SELECT id
       FROM ${config.table}
       WHERE wallet_id = ?
         AND id != ?
       ORDER BY id DESC`,
      [catalogWalletId, newMethodId],
    );
    previousMethodId = previousMethods[0]?.id ?? null;
  }

  if (!previousMethodId && methodName) {
    const byName = await query(
      `SELECT id
       FROM ${config.table}
       WHERE UPPER(${config.nameColumn}) = UPPER(?)
         AND id != ?
       ORDER BY id DESC
       LIMIT 1`,
      [methodName, newMethodId],
    );
    previousMethodId = byName[0]?.id ?? null;
  }

  if (!previousMethodId) return;

  const rateRows = await query(
    `SELECT admin_id, payment_option_id, rate
     FROM ${rateTable}
     WHERE ${methodIdColumn} = ?
       AND (is_deleted = 0 OR is_deleted IS NULL)
     ORDER BY id DESC`,
    [previousMethodId],
  );

  const seen = new Set();
  for (const row of rateRows) {
    const key = String(row.payment_option_id);
    if (seen.has(key)) continue;
    seen.add(key);
    await query(
      `INSERT INTO ${rateTable}
         (admin_id, ${methodIdColumn}, payment_option_id, rate, applicable_date, is_deleted, created_at, updated_at)
       VALUES (?, ?, ?, ?, NOW(), 0, NOW(), NOW())`,
      [row.admin_id ?? null, newMethodId, row.payment_option_id, row.rate],
    );
  }
}

async function ensureMethodWalletCatalogLink(
  kind,
  methodId,
  methodName,
  platformTypes,
  { copyRates = false } = {},
) {
  const config = WALLET_CONFIG[kind];
  const hasWalletId = await tableHasColumn(config.table, 'wallet_id');
  if (!hasWalletId) return null;

  const current = await query(`SELECT wallet_id FROM ${config.table} WHERE id = ? LIMIT 1`, [
    methodId,
  ]);
  let catalogWalletId = current[0]?.wallet_id ?? null;

  if (!catalogWalletId) {
    catalogWalletId = await resolveOrCreateWalletCatalogId(methodName, platformTypes);
    if (catalogWalletId) {
      await query(`UPDATE ${config.table} SET wallet_id = ? WHERE id = ?`, [
        catalogWalletId,
        methodId,
      ]);
    }
  }

  if (copyRates && !(await methodHasExchangeRates(kind, methodId))) {
    await copyExchangeRatesFromPreviousMethod(
      kind,
      methodId,
      catalogWalletId,
      methodName,
    );
  }

  return catalogWalletId;
}

async function backfillWalletCatalogLinks(kind, rows) {
  for (const row of rows) {
    const config = WALLET_CONFIG[kind];
    const platformTypes = parsePlatformTypes(row.platform_id_type || row[config.idTypeColumn] || '');
    const methodName = row[config.nameColumn] || '';
    await ensureMethodWalletCatalogLink(kind, row.id, methodName, platformTypes, {
      copyRates: true,
    });
  }
}

async function hasAllowForVoucherColumn() {
  return tableHasColumn('topup_methods', 'allow_for_voucher');
}

export async function ensureTopupWalletVoucherFlagSchema() {
  if (topupVoucherFlagSchemaReady) return;

  const exists = await hasAllowForVoucherColumn();
  if (!exists) {
    if (getDbDriver() === 'sqlite') {
      await query(
        `ALTER TABLE topup_methods ADD COLUMN allow_for_voucher INTEGER NOT NULL DEFAULT 0`,
      );
    } else {
      await query(
        `ALTER TABLE topup_methods
         ADD COLUMN allow_for_voucher TINYINT(1) NOT NULL DEFAULT 0
         AFTER availability`,
      );
    }

    // Preserve current voucher dropdown options for existing active wallets.
    await query(
      `UPDATE topup_methods
       SET allow_for_voucher = 1
       WHERE UPPER(availability) = 'AVAILABLE'
         AND (is_deleted = 0 OR is_deleted IS NULL)`,
    );
  }

  topupVoucherFlagSchemaReady = true;
}

async function ensureNavigateColumnsForTable(tableName) {
  const hasAllow = await tableHasColumn(tableName, 'allow_navigate_button');
  if (!hasAllow) {
    if (getDbDriver() === 'sqlite') {
      await query(
        `ALTER TABLE ${tableName} ADD COLUMN allow_navigate_button INTEGER NOT NULL DEFAULT 0`,
      );
    } else {
      await query(
        `ALTER TABLE ${tableName}
         ADD COLUMN allow_navigate_button TINYINT(1) NOT NULL DEFAULT 0`,
      );
    }
  }

  const hasUrl = await tableHasColumn(tableName, 'navigate_url');
  if (!hasUrl) {
    if (getDbDriver() === 'sqlite') {
      await query(`ALTER TABLE ${tableName} ADD COLUMN navigate_url TEXT NULL`);
    } else {
      await query(
        `ALTER TABLE ${tableName}
         ADD COLUMN navigate_url VARCHAR(500) NULL`,
      );
    }
  }

  const hasLabel = await tableHasColumn(tableName, 'navigate_button_label');
  if (!hasLabel) {
    if (getDbDriver() === 'sqlite') {
      await query(`ALTER TABLE ${tableName} ADD COLUMN navigate_button_label TEXT NULL`);
    } else {
      await query(
        `ALTER TABLE ${tableName}
         ADD COLUMN navigate_button_label VARCHAR(80) NULL`,
      );
    }
  }
}

export async function ensureWalletNavigateSchema() {
  if (walletNavigateSchemaReady) return;
  await ensureNavigateColumnsForTable('topup_methods');
  await ensureNavigateColumnsForTable('cashout_methods');
  walletNavigateSchemaReady = true;
}

function parseNavigateSettings(payload = {}, existing = null) {
  const allowNavigateButton = parseBooleanFlag(
    payload.allowNavigateButton ?? payload.allow_navigate_button,
    existing?.allowNavigateButton ?? false,
  );
  const rawUrl = String(payload.navigateUrl ?? payload.navigate_url ?? '').trim();
  const rawLabel = String(
    payload.navigateButtonLabel ?? payload.navigate_button_label ?? '',
  ).trim();

  if (!allowNavigateButton) {
    return {
      allowNavigateButton: false,
      navigateUrl: null,
      navigateButtonLabel: null,
    };
  }

  if (!rawUrl) {
    throw validationError('Navigate URL is required when the navigate button is enabled.');
  }

  if (!rawLabel) {
    throw validationError('Button name is required when the navigate button is enabled.');
  }

  if (rawLabel.length > 40) {
    throw validationError('Button name must be 40 characters or fewer.');
  }

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw validationError('Navigate URL must be a valid URL (include https://).');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw validationError('Navigate URL must start with http:// or https://.');
  }

  return {
    allowNavigateButton: true,
    navigateUrl: parsed.toString(),
    navigateButtonLabel: rawLabel,
  };
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

const PLATFORM_TYPE_OPTIONS = ['INT', 'Email', 'Mobile', 'Text', 'Vachar'];

function parsePlatformTypes(value) {
  if (Array.isArray(value)) {
    return [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))];
  }
  if (typeof value === 'string' && value.trim()) {
    const trimmed = value.trim();
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsePlatformTypes(parsed);
      }
    } catch {
      // comma / pipe separated fallback
    }
    return [
      ...new Set(
        trimmed
          .split(/[,|]/)
          .map((item) => item.trim())
          .filter(Boolean),
      ),
    ];
  }
  return [];
}

function validateWalletPayload({ name, currency, minLimit, maxLimit, platformType, platformTypes, terms }) {
  const walletName = String(name || '').trim();
  const walletCurrency = String(currency || '').trim();
  const selectedPlatformTypes = parsePlatformTypes(platformTypes ?? platformType);
  const walletTerms = String(terms ?? '').trim();
  const minimumLimit = Number(minLimit);
  const maximumLimit = Number(maxLimit);

  if (!walletName) throw validationError('Wallet name is required.');
  if (!walletCurrency) throw validationError('Currency is required.');
  if (!selectedPlatformTypes.length) throw validationError('At least one platform type is required.');
  if (!walletTerms) throw validationError('Terms & conditions are required.');
  if (!Number.isFinite(minimumLimit)) throw validationError('Minimum limit is required.');
  if (!Number.isFinite(maximumLimit)) throw validationError('Maximum limit is required.');

  const invalid = selectedPlatformTypes.filter(
    (type) => !PLATFORM_TYPE_OPTIONS.some((option) => option.toLowerCase() === type.toLowerCase()),
  );
  if (invalid.length) {
    throw validationError(`Invalid platform type(s): ${invalid.join(', ')}`);
  }

  const normalizedPlatformTypes = selectedPlatformTypes.map((type) => {
    const match = PLATFORM_TYPE_OPTIONS.find((option) => option.toLowerCase() === type.toLowerCase());
    return match || type;
  });

  return {
    name: walletName,
    currency: walletCurrency,
    platformTypes: normalizedPlatformTypes,
    platformType: normalizedPlatformTypes.join(','),
    terms: walletTerms,
    minimumLimit,
    maximumLimit,
  };
}

/** Unique wallet name within Top-up or Cash-out (visible / non-hidden rows only). */
async function assertUniqueWalletName(kind, walletName, excludeId = null) {
  const config = WALLET_CONFIG[kind];
  if (!config) throw validationError('Invalid wallet type.');

  const label = kind === 'cashout' ? 'Cash-out' : 'Top-up';
  const params = [String(walletName || '').trim()];
  let sql = `
    SELECT id
    FROM ${config.table}
    WHERE UPPER(${config.nameColumn}) = UPPER(?)
      AND (is_deleted = 0 OR is_deleted IS NULL)
  `;
  if (excludeId != null && excludeId !== '') {
    sql += ' AND id <> ?';
    params.push(Number(excludeId));
  }
  sql += ' LIMIT 1';

  const rows = await query(sql, params);
  if (rows.length) {
    throw validationError(
      `A ${label} wallet named "${String(walletName).trim()}" already exists. Use a different name.`,
    );
  }
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
  const platformTypes = parsePlatformTypes(row.platform_id_type || row[config.idTypeColumn] || '');

  const allowNavigateButton = Boolean(Number(row.allow_navigate_button));
  const navigateUrl = allowNavigateButton ? row.navigate_url || null : null;
  const navigateButtonLabel = allowNavigateButton
    ? String(row.navigate_button_label || '').trim() || null
    : null;

  return {
    id: row.id,
    name: row[config.nameColumn] || '',
    currency: row[config.currencyColumn] || '',
    platformType: platformTypes.join(','),
    platformTypes,
    minLimit: Number(row.minimum_limit ?? 0),
    maxLimit: Number(row.maximum_limit ?? 0),
    terms: row.tnc || '',
    active: row.availability === 'AVAILABLE',
    availability: row.availability,
    allowForVoucher: kind === 'topup' ? Boolean(Number(row.allow_for_voucher)) : false,
    allow_for_voucher: kind === 'topup' ? Boolean(Number(row.allow_for_voucher)) : false,
    allowNavigateButton,
    allow_navigate_button: allowNavigateButton,
    navigateUrl,
    navigate_url: navigateUrl,
    navigateButtonLabel,
    navigate_button_label: navigateButtonLabel,
    logo,
    logoName: logo,
    logoUrl: resolveWalletLogoPublicUrl(logo),
    paymentMethodIds: paymentOptions.map((option) => option.id),
    paymentMethods: paymentOptions.map((option) => option.payment_option_name),
    hidden: Number(row.is_deleted) === 1 || row.is_deleted === true,
    isDeleted: Number(row.is_deleted) === 1 || row.is_deleted === true,
  };
}

async function findWalletById(kind, walletId, { includeHidden = true } = {}) {
  await ensureWalletNavigateSchema();
  if (kind === 'topup') {
    await ensureTopupWalletVoucherFlagSchema();
  }
  const config = WALLET_CONFIG[kind];
  const params = [walletId];
  let sql = `SELECT * FROM ${config.table} WHERE id = ?`;
  if (!includeHidden) {
    sql += ' AND (is_deleted = 0 OR is_deleted IS NULL)';
  }
  sql += ' LIMIT 1';
  const rows = await query(sql, params);
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
    platformTypes: [...PLATFORM_TYPE_OPTIONS],
  };
}

export async function listTopupWallets() {
  await ensureWalletNavigateSchema();
  await ensureTopupWalletVoucherFlagSchema();
  const config = WALLET_CONFIG.topup;
  const rows = await query(
    `SELECT *
     FROM ${config.table}
     ORDER BY CASE WHEN is_deleted = 1 THEN 1 ELSE 0 END ASC, id DESC`,
  );
  await backfillWalletCatalogLinks('topup', rows.filter((row) => !(Number(row.is_deleted) === 1 || row.is_deleted === true)));
  return Promise.all(rows.map((row) => mapWalletRow(row, 'topup')));
}

export async function listCashoutWallets() {
  await ensureWalletNavigateSchema();
  const config = WALLET_CONFIG.cashout;
  const rows = await query(
    `SELECT *
     FROM ${config.table}
     ORDER BY CASE WHEN is_deleted = 1 THEN 1 ELSE 0 END ASC, id DESC`,
  );
  await backfillWalletCatalogLinks('cashout', rows.filter((row) => !(Number(row.is_deleted) === 1 || row.is_deleted === true)));
  return Promise.all(rows.map((row) => mapWalletRow(row, 'cashout')));
}

export async function createTopupWallet(payload, logoFile) {
  await ensureWalletNavigateSchema();
  await ensureTopupWalletVoucherFlagSchema();
  const validated = validateWalletPayload(payload);
  await assertUniqueWalletName('topup', validated.name);
  const paymentMethodIds = parsePaymentMethodIds(payload.paymentMethodIds);
  if (paymentMethodIds.length === 0) {
    throw validationError('At least one payment method is required.');
  }

  const allowForVoucher = parseBooleanFlag(
    payload.allowForVoucher ?? payload.allow_for_voucher,
    false,
  );
  const navigate = parseNavigateSettings(payload);
  const config = WALLET_CONFIG.topup;
  const logo = logoFile ? await storeWalletLogo(logoFile) : null;
  const catalogWalletId = await resolveOrCreateWalletCatalogId(
    validated.name,
    validated.platformTypes,
  );
  const hasWalletIdColumn = await tableHasColumn(config.table, 'wallet_id');

  const insertColumns = [
    config.nameColumn,
    config.currencyColumn,
    'minimum_limit',
    'maximum_limit',
    'platform_id_type',
    config.idTypeColumn,
    'tnc',
    'availability',
    'allow_for_voucher',
    'allow_navigate_button',
    'navigate_url',
    'navigate_button_label',
    config.logoColumn,
    'is_deleted',
    'created_at',
    'updated_at',
  ];
  const insertValues = [
    validated.name,
    validated.currency,
    validated.minimumLimit,
    validated.maximumLimit,
    validated.platformType,
    validated.platformType,
    validated.terms,
    'AVAILABLE',
    allowForVoucher ? 1 : 0,
    navigate.allowNavigateButton ? 1 : 0,
    navigate.navigateUrl,
    navigate.navigateButtonLabel,
    logo,
    0,
  ];

  if (hasWalletIdColumn && catalogWalletId) {
    insertColumns.push('wallet_id');
    insertValues.push(catalogWalletId);
  }

  const placeholders = [...insertValues.map(() => '?'), 'NOW()', 'NOW()'].join(', ');
  const result = await query(
    `INSERT INTO ${config.table} (${insertColumns.join(', ')})
     VALUES (${placeholders})`,
    insertValues,
  );

  const methodId = result.insertId;
  await createWalletPaymentOptions(methodId, config.walletType, paymentMethodIds);
  await ensureMethodWalletCatalogLink('topup', methodId, validated.name, validated.platformTypes, {
    copyRates: true,
  });
  return findWalletById('topup', methodId);
}

export async function createCashoutWallet(payload, logoFile) {
  await ensureWalletNavigateSchema();
  const validated = validateWalletPayload(payload);
  await assertUniqueWalletName('cashout', validated.name);
  const paymentMethodIds = parsePaymentMethodIds(payload.paymentMethodIds);
  if (paymentMethodIds.length === 0) {
    throw validationError('At least one payment method is required.');
  }

  const navigate = parseNavigateSettings(payload);
  const config = WALLET_CONFIG.cashout;
  const logo = logoFile ? await storeWalletLogo(logoFile) : null;
  const catalogWalletId = await resolveOrCreateWalletCatalogId(
    validated.name,
    validated.platformTypes,
  );
  const hasWalletIdColumn = await tableHasColumn(config.table, 'wallet_id');

  const insertColumns = [
    config.nameColumn,
    config.currencyColumn,
    'minimum_limit',
    'maximum_limit',
    'platform_id_type',
    config.idTypeColumn,
    'tnc',
    'availability',
    'allow_navigate_button',
    'navigate_url',
    'navigate_button_label',
    config.logoColumn,
    'is_deleted',
    'created_at',
    'updated_at',
  ];
  const insertValues = [
    validated.name,
    validated.currency,
    validated.minimumLimit,
    validated.maximumLimit,
    validated.platformType,
    validated.platformType,
    validated.terms,
    'AVAILABLE',
    navigate.allowNavigateButton ? 1 : 0,
    navigate.navigateUrl,
    navigate.navigateButtonLabel,
    logo,
    0,
  ];

  if (hasWalletIdColumn && catalogWalletId) {
    insertColumns.push('wallet_id');
    insertValues.push(catalogWalletId);
  }

  const placeholders = [...insertValues.map(() => '?'), 'NOW()', 'NOW()'].join(', ');
  const result = await query(
    `INSERT INTO ${config.table} (${insertColumns.join(', ')})
     VALUES (${placeholders})`,
    insertValues,
  );

  const methodId = result.insertId;
  await createWalletPaymentOptions(methodId, config.walletType, paymentMethodIds);
  await ensureMethodWalletCatalogLink('cashout', methodId, validated.name, validated.platformTypes, {
    copyRates: true,
  });
  return findWalletById('cashout', methodId);
}

export async function updateTopupWallet(walletId, payload, logoFile) {
  const existing = await findWalletById('topup', walletId);
  if (!existing) throw validationError('Top-up wallet not found.', 404);
  if (existing.hidden) throw validationError('Unhide this wallet before editing.');

  const validated = validateWalletPayload(payload);
  await assertUniqueWalletName('topup', validated.name, walletId);
  const paymentMethodIds = parsePaymentMethodIds(payload.paymentMethodIds);
  if (paymentMethodIds.length === 0) {
    throw validationError('At least one payment method is required.');
  }

  const allowForVoucher = parseBooleanFlag(
    payload.allowForVoucher ?? payload.allow_for_voucher,
    existing.allowForVoucher,
  );
  const navigate = parseNavigateSettings(payload, existing);
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
         allow_for_voucher = ?,
         allow_navigate_button = ?,
         navigate_url = ?,
         navigate_button_label = ?,
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
      allowForVoucher ? 1 : 0,
      navigate.allowNavigateButton ? 1 : 0,
      navigate.navigateUrl,
      navigate.navigateButtonLabel,
      logo,
      walletId,
    ],
  );

  await syncWalletPaymentOptions(walletId, config.walletType, paymentMethodIds);
  await ensureMethodWalletCatalogLink('topup', walletId, validated.name, validated.platformTypes, {
    copyRates: true,
  });
  return findWalletById('topup', walletId);
}

export async function updateCashoutWallet(walletId, payload, logoFile) {
  const existing = await findWalletById('cashout', walletId);
  if (!existing) throw validationError('Cash-out wallet not found.', 404);
  if (existing.hidden) throw validationError('Unhide this wallet before editing.');

  const validated = validateWalletPayload(payload);
  await assertUniqueWalletName('cashout', validated.name, walletId);
  const paymentMethodIds = parsePaymentMethodIds(payload.paymentMethodIds);
  if (paymentMethodIds.length === 0) {
    throw validationError('At least one payment method is required.');
  }

  const navigate = parseNavigateSettings(payload, existing);
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
         allow_navigate_button = ?,
         navigate_url = ?,
         navigate_button_label = ?,
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
      navigate.allowNavigateButton ? 1 : 0,
      navigate.navigateUrl,
      navigate.navigateButtonLabel,
      logo,
      walletId,
    ],
  );

  await syncWalletPaymentOptions(walletId, config.walletType, paymentMethodIds);
  await ensureMethodWalletCatalogLink('cashout', walletId, validated.name, validated.platformTypes, {
    copyRates: true,
  });
  return findWalletById('cashout', walletId);
}

export async function deleteTopupWallet(walletId) {
  const existing = await findWalletById('topup', walletId);
  if (!existing) throw validationError('Top-up wallet not found.', 404);
  if (existing.hidden) throw validationError('Top-up wallet is already hidden.');

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
  if (existing.hidden) throw validationError('Cash-out wallet is already hidden.');

  await query(
    `UPDATE ${WALLET_CONFIG.cashout.table}
     SET is_deleted = 1, updated_at = NOW()
     WHERE id = ?`,
    [walletId],
  );

  return { ok: true, id: walletId };
}

export async function unhideTopupWallet(walletId) {
  const existing = await findWalletById('topup', walletId);
  if (!existing) throw validationError('Top-up wallet not found.', 404);
  if (!existing.hidden) throw validationError('Top-up wallet is not hidden.');

  await assertUniqueWalletName('topup', existing.name, walletId);

  await query(
    `UPDATE ${WALLET_CONFIG.topup.table}
     SET is_deleted = 0, updated_at = NOW()
     WHERE id = ?`,
    [walletId],
  );

  return findWalletById('topup', walletId);
}

export async function unhideCashoutWallet(walletId) {
  const existing = await findWalletById('cashout', walletId);
  if (!existing) throw validationError('Cash-out wallet not found.', 404);
  if (!existing.hidden) throw validationError('Cash-out wallet is not hidden.');

  await assertUniqueWalletName('cashout', existing.name, walletId);

  await query(
    `UPDATE ${WALLET_CONFIG.cashout.table}
     SET is_deleted = 0, updated_at = NOW()
     WHERE id = ?`,
    [walletId],
  );

  return findWalletById('cashout', walletId);
}

export async function toggleTopupWalletStatus(walletId, active) {
  const existing = await findWalletById('topup', walletId);
  if (!existing) throw validationError('Top-up wallet not found.', 404);
  if (existing.hidden) throw validationError('Unhide this wallet before changing availability.');

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
  if (existing.hidden) throw validationError('Unhide this wallet before changing availability.');

  const availability = active ? 'AVAILABLE' : 'NOT_AVAILABLE';
  await query(
    `UPDATE ${WALLET_CONFIG.cashout.table}
     SET availability = ?, updated_at = NOW()
     WHERE id = ?`,
    [availability, walletId],
  );

  return findWalletById('cashout', walletId);
}
