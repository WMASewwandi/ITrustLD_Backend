import { query } from '../config/database.js';
import {
  findAccountHolderByUserId,
  isAccountBanned,
  needsVerification,
} from './accountHolder.service.js';
import { resolveWalletLogoPublicUrl } from './walletLogoStorage.service.js';
import { ensureWalletNavigateSchema } from './wallet.service.js';
import { autoAssignWithdrawal } from './withdrawalAssignment.service.js';
import { storeWithdrawalProof } from './withdrawalProofStorage.service.js';
import { bumpAdminNavCounts } from './adminNavCountsRevision.service.js';
import { formatDateTimeParts, nowSqlDateTime, resolveFilterDateRange } from '../utils/slTime.js';
import {
  attachPendingCounts,
  assertWithdrawalMethodPendingLimit,
  getOpenWithdrawalCountsByMethod,
} from './pendingMethodLimit.service.js';

function validationError(message, status = 422) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function generateTransactionId(userId) {
  const paddedUserId = String(userId).padStart(2, '0');
  const randomDigits = 12 - paddedUserId.length;
  const max = 10 ** randomDigits - 1;
  const randomPart = String(Math.floor(Math.random() * (max + 1))).padStart(randomDigits, '0');
  return `${paddedUserId}${randomPart}`;
}

async function assertWithdrawalAccess(userId) {
  const accountHolder = await findAccountHolderByUserId(userId);
  if (!accountHolder) {
    throw validationError('Account holder not found.', 404);
  }
  if (isAccountBanned(accountHolder)) {
    throw validationError('Your account has been banned. Please contact support.', 403);
  }
  if (needsVerification(accountHolder)) {
    const error = validationError('Complete account verification before making a withdrawal.');
    error.code = 'VERIFICATION_REQUIRED';
    throw error;
  }
  return accountHolder;
}

function mapCashoutMethodRow(row) {
  const allowNavigateButton = Boolean(Number(row.allow_navigate_button));
  const navigateUrl = allowNavigateButton ? String(row.navigate_url || '').trim() || null : null;
  const navigateButtonLabel = allowNavigateButton
    ? String(row.navigate_button_label || '').trim() || null
    : null;

  return {
    id: row.id,
    name: row.cashout_method_name,
    currency: row.cashout_method_currency || 'USD',
    platformType: row.cashout_method_id_type || '',
    minLimit: Number(row.minimum_limit ?? 0),
    maxLimit: Number(row.maximum_limit ?? 0),
    terms: row.tnc || '',
    logoUrl: resolveWalletLogoPublicUrl(row.cashout_method_logo),
    allowNavigateButton,
    allow_navigate_button: allowNavigateButton,
    navigateUrl,
    navigate_url: navigateUrl,
    navigateButtonLabel,
    navigate_button_label: navigateButtonLabel,
  };
}

function mapPaymentOptionRow(row) {
  return {
    id: row.id,
    name: row.payment_option_name,
    currency: row.payment_option_currency,
    priority: row.priority === 'YES',
  };
}

async function loadCashoutMethods() {
  await ensureWalletNavigateSchema();
  const rows = await query(
    `SELECT cm.*
     FROM cashout_methods cm
     WHERE UPPER(cm.availability) = 'AVAILABLE'
       AND (cm.is_deleted = 0 OR cm.is_deleted IS NULL)
       AND EXISTS (
         SELECT 1
         FROM withdrawal_rates wr
         WHERE wr.cashout_method_id = cm.id
           AND (wr.is_deleted = 0 OR wr.is_deleted IS NULL)
       )
     ORDER BY cm.id ASC`,
  );
  return rows.map(mapCashoutMethodRow);
}

async function loadRecentCashoutAmounts(userId) {
  const rows = await query(
    `SELECT cashout_amount
     FROM withdrawals
     WHERE user_id = ?
     ORDER BY created_at DESC
     LIMIT 30`,
    [userId],
  );
  const seen = new Set();
  const amounts = [];
  for (const row of rows) {
    const value = Number(row.cashout_amount);
    if (!Number.isFinite(value)) continue;
    const key = value.toFixed(2);
    if (seen.has(key)) continue;
    seen.add(key);
    amounts.push(key);
    if (amounts.length >= 5) break;
  }
  return amounts;
}

async function loadWithdrawalRatesForMethod(cashoutMethodId) {
  const rows = await query(
    `SELECT wr.id, wr.cashout_method_id, wr.payment_option_id, wr.rate, wr.applicable_date,
            po.payment_option_name, po.payment_option_currency, po.priority, po.availability
     FROM withdrawal_rates wr
     INNER JOIN payment_options po ON po.id = wr.payment_option_id
     INNER JOIN cashout_methods cm ON cm.id = wr.cashout_method_id
     WHERE wr.cashout_method_id = ?
       AND (wr.is_deleted = 0 OR wr.is_deleted IS NULL)
       AND UPPER(cm.availability) = 'AVAILABLE'
       AND UPPER(po.availability) = 'AVAILABLE'
       AND (po.is_deleted = 0 OR po.is_deleted IS NULL)
     ORDER BY wr.id DESC`,
    [cashoutMethodId],
  );

  const latestByKey = new Map();
  for (const row of rows) {
    const key = String(row.payment_option_id);
    if (!latestByKey.has(key)) {
      latestByKey.set(key, {
        id: row.id,
        cashoutMethodId: row.cashout_method_id,
        paymentOptionId: row.payment_option_id,
        rate: Number(row.rate),
        applicableDate: row.applicable_date,
        paymentOptionName: row.payment_option_name,
        paymentOptionCurrency: row.payment_option_currency,
      });
    }
  }
  return Array.from(latestByKey.values());
}

async function loadPriorityWithdrawalRate(cashoutMethodId) {
  const rows = await query(
    `SELECT wr.id, wr.rate, wr.payment_option_id, po.payment_option_currency, po.payment_option_name
     FROM withdrawal_rates wr
     INNER JOIN payment_options po ON po.id = wr.payment_option_id
     INNER JOIN cashout_methods cm ON cm.id = wr.cashout_method_id
     WHERE wr.cashout_method_id = ?
       AND (wr.is_deleted = 0 OR wr.is_deleted IS NULL)
       AND UPPER(cm.availability) = 'AVAILABLE'
       AND UPPER(po.availability) = 'AVAILABLE'
       AND po.priority = 'YES'
       AND (po.is_deleted = 0 OR po.is_deleted IS NULL)
     ORDER BY wr.id DESC
     LIMIT 1`,
    [cashoutMethodId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    rate: Number(row.rate),
    paymentOptionId: row.payment_option_id,
    paymentOptionCurrency: row.payment_option_currency,
    paymentOptionName: row.payment_option_name,
  };
}

async function loadSupportedReceivingOptions(cashoutMethodId, cashoutMethodName) {
  const rows = await query(
    `SELECT po.id, po.payment_option_name, po.payment_option_currency, po.priority
     FROM wallet_supported_payment_options wspo
     INNER JOIN payment_options po ON po.id = wspo.payment_option_id
     WHERE wspo.wallet_id = ?
       AND wspo.wallet_type = 'cashout'
       AND UPPER(wspo.status) = 'ACTIVE'
       AND UPPER(po.availability) = 'AVAILABLE'
       AND (po.is_deleted = 0 OR po.is_deleted IS NULL)
     ORDER BY po.id ASC`,
    [cashoutMethodId],
  );

  const methodName = String(cashoutMethodName || '').trim().toLowerCase();
  return rows
    .filter((row) => String(row.payment_option_name || '').trim().toLowerCase() !== methodName)
    .map(mapPaymentOptionRow);
}

async function getCashoutMethodById(cashoutMethodId) {
  const rows = await query(
    `SELECT *
     FROM cashout_methods
     WHERE id = ?
       AND UPPER(availability) = 'AVAILABLE'
       AND (is_deleted = 0 OR is_deleted IS NULL)
     LIMIT 1`,
    [cashoutMethodId],
  );
  return rows[0] ? mapCashoutMethodRow(rows[0]) : null;
}

async function loadCashoutMethodPaymentAccounts(cashoutMethodName) {
  const name = String(cashoutMethodName || '').trim().toLowerCase();

  if (name === 'bank transfer') {
    const rows = await query(
      `SELECT id, bank_account_number, beneficiary_name, bank, branch
       FROM admin_bank_accounts
       WHERE status = 'AVAILABLE' AND (is_deleted = 0 OR is_deleted IS NULL)
       ORDER BY id ASC`,
    );
    return {
      type: 'bank_transfer',
      accounts: rows.map((row) => ({
        id: row.id,
        accountNumber: row.bank_account_number,
        name: row.beneficiary_name,
        bank: row.bank,
        branch: row.branch,
      })),
    };
  }

  if (name === 'crypto' || name === 'binance') {
    const rows = await query(
      `SELECT id, trc20_wallet_address, binance_email
       FROM admin_binance_accounts
       WHERE status = 'AVAILABLE' AND (is_deleted = 0 OR is_deleted IS NULL)
       ORDER BY id ASC`,
    );
    return {
      type: 'binance',
      accounts: rows.map((row) => ({
        id: row.id,
        trc20WalletAddress: row.trc20_wallet_address,
        binanceEmail: row.binance_email,
      })),
    };
  }

  if (name === 'xm') {
    const rows = await query(
      `SELECT id, xm_account_id
       FROM admin_xm_accounts
       WHERE status = 'AVAILABLE' AND (is_deleted = 0 OR is_deleted IS NULL)
       ORDER BY id ASC`,
    );
    return {
      type: 'xm',
      accounts: rows.map((row) => ({
        id: row.id,
        accountId: row.xm_account_id,
      })),
    };
  }

  if (name === 'skrill') {
    const rows = await query(
      `SELECT id, skrill_email
       FROM admin_skrill_accounts
       WHERE status = 'AVAILABLE' AND (is_deleted = 0 OR is_deleted IS NULL)
       ORDER BY id ASC`,
    );
    return {
      type: 'skrill',
      accounts: rows.map((row) => ({
        id: row.id,
        email: row.skrill_email,
      })),
    };
  }

  if (name === 'neteller') {
    const rows = await query(
      `SELECT id, neteller_email
       FROM admin_neteller_accounts
       WHERE status = 'AVAILABLE' AND (is_deleted = 0 OR is_deleted IS NULL)
       ORDER BY id ASC`,
    );
    return {
      type: 'neteller',
      accounts: rows.map((row) => ({
        id: row.id,
        email: row.neteller_email,
      })),
    };
  }

  if (name === 'perfect money') {
    const rows = await query(
      `SELECT id, pm_account_id
       FROM admin_perfect_money_accounts
       WHERE status = 'AVAILABLE' AND (is_deleted = 0 OR is_deleted IS NULL)
       ORDER BY id ASC`,
    );
    return {
      type: 'perfect_money',
      accounts: rows.map((row) => ({
        id: row.id,
        accountId: row.pm_account_id,
      })),
    };
  }

  if (name === 'card payment') {
    const rows = await query(
      `SELECT id, card_payment_link
       FROM admin_card_payment_links
       WHERE status = 'AVAILABLE' AND (is_deleted = 0 OR is_deleted IS NULL)
       ORDER BY id ASC`,
    );
    return {
      type: 'card_payment',
      accounts: rows.map((row) => ({
        id: row.id,
        cardPaymentLink: row.card_payment_link,
      })),
    };
  }

  return { type: 'unknown', accounts: [] };
}

async function loadUserReceivingAccounts(userId, paymentOptionName) {
  const optionName = String(paymentOptionName || '').trim();
  if (!optionName) return [];

  const rows = await query(
    `SELECT id, account_reference, payment_option
     FROM user_payment_options
     WHERE user_id = ?
       AND UPPER(REPLACE(payment_option, '_', ' ')) = UPPER(REPLACE(?, '_', ' '))
       AND (is_deleted = 0 OR is_deleted IS NULL OR is_deleted = FALSE)
     ORDER BY id ASC`,
    [userId, optionName],
  );

  const accounts = [];
  for (const row of rows) {
    const refId = row.account_reference;
    let details = null;

    switch (row.payment_option) {
      case 'XM': {
        const xmRows = await query(`SELECT id, xm_account_id FROM user_xm_accounts WHERE id = ? LIMIT 1`, [
          refId,
        ]);
        if (xmRows[0]) {
          details = {
            id: xmRows[0].id,
            accountType: 'XM',
            label: `XM — ${xmRows[0].xm_account_id}`,
            accountId: xmRows[0].xm_account_id,
          };
        }
        break;
      }
      case 'SKRILL': {
        const skrillRows = await query(
          `SELECT id, skrill_email FROM user_skrill_accounts WHERE id = ? LIMIT 1`,
          [refId],
        );
        if (skrillRows[0]) {
          details = {
            id: skrillRows[0].id,
            accountType: 'SKRILL',
            label: `Skrill — ${skrillRows[0].skrill_email}`,
            accountId: skrillRows[0].skrill_email,
          };
        }
        break;
      }
      case 'NETELLER': {
        const netellerRows = await query(
          `SELECT id, neteller_email FROM user_neteller_accounts WHERE id = ? LIMIT 1`,
          [refId],
        );
        if (netellerRows[0]) {
          details = {
            id: netellerRows[0].id,
            accountType: 'NETELLER',
            label: `Neteller — ${netellerRows[0].neteller_email}`,
            accountId: netellerRows[0].neteller_email,
          };
        }
        break;
      }
      case 'PERFECT MONEY': {
        const pmRows = await query(
          `SELECT id, pm_account_id FROM user_perfect_money_accounts WHERE id = ? LIMIT 1`,
          [refId],
        );
        if (pmRows[0]) {
          details = {
            id: pmRows[0].id,
            accountType: 'PERFECT MONEY',
            label: `Perfect Money — ${pmRows[0].pm_account_id}`,
            accountId: pmRows[0].pm_account_id,
          };
        }
        break;
      }
      case 'BANK TRANSFER': {
        const bankRows = await query(
          `SELECT id, account_number, beneficiary_name, bank, branch
           FROM user_bank_accounts
           WHERE id = ? AND status = 'VERIFIED'
           LIMIT 1`,
          [refId],
        );
        if (bankRows[0]) {
          details = {
            id: bankRows[0].id,
            accountType: 'BANK TRANSFER',
            label: `${bankRows[0].bank} — ${bankRows[0].account_number}`,
            accountId: bankRows[0].account_number,
            beneficiaryName: bankRows[0].beneficiary_name,
            bank: bankRows[0].bank,
            branch: bankRows[0].branch,
          };
        }
        break;
      }
      case 'CARD PAYMENT': {
        const cardRows = await query(
          `SELECT id, bank_account_number, beneficiary_name, bank, branch
           FROM user_card_payment_accounts
           WHERE id = ?
           LIMIT 1`,
          [refId],
        );
        if (cardRows[0]) {
          details = {
            id: cardRows[0].id,
            accountType: 'CARD PAYMENT',
            label: `${cardRows[0].bank} — ${cardRows[0].bank_account_number}`,
            accountId: cardRows[0].bank_account_number,
            beneficiaryName: cardRows[0].beneficiary_name,
            bank: cardRows[0].bank,
            branch: cardRows[0].branch,
          };
        }
        break;
      }
      case 'CRYPTO': {
        const cryptoRows = await query(
          `SELECT id, crypto_account_id FROM user_crypto_accounts WHERE id = ? LIMIT 1`,
          [refId],
        );
        if (cryptoRows[0]) {
          details = {
            id: cryptoRows[0].id,
            accountType: 'CRYPTO',
            label: `Crypto — ${cryptoRows[0].crypto_account_id}`,
            accountId: cryptoRows[0].crypto_account_id,
          };
        }
        break;
      }
      default:
        break;
    }

    if (details) accounts.push(details);
  }

  return accounts;
}

function validateCashoutAccountId(methodName, accountId) {
  const value = String(accountId || '').trim();
  const name = String(methodName || '').trim().toLowerCase();

  if (!value) return 'Cash-out account ID is required.';

  if (name === 'xm') {
    if (value.length < 7 || value.length > 9) {
      return 'Account ID must be between 7 and 9 characters long.';
    }
    return null;
  }

  if (name === 'skrill' || name === 'neteller' || name === 'binance') {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      return 'Please enter a valid email address.';
    }
    return null;
  }

  if (name === 'perfect money') {
    if (!/^U\d{8}$/.test(value)) {
      return 'Account ID must start with "U" followed by 8 digits.';
    }
    return null;
  }

  return null;
}

async function buildAccountDetailsLog(selectedAccountType, selectedAccountId) {
  const accountType = String(selectedAccountType || '').trim();
  const accountId = Number(selectedAccountId);
  if (!accountType || !Number.isInteger(accountId) || accountId <= 0) {
    throw validationError('Please select a payment option.');
  }

  if (accountType === 'BANK TRANSFER') {
    const rows = await query(
      `SELECT id, account_number, beneficiary_name, bank, branch
       FROM user_bank_accounts
       WHERE id = ?
       LIMIT 1`,
      [accountId],
    );
    const bank = rows[0];
    if (!bank) throw validationError('Selected bank account was not found.');
    return {
      id: bank.id,
      account_type: accountType,
      account_id: bank.account_number,
      account_name: bank.beneficiary_name,
      bank_name: bank.bank,
      branch_name: bank.branch,
    };
  }

  if (accountType === 'CARD PAYMENT') {
    const rows = await query(
      `SELECT id, bank_account_number, beneficiary_name, bank, branch
       FROM user_card_payment_accounts
       WHERE id = ?
       LIMIT 1`,
      [accountId],
    );
    const card = rows[0];
    if (!card) throw validationError('Selected card payment account was not found.');
    return {
      id: card.id,
      account_type: accountType,
      account_id: card.bank_account_number,
      account_name: card.beneficiary_name,
      bank_name: card.bank,
      branch_name: card.branch,
    };
  }

  const tableMap = {
    XM: { table: 'user_xm_accounts', column: 'xm_account_id' },
    SKRILL: { table: 'user_skrill_accounts', column: 'skrill_email' },
    NETELLER: { table: 'user_neteller_accounts', column: 'neteller_email' },
    'PERFECT MONEY': { table: 'user_perfect_money_accounts', column: 'pm_account_id' },
    CRYPTO: { table: 'user_crypto_accounts', column: 'crypto_account_id' },
  };

  const config = tableMap[accountType];
  if (!config) throw validationError('Invalid receiving account type.');

  const rows = await query(`SELECT id, ${config.column} AS account_value FROM ${config.table} WHERE id = ? LIMIT 1`, [
    accountId,
  ]);
  const account = rows[0];
  if (!account) throw validationError('Selected receiving account was not found.');

  return {
    id: account.id,
    account_type: accountType,
    account_id: account.account_value,
  };
}

export async function getWithdrawalBootstrap(userId) {
  const accountHolder = await findAccountHolderByUserId(userId);
  if (!accountHolder) {
    throw validationError('Account holder not found.', 404);
  }
  if (isAccountBanned(accountHolder)) {
    throw validationError('Your account has been banned. Please contact support.', 403);
  }

  const verificationComplete = !needsVerification(accountHolder);
  const [cashoutMethods, recentAmounts, pendingCounts] = await Promise.all([
    loadCashoutMethods(),
    loadRecentCashoutAmounts(userId),
    getOpenWithdrawalCountsByMethod(userId),
  ]);

  return {
    verification_complete: verificationComplete,
    account_holder: {
      account_number: accountHolder.account_number,
      first_name: accountHolder.first_name,
      last_name: accountHolder.last_name,
    },
    cashout_methods: attachPendingCounts(cashoutMethods, pendingCounts),
    recent_amounts: recentAmounts,
  };
}

export async function getWithdrawalMethodDetails(
  userId,
  { cashoutMethodId, cashoutAmount, cashoutAmountCurrency },
) {
  await assertWithdrawalAccess(userId);

  const methodId = Number(cashoutMethodId);
  if (!Number.isInteger(methodId) || methodId <= 0) {
    throw validationError('Cash-out method is required.');
  }

  const cashoutMethod = await getCashoutMethodById(methodId);
  if (!cashoutMethod) {
    throw validationError('Selected cash-out method is not available.');
  }

  await assertWithdrawalMethodPendingLimit(userId, methodId, cashoutMethod.name);

  const [paymentOptions, withdrawalRates, priorityRate] = await Promise.all([
    loadSupportedReceivingOptions(methodId, cashoutMethod.name),
    loadWithdrawalRatesForMethod(methodId),
    loadPriorityWithdrawalRate(methodId),
  ]);

  if (!priorityRate) {
    throw validationError('No withdrawal rate is configured for this cash-out method.');
  }

  const amount = Number(cashoutAmount);
  const currency = String(cashoutAmountCurrency || cashoutMethod.currency || 'USD').trim() || 'USD';

  return {
    cashout_method: cashoutMethod,
    cashout_amount: Number.isFinite(amount) ? amount : null,
    cashout_amount_currency: currency,
    payment_options: paymentOptions,
    withdrawal_rates: withdrawalRates,
    priority_rate: priorityRate,
    initial_receiving_amount:
      Number.isFinite(amount) && priorityRate.rate
        ? Math.round((amount * priorityRate.rate + Number.EPSILON) * 100) / 100
        : null,
    initial_receiving_currency: priorityRate.paymentOptionCurrency,
  };
}

export async function createUserWithdrawal(userId, payload) {
  const accountHolder = await assertWithdrawalAccess(userId);

  const receivingPaymentOptionId = Number(
    payload.receiving_payment_option_id ?? payload.receiving_payment_option,
  );
  const cashoutAmount = Number(payload.cashout_amount);
  const receivingAmount = Number(payload.receiving_amount ?? payload.receiving_payment_amount);
  const cashoutMethodId = Number(payload.cashout_method_id);
  const paymentOptionRate = Number(
    payload.receiving_payment_option_rate ?? payload.payment_option_rate,
  );
  const paymentOptionRateId = Number(
    payload.receiving_payment_option_rate_id ?? payload.payment_option_rate_id,
  );
  const cashoutAccountId = String(payload.cashout_account_id || '').trim();
  const cashoutAmountCurrency = String(payload.cashout_amount_currency || 'USD').trim();
  const receivingAmountCurrency = String(
    payload.receiving_amount_currency ?? payload.receiving_payment_amount_currency ?? '',
  ).trim();

  if (!Number.isInteger(receivingPaymentOptionId) || receivingPaymentOptionId <= 0) {
    throw validationError('Receiving payment option is required.');
  }
  if (!cashoutAmountCurrency) throw validationError('Cash-out amount currency is required.');
  if (!Number.isFinite(cashoutAmount) || cashoutAmount <= 0) {
    throw validationError('Cash-out amount must be greater than zero.');
  }
  if (!receivingAmountCurrency) {
    throw validationError('Receiving payment amount currency is required.');
  }
  if (!Number.isFinite(receivingAmount) || receivingAmount <= 0) {
    throw validationError('Receiving payment amount must be greater than zero.');
  }
  if (!Number.isInteger(cashoutMethodId) || cashoutMethodId <= 0) {
    throw validationError('Cash-out method is required.');
  }
  if (!Number.isFinite(paymentOptionRate) || paymentOptionRate <= 0) {
    throw validationError('Receiving payment option rate is required.');
  }
  if (!Number.isInteger(paymentOptionRateId) || paymentOptionRateId <= 0) {
    throw validationError('Receiving payment option rate id is required.');
  }

  const cashoutMethod = await getCashoutMethodById(cashoutMethodId);
  if (!cashoutMethod) {
    throw validationError('Selected cash-out method is not available.');
  }

  await assertWithdrawalMethodPendingLimit(userId, cashoutMethodId, cashoutMethod.name);

  const accountError = validateCashoutAccountId(cashoutMethod.name, cashoutAccountId);
  if (accountError) throw validationError(accountError);

  if (cashoutAmount < cashoutMethod.minLimit || cashoutAmount > cashoutMethod.maxLimit) {
    throw validationError(
      `Cash-out amount must be between USD ${cashoutMethod.minLimit} and USD ${cashoutMethod.maxLimit}.`,
    );
  }

  const transactionId = generateTransactionId(userId);
  const now = nowSqlDateTime();

  const result = await query(
    `INSERT INTO withdrawals (
      user_id, transaction_id, receiving_payment_option_id,
      cashout_amount_currency, cashout_amount,
      receiving_amount_currency, receiving_amount,
      applied_payment_option_rate, applied_payment_option_rate_id,
      cashout_method_id, cashout_account_id,
      transaction_status, message, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending', 'Check your wallet', ?, ?)`,
    [
      userId,
      transactionId,
      receivingPaymentOptionId,
      cashoutAmountCurrency,
      cashoutAmount,
      receivingAmountCurrency,
      receivingAmount,
      paymentOptionRate,
      paymentOptionRateId,
      cashoutMethodId,
      cashoutAccountId,
      now,
      now,
    ],
  );

  bumpAdminNavCounts();

  return {
    id: result.insertId,
    transaction_id: transactionId,
    account_holder: {
      account_number: accountHolder.account_number,
      first_name: accountHolder.first_name,
      last_name: accountHolder.last_name,
    },
  };
}

async function getUserWithdrawalById(userId, withdrawalId) {
  const id = Number(withdrawalId);
  if (!Number.isInteger(id) || id <= 0) {
    throw validationError('Withdrawal id is required.');
  }

  const rows = await query(
    `SELECT w.*, po.payment_option_name, cm.cashout_method_name, cm.tnc, cm.cashout_method_logo
     FROM withdrawals w
     LEFT JOIN payment_options po ON po.id = w.receiving_payment_option_id
     LEFT JOIN cashout_methods cm ON cm.id = w.cashout_method_id
     WHERE w.id = ? AND w.user_id = ?
     LIMIT 1`,
    [id, userId],
  );
  return rows[0] ?? null;
}

export async function getWithdrawalPaymentProofContext(userId, withdrawalId) {
  await assertWithdrawalAccess(userId);
  const withdrawal = await getUserWithdrawalById(userId, withdrawalId);
  if (!withdrawal) {
    throw validationError('Withdrawal not found.', 404);
  }
  if (withdrawal.cashout_payment_proof) {
    throw validationError('Payment proof has already been submitted for this withdrawal.');
  }

  const [paymentAccounts, receivingAccounts] = await Promise.all([
    loadCashoutMethodPaymentAccounts(withdrawal.cashout_method_name),
    loadUserReceivingAccounts(userId, withdrawal.payment_option_name),
  ]);

  return {
    withdrawal: {
      id: withdrawal.id,
      transaction_id: withdrawal.transaction_id,
      receiving_amount: Number(withdrawal.receiving_amount),
      receiving_amount_currency: withdrawal.receiving_amount_currency,
      cashout_amount: Number(withdrawal.cashout_amount),
      cashout_amount_currency: withdrawal.cashout_amount_currency,
      cashout_method_id: withdrawal.cashout_method_id,
      cashout_method_name: withdrawal.cashout_method_name,
      cashout_method_logo_url: resolveWalletLogoPublicUrl(withdrawal.cashout_method_logo),
      payment_option_name: withdrawal.payment_option_name,
      cashout_account_id: withdrawal.cashout_account_id,
    },
    payment_account_type: paymentAccounts.type,
    payment_accounts: paymentAccounts.accounts,
    receiving_accounts: receivingAccounts,
    terms: withdrawal.tnc || '',
  };
}

export async function saveWithdrawalPaymentProof(userId, withdrawalId, file, payload = {}) {
  await assertWithdrawalAccess(userId);
  const withdrawal = await getUserWithdrawalById(userId, withdrawalId);
  if (!withdrawal) {
    throw validationError('Withdrawal not found.', 404);
  }
  if (withdrawal.cashout_payment_proof) {
    throw validationError('Payment proof has already been submitted for this withdrawal.');
  }

  await assertWithdrawalMethodPendingLimit(
    userId,
    withdrawal.cashout_method_id,
    withdrawal.cashout_method_name,
  );

  const selectedAccountType =
    payload.selected_account_type ?? payload.selectedAccountType ?? null;
  const selectedAccountId =
    payload.selected_account_id ?? payload.selectedAccountId ?? null;

  if (!selectedAccountType || !selectedAccountId) {
    return {
      error: true,
      message: 'Please select a payment option.',
    };
  }

  if (!file) {
    return {
      error: true,
      message: 'Payment proof photo should be less than 2Mb. Kindly reupload.',
    };
  }

  const accountDetailsLog = await buildAccountDetailsLog(selectedAccountType, selectedAccountId);
  const filename = await storeWithdrawalProof(file);

  await query(
    `UPDATE withdrawals
     SET cashout_payment_proof = ?,
         selected_account_type = ?,
         withdrawal_account_id = ?,
         account_details_log = ?,
         updated_at = ?
     WHERE id = ? AND user_id = ?`,
    [
      filename,
      selectedAccountType,
      Number(selectedAccountId),
      JSON.stringify(accountDetailsLog),
      nowSqlDateTime(),
      withdrawal.id,
      userId,
    ],
  );

  const updatedWithdrawal = { ...withdrawal, cashout_payment_proof: filename };
  try {
    await autoAssignWithdrawal(updatedWithdrawal);
  } catch (error) {
    console.error('[withdrawal:auto-assign]', error.message);
  }

  bumpAdminNavCounts();

  return {
    error: false,
    message: 'Withdrawal request has been submitted successfully.',
  };
}

function resolveFilterDates(filterTemplate, fromDate, toDate) {
  return resolveFilterDateRange(filterTemplate, fromDate, toDate);
}

function formatWithdrawalDateTime(value) {
  return formatDateTimeParts(value);
}

function parseAccountDetailsLog(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function formatReceivingAccount(row) {
  const details = parseAccountDetailsLog(row.account_details_log);
  if (details) {
    if (row.selected_account_type === 'BANK TRANSFER' || details.account_type === 'BANK TRANSFER') {
      return [details.bank_name, details.account_id, details.account_name].filter(Boolean).join(' — ');
    }
    return details.account_id || details.account_name || row.cashout_account_id || '—';
  }
  return row.cashout_account_id || '—';
}

function mapUserWithdrawalTransaction(row) {
  const created = formatWithdrawalDateTime(row.created_at);
  const cashoutAmount = Number(row.cashout_amount);
  const receivingAmount = Number(row.receiving_amount);

  return {
    id: row.transaction_id,
    withdrawalId: row.id,
    type: 'Cash-out',
    method: row.cashout_method_name || '—',
    amount: `${row.cashout_amount_currency || 'USD'} ${Number.isFinite(cashoutAmount) ? cashoutAmount.toFixed(2) : '0.00'}`,
    receivingAmount: `${row.receiving_amount_currency || '—'} ${Number.isFinite(receivingAmount) ? receivingAmount.toFixed(2) : '0.00'}`,
    fee: `${row.cashout_amount_currency || 'USD'} 0.00`,
    netAmount: `${row.cashout_amount_currency || 'USD'} ${Number.isFinite(cashoutAmount) ? cashoutAmount.toFixed(2) : '0.00'}`,
    currency: row.cashout_amount_currency || 'USD',
    date: created.date,
    time: created.time,
    createdAt: created.iso,
    status: row.transaction_status || 'Pending',
    account: formatReceivingAccount(row),
    paymentOption: row.payment_option_name || '—',
    reference: row.transaction_id,
    note: row.message || '',
    rejectedReason:
      row.transaction_status === 'Rejected'
        ? [row.rejected_reason_message, row.rejected_reason].filter(Boolean).join(' — ') || ''
        : '',
  };
}

async function loadCashoutMethodsForFilters() {
  const rows = await query(
    `SELECT id, cashout_method_name
     FROM cashout_methods
     WHERE UPPER(availability) = 'AVAILABLE'
       AND (is_deleted = 0 OR is_deleted IS NULL)
     ORDER BY id ASC`,
  );
  return rows.map((row) => ({ id: row.id, name: row.cashout_method_name }));
}

function parseTransactionStatusFilter(status) {
  const value = String(status || '').trim();
  if (!value || value === 'All Statuses' || value.toLowerCase() === 'all') {
    return null;
  }
  return value;
}

function parseUserWithdrawalListFilters(params = {}) {
  const { fromDate, toDate } = resolveFilterDates(
    params.filter_template ?? params.filterTemplate,
    params.from_date ?? params.fromDate,
    params.to_date ?? params.toDate,
  );
  const cashoutMethodId = params.cashout_method_id ?? params.cashoutMethodId;
  const parsedCashoutMethodId =
    cashoutMethodId != null && String(cashoutMethodId).trim() !== ''
      ? Number(cashoutMethodId)
      : null;
  const status = parseTransactionStatusFilter(params.status ?? params.transaction_status);
  const search = String(params.search ?? params.q ?? '').trim() || null;

  return {
    fromDate,
    toDate,
    cashoutMethodId: Number.isInteger(parsedCashoutMethodId) ? parsedCashoutMethodId : null,
    parsedCashoutMethodId,
    status,
    search,
  };
}

function buildUserWithdrawalListQuery(userId, filters = {}) {
  const { fromDate, toDate, cashoutMethodId, status, search } = filters;
  let sql = `SELECT w.*, po.payment_option_name, cm.cashout_method_name
             FROM withdrawals w
             LEFT JOIN payment_options po ON po.id = w.receiving_payment_option_id
             LEFT JOIN cashout_methods cm ON cm.id = w.cashout_method_id
             WHERE w.user_id = ?
               AND w.cashout_payment_proof IS NOT NULL`;
  const values = [userId];

  if (fromDate) {
    sql += ` AND DATE(w.created_at) >= ?`;
    values.push(fromDate);
  }
  if (toDate) {
    sql += ` AND DATE(w.created_at) <= ?`;
    values.push(toDate);
  }
  if (cashoutMethodId) {
    sql += ` AND w.cashout_method_id = ?`;
    values.push(cashoutMethodId);
  }
  if (status) {
    sql += ` AND w.transaction_status = ?`;
    values.push(status);
  }
  if (search) {
    const term = `%${search}%`;
    sql += ` AND (
      w.transaction_id LIKE ? OR
      cm.cashout_method_name LIKE ? OR
      w.cashout_account_id LIKE ? OR
      po.payment_option_name LIKE ? OR
      w.message LIKE ?
    )`;
    values.push(term, term, term, term, term);
  }

  return { sql, values };
}

export async function listUserWithdrawalTransactions(userId, params = {}) {
  await assertWithdrawalAccess(userId);

  const page = Math.max(1, Number(params.page) || 1);
  const perPage = Math.min(50, Math.max(1, Number(params.per_page) || 10));
  const offset = (page - 1) * perPage;

  const { fromDate, toDate, cashoutMethodId, parsedCashoutMethodId, status, search } =
    parseUserWithdrawalListFilters(params);

  const { sql, values } = buildUserWithdrawalListQuery(userId, {
    fromDate,
    toDate,
    cashoutMethodId,
    status,
    search,
  });

  const countRows = await query(
    `SELECT COUNT(*) AS total FROM (${sql}) AS withdrawal_list`,
    values,
  );
  const total = Number(countRows[0]?.total) || 0;

  const rows = await query(
    `${sql} ORDER BY w.id DESC LIMIT ? OFFSET ?`,
    [...values, perPage, offset],
  );

  const cashoutMethods = await loadCashoutMethodsForFilters();

  return {
    transactions: rows.map(mapUserWithdrawalTransaction),
    pagination: {
      page,
      per_page: perPage,
      total,
      total_pages: Math.max(1, Math.ceil(total / perPage)),
    },
    filters: {
      from_date: fromDate,
      to_date: toDate,
      cashout_method_id: parsedCashoutMethodId,
      filter_template: params.filter_template ?? params.filterTemplate ?? null,
      status,
      search,
    },
    cashout_methods: cashoutMethods,
  };
}

export async function getUserWithdrawalTransaction(userId, transactionId) {
  await assertWithdrawalAccess(userId);
  const txId = String(transactionId || '').trim();
  if (!txId) throw validationError('Transaction id is required.');

  const rows = await query(
    `SELECT w.*, po.payment_option_name, cm.cashout_method_name
     FROM withdrawals w
     LEFT JOIN payment_options po ON po.id = w.receiving_payment_option_id
     LEFT JOIN cashout_methods cm ON cm.id = w.cashout_method_id
     WHERE w.user_id = ? AND w.transaction_id = ?
     LIMIT 1`,
    [userId, txId],
  );

  const row = rows[0];
  if (!row) throw validationError('Transaction not found.', 404);
  return mapUserWithdrawalTransaction(row);
}

function csvEscape(value) {
  const text = value == null ? '' : String(value);
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export async function exportUserWithdrawalTransactions(userId, params = {}) {
  await assertWithdrawalAccess(userId);

  const { fromDate, toDate, cashoutMethodId, status, search } =
    parseUserWithdrawalListFilters(params);
  const { sql, values } = buildUserWithdrawalListQuery(userId, {
    fromDate,
    toDate,
    cashoutMethodId,
    status,
    search,
  });
  const rows = await query(`${sql} ORDER BY w.id DESC`, values);

  const headings = [
    'id',
    'user_id',
    'transaction_id',
    'receiving_payment_option_id',
    'cashout_amount_currency',
    'receiving_amount_currency',
    'cashout_amount',
    'receiving_amount',
    'applied_payment_option_rate',
    'applied_payment_option_rate_id',
    'cashout_payment_proof',
    'cashout_method_id',
    'cashout_account_id',
    'transaction_status',
    'message',
    'created_at',
    'updated_at',
  ];

  const lines = [headings.join(',')];
  for (const row of rows) {
    lines.push(headings.map((key) => csvEscape(row[key])).join(','));
  }

  return {
    filename: 'withdrawal-transactions.csv',
    content: `\uFEFF${lines.join('\n')}`,
    mimeType: 'text/csv; charset=utf-8',
  };
}

export async function listUserWithdrawalTransactionsForPrint(userId, params = {}) {
  await assertWithdrawalAccess(userId);

  const { fromDate, toDate, cashoutMethodId, status, search } =
    parseUserWithdrawalListFilters(params);
  const { sql, values } = buildUserWithdrawalListQuery(userId, {
    fromDate,
    toDate,
    cashoutMethodId,
    status,
    search,
  });

  const rows = await query(`${sql} ORDER BY w.id DESC`, values);
  return rows.map(mapUserWithdrawalTransaction);
}
