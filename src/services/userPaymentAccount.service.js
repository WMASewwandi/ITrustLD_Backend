import { query } from '../config/database.js';
import { createTableIfMissing } from '../db/helpers.js';
import {
  findAccountHolderByUserId,
  isAccountBanned,
  needsVerification,
} from './accountHolder.service.js';
import {
  BUILTIN_PAY_ACCOUNT_TYPES,
  getBuiltinPayAccountMetaMap,
} from './builtinPayAccountMeta.service.js';
import { listCustomPayAccountCategories } from './customPayAccount.service.js';

const MAX_ACCOUNTS_PER_TYPE = 5;

const BUILTIN_TO_USER_ACCOUNT_TYPE = {
  bank: 'BANK TRANSFER',
  skrill: 'SKRILL',
  neteller: 'NETELLER',
  binance: 'CRYPTO',
  pm: 'PERFECT MONEY',
  xm: 'XM',
};

const USER_ACCOUNT_TYPE_TO_BUILTIN = Object.fromEntries(
  Object.entries(BUILTIN_TO_USER_ACCOUNT_TYPE).map(([type, name]) => [name, type]),
);

let customUserSchemaReady = false;

function validationError(message, status = 422) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function jsonError(message) {
  return { error: true, message };
}

function jsonSuccess(message, extra = {}) {
  return { error: false, message, ...extra };
}

async function assertAccountsAccess(userId) {
  const accountHolder = await findAccountHolderByUserId(userId);
  if (!accountHolder) {
    throw validationError('Account holder not found.', 404);
  }
  if (isAccountBanned(accountHolder)) {
    throw validationError('Your account has been banned. Please contact support.', 403);
  }
  if (accountHolder.identity_verification !== 'VERIFIED') {
    const error = validationError('Complete identity verification before managing payment accounts.');
    error.code = 'VERIFICATION_REQUIRED';
    throw error;
  }
  return accountHolder;
}

function notDeletedClause(alias = '') {
  const prefix = alias ? `${alias}.` : '';
  return `(${prefix}is_deleted = 0 OR ${prefix}is_deleted IS NULL OR ${prefix}is_deleted = FALSE)`;
}

function normalizeCategoryName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function parseJsonObject(raw) {
  if (!raw) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function mapPublicField(field) {
  return {
    key: field.key,
    label: field.label,
    type: field.type || 'text',
    required: field.required !== false,
    inputMode: field.inputMode || undefined,
    placeholder: field.placeholder || undefined,
  };
}

function builtinUserFields(userType) {
  switch (userType) {
    case 'XM':
      return [
        {
          key: 'xm_account_id',
          label: 'XM Account ID',
          type: 'text',
          required: true,
          inputMode: 'numeric',
          placeholder: '12345678',
        },
      ];
    case 'SKRILL':
      return [
        {
          key: 'skrill_email',
          label: 'Skrill Email',
          type: 'email',
          required: true,
          placeholder: 'you@example.com',
        },
      ];
    case 'NETELLER':
      return [
        {
          key: 'neteller_email',
          label: 'Neteller Email',
          type: 'email',
          required: true,
          placeholder: 'you@example.com',
        },
      ];
    case 'PERFECT MONEY':
      return [
        {
          key: 'pm_account_id',
          label: 'PM Account ID',
          type: 'text',
          required: true,
          placeholder: 'U12345678',
        },
      ];
    case 'CRYPTO':
      return [
        {
          key: 'crypto_account_id',
          label: 'Crypto Wallet / Account ID',
          type: 'text',
          required: true,
          placeholder: 'Wallet address or account id',
        },
      ];
    case 'BANK TRANSFER':
      return [
        { key: 'bank', label: 'Bank name', type: 'text', required: true, placeholder: 'e.g. Commercial Bank' },
        { key: 'branch', label: 'Branch', type: 'text', required: true, placeholder: 'e.g. Colombo 03' },
        {
          key: 'beneficiary_name',
          label: 'Account holder name',
          type: 'text',
          required: true,
          placeholder: 'Name as on bank account',
        },
        {
          key: 'account_number',
          label: 'Account number',
          type: 'text',
          required: true,
          inputMode: 'numeric',
          placeholder: 'Digits only',
        },
      ];
    default:
      return [];
  }
}

function fallbackCustomFields(categoryName) {
  return [
    {
      key: 'account_id',
      label: `${categoryName || 'Account'} ID`,
      type: 'text',
      required: true,
      placeholder: 'Enter your account details',
    },
  ];
}

function customFieldDefs(category) {
  const fields = (category?.fields || []).map(mapPublicField);
  return fields.length ? fields : fallbackCustomFields(category?.name);
}

function summarizeValues(fields, values) {
  return (fields || [])
    .map((field) => values?.[field.key])
    .filter((value) => value != null && String(value).trim() !== '')
    .map((value) => String(value).trim())
    .slice(0, 3)
    .join(' · ');
}

async function ensureUserCustomPayAccountSchema() {
  if (customUserSchemaReady) return;
  await createTableIfMissing('user_custom_pay_accounts', {
    mysql: `
      CREATE TABLE user_custom_pay_accounts (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        user_id BIGINT UNSIGNED NOT NULL,
        category_id BIGINT UNSIGNED NOT NULL,
        field_values TEXT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'AVAILABLE',
        is_deleted TINYINT(1) NOT NULL DEFAULT 0,
        created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        KEY user_custom_pay_accounts_user_index (user_id, is_deleted, category_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `,
    sqlite: `
      CREATE TABLE user_custom_pay_accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        category_id INTEGER NOT NULL,
        field_values TEXT,
        status TEXT NOT NULL DEFAULT 'AVAILABLE',
        is_deleted INTEGER NOT NULL DEFAULT 0,
        created_at TEXT,
        updated_at TEXT
      )
    `,
  });
  customUserSchemaReady = true;
}

async function findCustomCategoryByAccountType(accountType) {
  const needle = normalizeCategoryName(accountType);
  if (!needle) return null;
  const categories = await listCustomPayAccountCategories();
  return (
    categories.find(
      (category) =>
        normalizeCategoryName(category.name) === needle ||
        normalizeCategoryName(category.slug) === needle,
    ) || null
  );
}

async function rejectIfPayAccountCategoryHidden(accountType) {
  const userType = normalizeAccountType(accountType);
  if (!userType || userType === 'CARD PAYMENT') return null;
  const builtinType = USER_ACCOUNT_TYPE_TO_BUILTIN[userType];
  if (builtinType) {
    const meta = await getBuiltinPayAccountMetaMap();
    if (meta[builtinType]?.isActive === false) {
      return jsonError('This account type is not available.');
    }
    return null;
  }
  const category = await findCustomCategoryByAccountType(accountType);
  if (category && category.isActive === false) {
    return jsonError('This account type is not available.');
  }
  return null;
}

async function listPayAccountTypeOptions() {
  const [meta, customCategories] = await Promise.all([
    getBuiltinPayAccountMetaMap(),
    listCustomPayAccountCategories(),
  ]);

  const options = [];
  for (const builtinType of BUILTIN_PAY_ACCOUNT_TYPES) {
    const userType = BUILTIN_TO_USER_ACCOUNT_TYPE[builtinType];
    if (!userType) continue;
    if (meta[builtinType]?.isActive === false) continue;
    const displayName = meta[builtinType]?.displayName || userType;
    options.push({
      id: `builtin:${builtinType}`,
      name: userType,
      display_name: displayName,
      kind: 'builtin',
      fields: builtinUserFields(userType).map(mapPublicField),
      hint:
        userType === 'BANK TRANSFER'
          ? 'Enter your verified bank account details for local transfers.'
          : `Enter your ${displayName} details, then click Save account.`,
    });
  }

  for (const category of customCategories) {
    if (category.isActive === false) continue;
    const fields = customFieldDefs(category);
    options.push({
      id: `custom:${category.id}`,
      name: category.name,
      display_name: category.name,
      kind: 'custom',
      category_id: category.id,
      fields,
      hint: 'Fill in the account details below, then click Save account.',
    });
  }

  return options;
}

function attachAccountFieldState(account) {
  if (!account) return account;
  if (account.kind === 'custom' && Array.isArray(account.fields)) return account;
  const fields = builtinUserFields(account.accountType);
  if (!fields.length) return { ...account, kind: account.kind || 'builtin' };
  const values = {
    xm_account_id: account.xmAccountId || '',
    skrill_email: account.skrillEmail || '',
    neteller_email: account.netellerEmail || '',
    pm_account_id: account.pmAccountId || '',
    crypto_account_id: account.cryptoAccountId || '',
    bank: account.bank || '',
    branch: account.branch || '',
    beneficiary_name: account.beneficiaryName || '',
    account_number: account.accountNumber || '',
    ...account.values,
  };
  return { ...account, kind: account.kind || 'builtin', fields, values };
}

function displayNameForUserType(paymentOption, typeOptions) {
  const optionName = String(paymentOption || '').trim();
  const match = (typeOptions || []).find(
    (option) =>
      String(option.name).toUpperCase() === optionName.toUpperCase() ||
      normalizeCategoryName(option.display_name) === normalizeCategoryName(optionName),
  );
  return match?.display_name || optionName;
}

async function loadCustomUserAccounts(userId, paymentOption) {
  await ensureUserCustomPayAccountSchema();
  const category = await findCustomCategoryByAccountType(paymentOption);
  if (!category) return [];
  const fields = customFieldDefs(category);
  const rows = await query(
    `SELECT id, category_id, field_values, status
     FROM user_custom_pay_accounts
     WHERE user_id = ?
       AND category_id = ?
       AND ${notDeletedClause()}
     ORDER BY id ASC`,
    [userId, category.id],
  );
  return rows.map((row) => {
    const values = parseJsonObject(row.field_values);
    return {
      id: row.id,
      accountType: category.name,
      kind: 'custom',
      categoryId: category.id,
      values,
      fields,
      status: row.status,
      display: summarizeValues(fields, values) || category.name,
    };
  });
}

export async function loadUserCustomReceivingAccount(accountId) {
  await ensureUserCustomPayAccountSchema();
  const id = Number(accountId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const rows = await query(
    `SELECT id, user_id, category_id, field_values, status
     FROM user_custom_pay_accounts
     WHERE id = ? AND ${notDeletedClause()}
     LIMIT 1`,
    [id],
  );
  const row = rows[0];
  if (!row) return null;
  const categories = await listCustomPayAccountCategories();
  const category = categories.find((item) => Number(item.id) === Number(row.category_id));
  const fields = customFieldDefs(category || { name: 'Account', fields: [] });
  const values = parseJsonObject(row.field_values);
  const display = summarizeValues(fields, values);
  const primary = (fields || [])
    .map((field) => values?.[field.key])
    .find((value) => value != null && String(value).trim() !== '');
  return {
    id: row.id,
    userId: row.user_id,
    categoryId: row.category_id,
    categoryName: category?.name || 'Account',
    values,
    fields,
    display,
    primaryValue: primary != null ? String(primary).trim() : display,
  };
}

function collectFieldValues(fields, payload) {
  const source = payload?.field_values ?? payload?.fieldValues ?? payload;
  const values = {};
  for (const field of fields || []) {
    const raw = source?.[field.key] ?? payload?.[field.key];
    const value = raw == null ? '' : String(raw).trim();
    if (field.required && !value) {
      return { error: `${field.label} is required.` };
    }
    if (field.type === 'email' && value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      return { error: `Enter a valid ${field.label}.` };
    }
    if (value) values[field.key] = value;
  }
  return { values };
}

function insertedId(result) {
  const id = Number(result?.insertId ?? result?.lastInsertRowid ?? 0);
  return Number.isInteger(id) && id > 0 ? id : 0;
}

async function loadAllCustomUserAccountGroups(userId, optionLimitsByName, rateByName) {
  const categories = await listCustomPayAccountCategories();
  const groups = [];
  for (const category of categories) {
    if (category.isActive === false) continue;
    const accounts = (await loadCustomUserAccounts(userId, category.name)).map((account) =>
      attachAccountFieldState(account),
    );
    if (!accounts.length) continue;
    const optionKey = String(category.name || '').trim().toUpperCase();
    const meta = optionLimitsByName.get(optionKey);
    groups.push({
      payment_option: category.name,
      display_name: category.name,
      account_count: accounts.length,
      accounts,
      min_limit: meta?.minimum_limit != null ? Number(meta.minimum_limit) : null,
      max_limit: meta?.maximum_limit != null ? Number(meta.maximum_limit) : null,
      currency: meta?.payment_option_currency || 'USD',
      conversion_rate: rateByName.get(optionKey) ?? 1,
    });
  }
  return groups;
}

export async function listUserCustomReceivingAccounts(userId, paymentOptionName) {
  const accounts = await loadCustomUserAccounts(userId, paymentOptionName);
  return accounts.map((account) => ({
    id: account.id,
    accountType: account.accountType,
    label: `${account.accountType} — ${account.display}`,
    accountId: account.display,
  }));
}

async function countActiveAccounts(table, userId) {
  const rows = await query(
    `SELECT COUNT(*) AS total FROM ${table} WHERE user_id = ? AND ${notDeletedClause()}`,
    [userId],
  );
  return Number(rows[0]?.total) || 0;
}

async function loadAccountsForType(userId, paymentOption) {
  switch (paymentOption) {
    case 'XM': {
      const rows = await query(
        `SELECT id, xm_account_id, status
         FROM user_xm_accounts
         WHERE user_id = ? AND ${notDeletedClause()}
         ORDER BY id ASC`,
        [userId],
      );
      return rows.map((row) => ({
        id: row.id,
        accountType: 'XM',
        xmAccountId: row.xm_account_id,
        status: row.status,
        display: row.xm_account_id,
      }));
    }
    case 'SKRILL': {
      const rows = await query(
        `SELECT id, skrill_email, status
         FROM user_skrill_accounts
         WHERE user_id = ? AND ${notDeletedClause()}
         ORDER BY id ASC`,
        [userId],
      );
      return rows.map((row) => ({
        id: row.id,
        accountType: 'SKRILL',
        skrillEmail: row.skrill_email,
        status: row.status,
        display: row.skrill_email,
      }));
    }
    case 'NETELLER': {
      const rows = await query(
        `SELECT id, neteller_email, status
         FROM user_neteller_accounts
         WHERE user_id = ? AND ${notDeletedClause()}
         ORDER BY id ASC`,
        [userId],
      );
      return rows.map((row) => ({
        id: row.id,
        accountType: 'NETELLER',
        netellerEmail: row.neteller_email,
        status: row.status,
        display: row.neteller_email,
      }));
    }
    case 'PERFECT MONEY': {
      const rows = await query(
        `SELECT id, pm_account_id, status
         FROM user_perfect_money_accounts
         WHERE user_id = ? AND ${notDeletedClause()}
         ORDER BY id ASC`,
        [userId],
      );
      return rows.map((row) => ({
        id: row.id,
        accountType: 'PERFECT MONEY',
        pmAccountId: row.pm_account_id,
        status: row.status,
        display: row.pm_account_id,
      }));
    }
    case 'BANK TRANSFER': {
      const rows = await query(
        `SELECT id, account_number, beneficiary_name, bank, branch, status
         FROM user_bank_accounts
         WHERE user_id = ? AND ${notDeletedClause()}
         ORDER BY id ASC`,
        [userId],
      );
      return rows.map((row) => ({
        id: row.id,
        accountType: 'BANK TRANSFER',
        accountNumber: row.account_number,
        beneficiaryName: row.beneficiary_name,
        bank: row.bank,
        branch: row.branch,
        status: row.status,
        display: `${row.bank} — ${row.account_number}`,
      }));
    }
    case 'CARD PAYMENT': {
      const rows = await query(
        `SELECT id, bank_account_number, beneficiary_name, bank, branch, status
         FROM user_card_payment_accounts
         WHERE user_id = ? AND ${notDeletedClause()}
         ORDER BY id ASC`,
        [userId],
      );
      return rows.map((row) => ({
        id: row.id,
        accountType: 'CARD PAYMENT',
        accountNumber: row.bank_account_number,
        beneficiaryName: row.beneficiary_name,
        bank: row.bank,
        branch: row.branch,
        status: row.status,
        display: `${row.bank} — ${row.bank_account_number}`,
      }));
    }
    case 'CRYPTO': {
      const rows = await query(
        `SELECT id, crypto_account_id, status
         FROM user_crypto_accounts
         WHERE user_id = ? AND ${notDeletedClause()}
         ORDER BY id ASC`,
        [userId],
      );
      return rows.map((row) => ({
        id: row.id,
        accountType: 'CRYPTO',
        kind: 'builtin',
        cryptoAccountId: row.crypto_account_id,
        status: row.status,
        display: row.crypto_account_id,
      }));
    }
    default:
      return loadCustomUserAccounts(userId, paymentOption);
  }
}

export async function listUserPaymentAccounts(userId) {
  await assertAccountsAccess(userId);
  await ensureUserCustomPayAccountSchema();

  const typeOptions = await listPayAccountTypeOptions();

  const groupRows = await query(
    `SELECT upo.payment_option, COUNT(*) AS account_count
     FROM user_payment_options upo
     WHERE upo.user_id = ?
       AND (upo.is_deleted = 0 OR upo.is_deleted IS NULL OR upo.is_deleted = FALSE)
     GROUP BY upo.payment_option
     ORDER BY upo.payment_option ASC`,
    [userId],
  );

  const optionLimitRows = await query(
    `SELECT payment_option_name, payment_option_currency, minimum_limit, maximum_limit, availability
     FROM payment_options
     WHERE (is_deleted = 0 OR is_deleted IS NULL)
     ORDER BY CASE WHEN UPPER(availability) = 'AVAILABLE' THEN 0 ELSE 1 END, id ASC`,
  );
  const optionLimitsByName = new Map();
  for (const row of optionLimitRows) {
    const key = String(row.payment_option_name || '').trim().toUpperCase();
    if (!optionLimitsByName.has(key)) optionLimitsByName.set(key, row);
  }

  const rateRows = await query(
    `SELECT po.payment_option_name, pwr.rate
     FROM point_withdrawal_rates pwr
     INNER JOIN payment_options po ON po.id = pwr.payment_option_id
     WHERE (po.is_deleted = 0 OR po.is_deleted IS NULL)
     ORDER BY pwr.applicable_date DESC, pwr.id DESC`,
  );
  const rateByName = new Map();
  for (const row of rateRows) {
    const key = String(row.payment_option_name || '').trim().toUpperCase();
    if (!rateByName.has(key)) rateByName.set(key, Number(row.rate) || 1);
  }

  const accountGroups = [];
  const visibleTypeKeys = new Set(
    typeOptions.map((option) => String(option.name || '').trim().toUpperCase()),
  );
  visibleTypeKeys.add('CARD PAYMENT');
  for (const row of groupRows) {
      const optionKey = String(row.payment_option || '').trim().toUpperCase();
      if (!visibleTypeKeys.has(optionKey)) continue;
      const accounts = (await loadAccountsForType(userId, row.payment_option)).map((account) =>
        attachAccountFieldState(account),
      );
    if (accounts.length > 0) {
      const optionKey = String(row.payment_option || '').trim().toUpperCase();
      const meta = optionLimitsByName.get(optionKey);
      accountGroups.push({
        payment_option: row.payment_option,
        display_name: displayNameForUserType(row.payment_option, typeOptions),
        account_count: accounts.length,
        accounts,
        min_limit: meta?.minimum_limit != null ? Number(meta.minimum_limit) : null,
        max_limit: meta?.maximum_limit != null ? Number(meta.maximum_limit) : null,
        currency: meta?.payment_option_currency || 'USD',
        conversion_rate: rateByName.get(optionKey) ?? 1,
      });
    }
  }

  const customGroups = await loadAllCustomUserAccountGroups(userId, optionLimitsByName, rateByName);
  accountGroups.push(...customGroups);

  return {
    account_groups: accountGroups,
    system_payment_options: typeOptions,
  };
}

function normalizeAccountType(value) {
  return String(value || '').trim().toUpperCase();
}

async function linkPaymentOption(userId, accountReference, paymentOption) {
  const result = await query(
    `INSERT INTO user_payment_options (user_id, account_reference, payment_option, is_deleted, created_at, updated_at)
     VALUES (?, ?, ?, 0, NOW(), NOW())`,
    [userId, accountReference, paymentOption],
  );
  return {
    id: result.insertId,
    user_id: userId,
    account_reference: accountReference,
    payment_option: paymentOption,
  };
}

export async function createUserPaymentAccount(userId, payload) {
  await assertAccountsAccess(userId);

  const accountType = normalizeAccountType(payload.account_type ?? payload.accountType);
  if (!accountType) {
    return jsonError('Account type is required.');
  }

  const hiddenError = await rejectIfPayAccountCategoryHidden(accountType);
  if (hiddenError) return hiddenError;

  switch (accountType) {
    case 'XM': {
      const xmAccountId = String(payload.xm_account_id ?? payload.xmAccountId ?? '').trim();
      if (!/^\d+$/.test(xmAccountId)) {
        return jsonError('Incorrect XM account id. Please try again.');
      }
      if ((await countActiveAccounts('user_xm_accounts', userId)) >= MAX_ACCOUNTS_PER_TYPE) {
        return jsonError(
          'You already have 5 active XM accounts. You can add a new account by deleting an existing XM account.',
        );
      }
      const dup = await query(
        `SELECT id FROM user_xm_accounts WHERE user_id = ? AND xm_account_id = ? AND ${notDeletedClause()} LIMIT 1`,
        [userId, xmAccountId],
      );
      if (dup[0]) {
        return jsonError('You already have an active XM account with the same account id.');
      }
      const created = await query(
        `INSERT INTO user_xm_accounts (user_id, xm_account_id, status, is_deleted, created_at, updated_at)
         VALUES (?, ?, 'AVAILABLE', 0, NOW(), NOW())`,
        [userId, xmAccountId],
      );
      const paymentOption = await linkPaymentOption(userId, created.insertId, 'XM');
      return jsonSuccess('Your XM account is added successfully.', {
        payment_option: {
          ...paymentOption,
          account: { id: created.insertId, xm_account_id: xmAccountId },
        },
      });
    }
    case 'SKRILL': {
      const email = String(payload.skrill_email ?? payload.skrillEmail ?? '').trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return jsonError('Incorrect Skrill account. Please try again.');
      }
      if ((await countActiveAccounts('user_skrill_accounts', userId)) >= MAX_ACCOUNTS_PER_TYPE) {
        return jsonError(
          'You already have 5 active Skrill accounts. You can add a new account by deleting an existing Skrill account.',
        );
      }
      const dup = await query(
        `SELECT id FROM user_skrill_accounts WHERE user_id = ? AND skrill_email = ? AND ${notDeletedClause()} LIMIT 1`,
        [userId, email],
      );
      if (dup[0]) {
        return jsonError('You already have have an active Skrill account with the same email.');
      }
      const created = await query(
        `INSERT INTO user_skrill_accounts (user_id, skrill_email, status, is_deleted, created_at, updated_at)
         VALUES (?, ?, 'AVAILABLE', 0, NOW(), NOW())`,
        [userId, email],
      );
      const paymentOption = await linkPaymentOption(userId, created.insertId, 'SKRILL');
      return jsonSuccess('Your Skrill account is added successfully.', {
        payment_option: {
          ...paymentOption,
          account: { id: created.insertId, skrill_email: email },
        },
      });
    }
    case 'NETELLER': {
      const email = String(payload.neteller_email ?? payload.netellerEmail ?? '').trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return jsonError('Incorrect Neteller account. Please try again.');
      }
      if ((await countActiveAccounts('user_neteller_accounts', userId)) >= MAX_ACCOUNTS_PER_TYPE) {
        return jsonError(
          'You already have 5 active Neteller accounts. You can add a new account by deleting an existing Neteller account.',
        );
      }
      const dup = await query(
        `SELECT id FROM user_neteller_accounts WHERE user_id = ? AND neteller_email = ? AND ${notDeletedClause()} LIMIT 1`,
        [userId, email],
      );
      if (dup[0]) {
        return jsonError('You already have have an active Neteller account with the same email');
      }
      const created = await query(
        `INSERT INTO user_neteller_accounts (user_id, neteller_email, status, is_deleted, created_at, updated_at)
         VALUES (?, ?, 'AVAILABLE', 0, NOW(), NOW())`,
        [userId, email],
      );
      const paymentOption = await linkPaymentOption(userId, created.insertId, 'NETELLER');
      return jsonSuccess('Your Neteller account is added successfully.', {
        payment_option: {
          ...paymentOption,
          account: { id: created.insertId, neteller_email: email },
        },
      });
    }
    case 'PERFECT MONEY': {
      const pmAccountId = String(payload.pm_account_id ?? payload.pmAccountId ?? '').trim();
      if (!/^[a-zA-Z]+[0-9]+$/.test(pmAccountId)) {
        return jsonError('Incorrect Perfect Money account format. Please try again.');
      }
      if ((await countActiveAccounts('user_perfect_money_accounts', userId)) >= MAX_ACCOUNTS_PER_TYPE) {
        return jsonError(
          'You already have 5 active Perfect-Money accounts. You can add a new account by deleting an existing Perfect-Money account.',
        );
      }
      const dup = await query(
        `SELECT id FROM user_perfect_money_accounts WHERE user_id = ? AND pm_account_id = ? AND ${notDeletedClause()} LIMIT 1`,
        [userId, pmAccountId],
      );
      if (dup[0]) {
        return jsonError('You already have have an active Perfect-Money account with the same account id.');
      }
      const created = await query(
        `INSERT INTO user_perfect_money_accounts (user_id, pm_account_id, status, is_deleted, created_at, updated_at)
         VALUES (?, ?, 'AVAILABLE', 0, NOW(), NOW())`,
        [userId, pmAccountId],
      );
      const paymentOption = await linkPaymentOption(userId, created.insertId, 'PERFECT MONEY');
      return jsonSuccess('Your Perfect Money account is added successfully.', {
        payment_option: {
          ...paymentOption,
          account: { id: created.insertId, pm_account_id: pmAccountId },
        },
      });
    }
    case 'BANK TRANSFER': {
      const accountNumber = String(payload.account_number ?? payload.accountNumber ?? '').trim();
      const beneficiaryName = String(payload.beneficiary_name ?? payload.beneficiaryName ?? '').trim();
      const bank = String(payload.bank ?? '').trim();
      const branch = String(payload.branch ?? '').trim();
      if (!/^\d+$/.test(accountNumber)) {
        return jsonError('Incorrect bank account number. Please try again.');
      }
      if (!beneficiaryName || !bank || !branch) {
        return jsonError('Bank name, account name, and branch are required.');
      }
      if ((await countActiveAccounts('user_bank_accounts', userId)) >= MAX_ACCOUNTS_PER_TYPE) {
        return jsonError(
          'You already have 5 active Bank accounts. You can add a new account by deleting an existing Bank account.',
        );
      }
      const dup = await query(
        `SELECT id FROM user_bank_accounts WHERE user_id = ? AND account_number = ? AND ${notDeletedClause()} LIMIT 1`,
        [userId, accountNumber],
      );
      if (dup[0]) {
        return jsonError('You already have have an active Bank Account with the same account number.');
      }
      const created = await query(
        `INSERT INTO user_bank_accounts
         (user_id, account_number, beneficiary_name, bank, branch, status, is_deleted, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'VERIFIED', 0, NOW(), NOW())`,
        [userId, accountNumber, beneficiaryName, bank, branch],
      );
      const paymentOption = await linkPaymentOption(userId, created.insertId, 'BANK TRANSFER');
      return jsonSuccess('Your Bank Account account is added successfully.', {
        payment_option: {
          ...paymentOption,
          account: {
            id: created.insertId,
            account_number: accountNumber,
            beneficiary_name: beneficiaryName,
            bank,
            branch,
          },
        },
      });
    }
    case 'CRYPTO': {
      const cryptoAccountId = String(payload.crypto_account_id ?? payload.cryptoAccountId ?? '').trim();
      if (!cryptoAccountId) {
        return jsonError('Crypto account number is required. Please try again.');
      }
      if ((await countActiveAccounts('user_crypto_accounts', userId)) >= MAX_ACCOUNTS_PER_TYPE) {
        return jsonError(
          'You already have 5 active Crypto Accounts. You can add a new account by deleting an existing Crypto account.',
        );
      }
      const dup = await query(
        `SELECT id FROM user_crypto_accounts WHERE user_id = ? AND crypto_account_id = ? AND ${notDeletedClause()} LIMIT 1`,
        [userId, cryptoAccountId],
      );
      if (dup[0]) {
        return jsonError('You already have have an active Crypto with the same account id.');
      }
      const created = await query(
        `INSERT INTO user_crypto_accounts (user_id, crypto_account_id, status, is_deleted, created_at, updated_at)
         VALUES (?, ?, 'AVAILABLE', 0, NOW(), NOW())`,
        [userId, cryptoAccountId],
      );
      const paymentOption = await linkPaymentOption(userId, created.insertId, 'CRYPTO');
      return jsonSuccess('Your Crypto account is added successfully.', {
        payment_option: {
          ...paymentOption,
          account: { id: created.insertId, crypto_account_id: cryptoAccountId },
        },
      });
    }
    default: {
      const category =
        (await findCustomCategoryByAccountType(accountType)) ||
        (payload.category_id || payload.categoryId
          ? (await listCustomPayAccountCategories()).find(
              (item) => Number(item.id) === Number(payload.category_id ?? payload.categoryId),
            )
          : null);
      if (!category) {
        return jsonError(
          'Account type is not supported at the moment. Please choose a different account type.',
        );
      }

      await ensureUserCustomPayAccountSchema();
      const fields = customFieldDefs(category);
      const collected = collectFieldValues(fields, payload);
      if (collected.error) return jsonError(collected.error);

      const existingCount = await query(
        `SELECT COUNT(*) AS total
         FROM user_custom_pay_accounts
         WHERE user_id = ? AND category_id = ? AND ${notDeletedClause()}`,
        [userId, category.id],
      );
      if (Number(existingCount[0]?.total || 0) >= MAX_ACCOUNTS_PER_TYPE) {
        return jsonError(
          `You already have 5 active ${category.name} accounts. You can add a new account by deleting an existing one.`,
        );
      }

      const created = await query(
        `INSERT INTO user_custom_pay_accounts
         (user_id, category_id, field_values, status, is_deleted, created_at, updated_at)
         VALUES (?, ?, ?, 'AVAILABLE', 0, NOW(), NOW())`,
        [userId, category.id, JSON.stringify(collected.values)],
      );
      const newId = insertedId(created);
      if (!newId) {
        return jsonError('Could not save this account. Please try again.');
      }
      // Do not write custom names into user_payment_options.payment_option — that
      // column is a fixed enum of the original seven types and cannot store new
      // category names without breaking existing XM/Bank rows.
      return jsonSuccess(`Your ${category.name} account is added successfully.`, {
        payment_option: {
          id: newId,
          user_id: userId,
          account_reference: newId,
          payment_option: category.name,
          account: {
            id: newId,
            field_values: collected.values,
            display: summarizeValues(fields, collected.values),
          },
        },
      });
    }
  }
}

export async function updateUserPaymentAccount(userId, payload) {
  await assertAccountsAccess(userId);

  const accountType = normalizeAccountType(payload.account_type ?? payload.accountType);
  const accountId = Number(payload.account_id ?? payload.accountId);
  if (!accountType || !Number.isInteger(accountId) || accountId <= 0) {
    return jsonError('Account type and account id are required.');
  }

  const hiddenError = await rejectIfPayAccountCategoryHidden(accountType);
  if (hiddenError) return hiddenError;

  switch (accountType) {
    case 'XM': {
      const xmAccountId = String(payload.xm_account_id ?? payload.xmAccountId ?? '').trim();
      if (!/^\d+$/.test(xmAccountId)) {
        return jsonError('Incorrect XM account id. Please try again.');
      }
      const result = await query(
        `UPDATE user_xm_accounts SET xm_account_id = ?, updated_at = NOW()
         WHERE id = ? AND user_id = ? AND status = 'AVAILABLE' AND ${notDeletedClause()}`,
        [xmAccountId, accountId, userId],
      );
      if (result.affectedRows) {
        return jsonSuccess('Your XM account is updated successfully.');
      }
      return jsonError('We could not find an active XM account. Please reload the page and try again.');
    }
    case 'SKRILL': {
      const email = String(payload.skrill_email ?? payload.skrillEmail ?? '').trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return jsonError('Incorrect Skrill account. Please try again.');
      }
      const result = await query(
        `UPDATE user_skrill_accounts SET skrill_email = ?, updated_at = NOW()
         WHERE id = ? AND user_id = ? AND status = 'AVAILABLE' AND ${notDeletedClause()}`,
        [email, accountId, userId],
      );
      if (result.affectedRows) {
        return jsonSuccess('Your Skrill account is updated successfully.');
      }
      return jsonError('We could not find an active Skrill account. Please reload the page and try again.');
    }
    case 'NETELLER': {
      const email = String(payload.neteller_email ?? payload.netellerEmail ?? '').trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return jsonError('Incorrect Neteller account. Please try again.');
      }
      const result = await query(
        `UPDATE user_neteller_accounts SET neteller_email = ?, updated_at = NOW()
         WHERE id = ? AND user_id = ? AND status = 'AVAILABLE' AND ${notDeletedClause()}`,
        [email, accountId, userId],
      );
      if (result.affectedRows) {
        return jsonSuccess('Your Neteller account is updated successfully.');
      }
      return jsonError(
        'We could not find an active Neteller account. Please reload the page and try again.',
      );
    }
    case 'PERFECT MONEY': {
      const pmAccountId = String(payload.pm_account_id ?? payload.pmAccountId ?? '').trim();
      if (!/^[a-zA-Z]+[0-9]+$/.test(pmAccountId)) {
        return jsonError('Incorrect Perfect Money account id. Please try again.');
      }
      const result = await query(
        `UPDATE user_perfect_money_accounts SET pm_account_id = ?, updated_at = NOW()
         WHERE id = ? AND user_id = ? AND status = 'AVAILABLE' AND ${notDeletedClause()}`,
        [pmAccountId, accountId, userId],
      );
      if (result.affectedRows) {
        return jsonSuccess('Your Perfect-Money account is updated successfully.');
      }
      return jsonError(
        'We could not find an active Perfect-Money account. Please reload the page and try again.',
      );
    }
    case 'BANK TRANSFER': {
      const accountNumber = String(payload.account_number ?? payload.accountNumber ?? '').trim();
      const beneficiaryName = String(payload.beneficiary_name ?? payload.beneficiaryName ?? '').trim();
      const bank = String(payload.bank ?? '').trim();
      const branch = String(payload.branch ?? '').trim();
      if (!/^\d+$/.test(accountNumber)) {
        return jsonError('Incorrect bank account number. Please try again.');
      }
      const result = await query(
        `UPDATE user_bank_accounts
         SET beneficiary_name = ?, account_number = ?, bank = ?, branch = ?, updated_at = NOW()
         WHERE id = ? AND user_id = ? AND ${notDeletedClause()}`,
        [beneficiaryName, accountNumber, bank, branch, accountId, userId],
      );
      if (result.affectedRows) {
        return jsonSuccess('Your Bank account is updated successfully.');
      }
      return jsonError(
        'We could not find an active Bank account. Please reload the page and try again.',
      );
    }
    case 'CARD PAYMENT': {
      const accountNumber = String(payload.account_number ?? payload.accountNumber ?? '').trim();
      const beneficiaryName = String(payload.beneficiary_name ?? payload.beneficiaryName ?? '').trim();
      const bank = String(payload.bank ?? '').trim();
      const branch = String(payload.branch ?? '').trim();
      const result = await query(
        `UPDATE user_card_payment_accounts
         SET beneficiary_name = ?, bank_account_number = ?, bank = ?, branch = ?, updated_at = NOW()
         WHERE id = ? AND user_id = ? AND status = 'AVAILABLE' AND ${notDeletedClause()}`,
        [beneficiaryName, accountNumber, bank, branch, accountId, userId],
      );
      if (result.affectedRows) {
        return jsonSuccess('Your Bank Card is updated successfully.');
      }
      return jsonError('We could not find an active Bank Card. Please reload the page and try again.');
    }
    case 'CRYPTO': {
      const cryptoAccountId = String(payload.crypto_account_id ?? payload.cryptoAccountId ?? '').trim();
      if (!cryptoAccountId) {
        return jsonError('Incorrect bank account number. Please try again.');
      }
      const result = await query(
        `UPDATE user_crypto_accounts SET crypto_account_id = ?, updated_at = NOW()
         WHERE id = ? AND user_id = ? AND status = 'AVAILABLE' AND ${notDeletedClause()}`,
        [cryptoAccountId, accountId, userId],
      );
      if (result.affectedRows) {
        return jsonSuccess('Your Crypto account is updated successfully.');
      }
      return jsonError(
        'We could not find an active Crypto account. Please reload the page and try again.',
      );
    }
    default: {
      const category = await findCustomCategoryByAccountType(accountType);
      if (!category) return jsonError('Account type is not supported.');
      await ensureUserCustomPayAccountSchema();
      const fields = customFieldDefs(category);
      const collected = collectFieldValues(fields, payload);
      if (collected.error) return jsonError(collected.error);
      const result = await query(
        `UPDATE user_custom_pay_accounts
         SET field_values = ?, updated_at = NOW()
         WHERE id = ? AND user_id = ? AND category_id = ? AND ${notDeletedClause()}`,
        [JSON.stringify(collected.values), accountId, userId, category.id],
      );
      if (result.affectedRows) {
        return jsonSuccess(`Your ${category.name} account is updated successfully.`);
      }
      return jsonError(
        `We could not find an active ${category.name} account. Please reload the page and try again.`,
      );
    }
  }
}

async function softDeletePaymentOption(userId, accountReference, paymentOption) {
  await query(
    `UPDATE user_payment_options
     SET is_deleted = 1, updated_at = NOW()
     WHERE user_id = ? AND account_reference = ? AND payment_option = ?`,
    [userId, accountReference, paymentOption],
  );
}

export async function deleteUserPaymentAccount(userId, payload) {
  await assertAccountsAccess(userId);

  const accountType = normalizeAccountType(payload.account_type ?? payload.accountType);
  const accountId = Number(payload.account_id ?? payload.accountId);
  if (!accountType || !Number.isInteger(accountId) || accountId <= 0) {
    return jsonError('Account type and account id are required.');
  }

  const tableMap = {
    XM: 'user_xm_accounts',
    SKRILL: 'user_skrill_accounts',
    NETELLER: 'user_neteller_accounts',
    'PERFECT MONEY': 'user_perfect_money_accounts',
    'BANK TRANSFER': 'user_bank_accounts',
    'CARD PAYMENT': 'user_card_payment_accounts',
    CRYPTO: 'user_crypto_accounts',
  };

  const table = tableMap[accountType];
  if (table) {
    const rows = await query(
      `SELECT id FROM ${table} WHERE id = ? AND user_id = ? AND ${notDeletedClause()} LIMIT 1`,
      [accountId, userId],
    );
    if (!rows[0]) {
      return jsonError('Account not found or already deleted.');
    }

    await query(`UPDATE ${table} SET is_deleted = 1, updated_at = NOW() WHERE id = ? AND user_id = ?`, [
      accountId,
      userId,
    ]);
    await softDeletePaymentOption(userId, accountId, accountType);

    const label = accountType.replace(' PERFECT MONEY', ' Perfect-Money').replace('BANK TRANSFER', 'Bank');
    return jsonSuccess(`Your ${label} account is marked as deleted successfully`);
  }

  const category = await findCustomCategoryByAccountType(accountType);
  if (!category) {
    return jsonError('Account type is not supported.');
  }
  await ensureUserCustomPayAccountSchema();
  const rows = await query(
    `SELECT id FROM user_custom_pay_accounts
     WHERE id = ? AND user_id = ? AND category_id = ? AND ${notDeletedClause()}
     LIMIT 1`,
    [accountId, userId, category.id],
  );
  if (!rows[0]) {
    return jsonError('Account not found or already deleted.');
  }
  await query(
    `UPDATE user_custom_pay_accounts SET is_deleted = 1, updated_at = NOW() WHERE id = ? AND user_id = ?`,
    [accountId, userId],
  );
  return jsonSuccess(`Your ${category.name} account is marked as deleted successfully`);
}
