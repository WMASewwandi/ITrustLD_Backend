import { query } from '../config/database.js';
import {
  customPayAccountExists,
  listCustomPayAccountCategories,
} from './customPayAccount.service.js';

const ACCOUNT_CONFIG = {
  bank: {
    table: 'admin_bank_accounts',
    mapRow: (row) => ({
      id: row.id,
      accountNumber: row.bank_account_number,
      name: row.beneficiary_name,
      bank: row.bank,
      branch: row.branch,
      active: row.status === 'AVAILABLE',
    }),
  },
  skrill: {
    table: 'admin_skrill_accounts',
    emailColumn: 'skrill_email',
    mapRow: (row) => ({
      id: row.id,
      email: row.skrill_email,
      active: row.status === 'AVAILABLE',
    }),
  },
  neteller: {
    table: 'admin_neteller_accounts',
    emailColumn: 'neteller_email',
    mapRow: (row) => ({
      id: row.id,
      email: row.neteller_email,
      active: row.status === 'AVAILABLE',
    }),
  },
  binance: {
    table: 'admin_binance_accounts',
    mapRow: (row) => ({
      id: row.id,
      trc20WalletAddress: row.trc20_wallet_address,
      binanceEmail: row.binance_email,
      active: row.status === 'AVAILABLE',
    }),
  },
  pm: {
    table: 'admin_perfect_money_accounts',
    accountIdColumn: 'pm_account_id',
    mapRow: (row) => ({
      id: row.id,
      accountId: row.pm_account_id,
      active: row.status === 'AVAILABLE',
    }),
  },
  xm: {
    table: 'admin_xm_accounts',
    accountIdColumn: 'xm_account_id',
    mapRow: (row) => ({
      id: row.id,
      accountId: row.xm_account_id,
      active: row.status === 'AVAILABLE',
    }),
  },
};

const EMAIL_WALLET_TYPES = new Set(['skrill', 'neteller']);

function validationError(message, status = 422) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function parseAccountType(type) {
  const accountType = String(type || '').trim().toLowerCase();
  if (!ACCOUNT_CONFIG[accountType]) {
    throw validationError('Invalid account type.', 400);
  }
  return accountType;
}

function parseAccountId(id) {
  const accountId = Number(id);
  if (!Number.isInteger(accountId) || accountId <= 0) {
    throw validationError('Account id is required.');
  }
  return accountId;
}

function validateBankPayload(payload) {
  const accountNumber = String(payload.accountNumber ?? '').trim();
  const name = String(payload.name ?? '').trim();
  const bank = String(payload.bank ?? '').trim();
  const branch = String(payload.branch ?? '').trim();

  if (!accountNumber) throw validationError('Account number is required.');
  if (!name) throw validationError('Name is required.');
  if (!bank) throw validationError('Bank is required.');
  if (!branch) throw validationError('Branch is required.');

  return { accountNumber, name, bank, branch };
}

function validateEmailPayload(payload) {
  const email = String(payload.email ?? '').trim();
  if (!email) throw validationError('Email is required.');
  return { email };
}

function validateBinancePayload(payload) {
  const trc20WalletAddress = String(payload.trc20WalletAddress ?? '').trim();
  const binanceEmail = String(payload.binanceEmail ?? '').trim();

  if (!trc20WalletAddress) throw validationError('TRC20 wallet address is required.');
  if (!binanceEmail) throw validationError('Binance email is required.');

  return { trc20WalletAddress, binanceEmail };
}

function validateAccountIdPayload(payload) {
  const accountId = String(payload.accountId ?? '').trim();
  if (!accountId) throw validationError('Account ID is required.');
  return { accountId };
}

async function getAccountRow(accountType, accountId) {
  const config = ACCOUNT_CONFIG[accountType];
  const rows = await query(
    `SELECT *
     FROM ${config.table}
     WHERE id = ?
       AND is_deleted = 0
     LIMIT 1`,
    [accountId],
  );
  return rows[0] ?? null;
}

export async function listPayAccounts() {
  const [bankRows, skrillRows, netellerRows, binanceRows, pmRows, xmRows] = await Promise.all([
    query(
      `SELECT id, bank_account_number, beneficiary_name, bank, branch, status
       FROM admin_bank_accounts
       WHERE is_deleted = 0
       ORDER BY id ASC`,
    ),
    query(
      `SELECT id, skrill_email, status
       FROM admin_skrill_accounts
       WHERE is_deleted = 0
       ORDER BY id ASC`,
    ),
    query(
      `SELECT id, neteller_email, status
       FROM admin_neteller_accounts
       WHERE is_deleted = 0
       ORDER BY id ASC`,
    ),
    query(
      `SELECT id, trc20_wallet_address, binance_email, status
       FROM admin_binance_accounts
       WHERE is_deleted = 0
       ORDER BY id ASC`,
    ),
    query(
      `SELECT id, pm_account_id, status
       FROM admin_perfect_money_accounts
       WHERE is_deleted = 0
       ORDER BY id ASC`,
    ),
    query(
      `SELECT id, xm_account_id, status
       FROM admin_xm_accounts
       WHERE is_deleted = 0
       ORDER BY id ASC`,
    ),
  ]);

  let customCategories = [];
  try {
    customCategories = await listCustomPayAccountCategories();
  } catch (error) {
    console.error('[pay-accounts] failed to load custom categories', error);
  }

  return {
    banks: bankRows.map(ACCOUNT_CONFIG.bank.mapRow),
    skrill: skrillRows.map(ACCOUNT_CONFIG.skrill.mapRow),
    neteller: netellerRows.map(ACCOUNT_CONFIG.neteller.mapRow),
    binance: binanceRows.map(ACCOUNT_CONFIG.binance.mapRow),
    pm: pmRows.map(ACCOUNT_CONFIG.pm.mapRow),
    xm: xmRows.map(ACCOUNT_CONFIG.xm.mapRow),
    customCategories,
  };
}

export async function createBankAccount(userId, payload) {
  const { accountNumber, name, bank, branch } = validateBankPayload(payload);

  const result = await query(
    `INSERT INTO admin_bank_accounts
      (user_id, bank_account_number, beneficiary_name, bank, branch, status, is_deleted)
     VALUES (?, ?, ?, ?, ?, 'AVAILABLE', 0)`,
    [userId, accountNumber, name, bank, branch],
  );

  const row = await getAccountRow('bank', result.insertId);
  return ACCOUNT_CONFIG.bank.mapRow(row);
}

export async function updateBankAccount(accountId, userId, payload) {
  const id = parseAccountId(accountId);
  const existing = await getAccountRow('bank', id);
  if (!existing) throw validationError('Bank account not found.', 404);

  const { accountNumber, name, bank, branch } = validateBankPayload(payload);

  await query(
    `UPDATE admin_bank_accounts
     SET user_id = ?,
         bank_account_number = ?,
         beneficiary_name = ?,
         bank = ?,
         branch = ?
     WHERE id = ?
       AND is_deleted = 0`,
    [userId, accountNumber, name, bank, branch, id],
  );

  const row = await getAccountRow('bank', id);
  return ACCOUNT_CONFIG.bank.mapRow(row);
}

export async function createWalletAccount(accountType, userId, payload) {
  const type = parseAccountType(accountType);
  if (!EMAIL_WALLET_TYPES.has(type)) {
    throw validationError('Invalid account type.', 400);
  }

  const { email } = validateEmailPayload(payload);
  const config = ACCOUNT_CONFIG[type];

  const result = await query(
    `INSERT INTO ${config.table}
      (user_id, ${config.emailColumn}, status, is_deleted)
     VALUES (?, ?, 'AVAILABLE', 0)`,
    [userId, email],
  );

  const row = await getAccountRow(type, result.insertId);
  return config.mapRow(row);
}

export async function updateWalletAccount(accountType, accountId, userId, payload) {
  const type = parseAccountType(accountType);
  if (!EMAIL_WALLET_TYPES.has(type)) {
    throw validationError('Invalid account type.', 400);
  }

  const id = parseAccountId(accountId);
  const existing = await getAccountRow(type, id);
  if (!existing) throw validationError('Account not found.', 404);

  const { email } = validateEmailPayload(payload);
  const config = ACCOUNT_CONFIG[type];

  await query(
    `UPDATE ${config.table}
     SET user_id = ?,
         ${config.emailColumn} = ?
     WHERE id = ?
       AND is_deleted = 0`,
    [userId, email, id],
  );

  const row = await getAccountRow(type, id);
  return config.mapRow(row);
}

export async function createBinanceAccount(userId, payload) {
  const { trc20WalletAddress, binanceEmail } = validateBinancePayload(payload);

  const result = await query(
    `INSERT INTO admin_binance_accounts
      (user_id, trc20_wallet_address, binance_email, status, is_deleted)
     VALUES (?, ?, ?, 'AVAILABLE', 0)`,
    [userId, trc20WalletAddress, binanceEmail],
  );

  const row = await getAccountRow('binance', result.insertId);
  return ACCOUNT_CONFIG.binance.mapRow(row);
}

export async function updateBinanceAccount(accountId, userId, payload) {
  const id = parseAccountId(accountId);
  const existing = await getAccountRow('binance', id);
  if (!existing) throw validationError('Binance account not found.', 404);

  const { trc20WalletAddress, binanceEmail } = validateBinancePayload(payload);

  await query(
    `UPDATE admin_binance_accounts
     SET user_id = ?,
         trc20_wallet_address = ?,
         binance_email = ?
     WHERE id = ?
       AND is_deleted = 0`,
    [userId, trc20WalletAddress, binanceEmail, id],
  );

  const row = await getAccountRow('binance', id);
  return ACCOUNT_CONFIG.binance.mapRow(row);
}

export async function createAccountIdPayAccount(accountType, userId, payload) {
  const type = parseAccountType(accountType);
  if (type !== 'pm' && type !== 'xm') {
    throw validationError('Invalid account type.', 400);
  }

  const { accountId } = validateAccountIdPayload(payload);
  const config = ACCOUNT_CONFIG[type];

  const result = await query(
    `INSERT INTO ${config.table}
      (user_id, ${config.accountIdColumn}, status, is_deleted)
     VALUES (?, ?, 'AVAILABLE', 0)`,
    [userId, accountId],
  );

  const row = await getAccountRow(type, result.insertId);
  return config.mapRow(row);
}

export async function updateAccountIdPayAccount(accountType, accountId, userId, payload) {
  const type = parseAccountType(accountType);
  if (type !== 'pm' && type !== 'xm') {
    throw validationError('Invalid account type.', 400);
  }

  const id = parseAccountId(accountId);
  const existing = await getAccountRow(type, id);
  if (!existing) throw validationError('Account not found.', 404);

  const { accountId: nextAccountId } = validateAccountIdPayload(payload);
  const config = ACCOUNT_CONFIG[type];

  await query(
    `UPDATE ${config.table}
     SET user_id = ?,
         ${config.accountIdColumn} = ?
     WHERE id = ?
       AND is_deleted = 0`,
    [userId, nextAccountId, id],
  );

  const row = await getAccountRow(type, id);
  return config.mapRow(row);
}

export async function deletePayAccount(accountType, accountId) {
  const type = parseAccountType(accountType);
  const id = parseAccountId(accountId);
  const existing = await getAccountRow(type, id);
  if (!existing) throw validationError('Account not found.', 404);

  const config = ACCOUNT_CONFIG[type];
  await query(
    `UPDATE ${config.table}
     SET is_deleted = 1
     WHERE id = ?`,
    [id],
  );

  return { ok: true, message: 'Successfully deleted the admin pay account.' };
}

export async function togglePayAccountStatus(accountType, accountId, active) {
  const type = parseAccountType(accountType);
  const id = parseAccountId(accountId);
  const existing = await getAccountRow(type, id);
  if (!existing) throw validationError('Account not found.', 404);

  const status = active ? 'AVAILABLE' : 'NOT_AVAILABLE';
  const config = ACCOUNT_CONFIG[type];

  await query(
    `UPDATE ${config.table}
     SET status = ?
     WHERE id = ?
       AND is_deleted = 0`,
    [status, id],
  );

  const row = await getAccountRow(type, id);
  return config.mapRow(row);
}

const PAY_ACCOUNT_GROUP_LABELS = {
  bank: 'Bank Account',
  skrill: 'Skrill',
  neteller: 'Neteller',
  binance: 'Binance',
  pm: 'Perfect Money',
  xm: 'XM',
};

function formatPayAccountChoice(type, account) {
  let detail = '';
  if (type === 'bank') {
    detail = [account.name, account.bank, account.accountNumber].filter(Boolean).join(' · ');
  } else if (type === 'skrill' || type === 'neteller') {
    detail = account.email || '';
  } else if (type === 'binance') {
    detail = [account.binanceEmail, account.trc20WalletAddress].filter(Boolean).join(' · ');
  } else {
    detail = account.accountId || '';
  }

  const group = PAY_ACCOUNT_GROUP_LABELS[type] || type;
  const label = `${group}${detail ? ` · ${detail}` : ` · #${account.id}`}${
    account.active ? '' : ' (Inactive)'
  }`;

  return {
    key: `${type}:${account.id}`,
    type,
    id: account.id,
    group,
    label,
    active: Boolean(account.active),
  };
}

export async function payAccountExists(type, id) {
  const accountType = String(type || '').trim().toLowerCase();
  const accountId = Number(id);
  if (!Number.isInteger(accountId) || accountId <= 0) return false;
  if (accountType === 'custom') {
    return customPayAccountExists(accountId);
  }
  if (!ACCOUNT_CONFIG[accountType]) return false;
  const row = await getAccountRow(accountType, accountId);
  return Boolean(row);
}

export async function listPayAccountChoices() {
  const accounts = await listPayAccounts();
  const groups = [
    ['bank', accounts.banks],
    ['skrill', accounts.skrill],
    ['neteller', accounts.neteller],
    ['binance', accounts.binance],
    ['pm', accounts.pm],
    ['xm', accounts.xm],
  ];

  const choices = [];
  for (const [type, rows] of groups) {
    for (const row of rows || []) {
      choices.push(formatPayAccountChoice(type, row));
    }
  }

  for (const category of accounts.customCategories || []) {
    for (const row of category.accounts || []) {
      const detail = row.summary || '';
      choices.push({
        key: `custom:${row.id}`,
        type: 'custom',
        id: row.id,
        group: category.name,
        label: `${category.name}${detail ? ` · ${detail}` : ` · #${row.id}`}${
          row.active ? '' : ' (Inactive)'
        }`,
        active: Boolean(row.active),
      });
    }
  }

  return choices;
}
