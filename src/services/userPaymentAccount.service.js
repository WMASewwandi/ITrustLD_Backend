import { query } from '../config/database.js';
import {
  findAccountHolderByUserId,
  isAccountBanned,
  needsVerification,
} from './accountHolder.service.js';

const MAX_ACCOUNTS_PER_TYPE = 5;

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
        cryptoAccountId: row.crypto_account_id,
        status: row.status,
        display: row.crypto_account_id,
      }));
    }
    default:
      return [];
  }
}

export async function listUserPaymentAccounts(userId) {
  await assertAccountsAccess(userId);

  const groupRows = await query(
    `SELECT upo.payment_option, COUNT(*) AS account_count
     FROM user_payment_options upo
     WHERE upo.user_id = ?
       AND (upo.is_deleted = 0 OR upo.is_deleted IS NULL OR upo.is_deleted = FALSE)
       AND upo.payment_option IN (
         SELECT payment_option_name
         FROM payment_options
         WHERE UPPER(availability) = 'AVAILABLE'
           AND (is_deleted = 0 OR is_deleted IS NULL)
       )
     GROUP BY upo.payment_option
     ORDER BY upo.payment_option ASC`,
    [userId],
  );

  const accountGroups = [];
  for (const row of groupRows) {
    const accounts = await loadAccountsForType(userId, row.payment_option);
    if (accounts.length > 0) {
      accountGroups.push({
        payment_option: row.payment_option,
        account_count: accounts.length,
        accounts,
      });
    }
  }

  const systemPaymentOptions = await query(
    `SELECT MIN(id) AS id, payment_option_name
     FROM payment_options
     WHERE UPPER(availability) = 'AVAILABLE'
       AND (is_deleted = 0 OR is_deleted IS NULL)
     GROUP BY payment_option_name
     ORDER BY MIN(id) ASC`,
  );

  return {
    account_groups: accountGroups,
    system_payment_options: systemPaymentOptions.map((opt) => ({
      id: opt.id,
      name: opt.payment_option_name,
    })),
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
    default:
      return jsonError(
        'Account type is not supported at the moment. Please choose a different account type.',
      );
  }
}

export async function updateUserPaymentAccount(userId, payload) {
  await assertAccountsAccess(userId);

  const accountType = normalizeAccountType(payload.account_type ?? payload.accountType);
  const accountId = Number(payload.account_id ?? payload.accountId);
  if (!accountType || !Number.isInteger(accountId) || accountId <= 0) {
    return jsonError('Account type and account id are required.');
  }

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
    default:
      return jsonError('Account type is not supported.');
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
  if (!table) {
    return jsonError('Account type is not supported.');
  }

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
