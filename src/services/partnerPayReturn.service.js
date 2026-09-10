import { query } from '../config/database.js';
import { nowSqlDateTime } from '../utils/slTime.js';
import { partnerCheckoutMeta } from '../utils/partnerPayToken.js';

function buildPartnerReturnUrl(returnUrl, { type, referenceId, status, amount, currency }) {
  if (!returnUrl) return '';
  try {
    const next = new URL(returnUrl);
    if (type) next.searchParams.set('type', type);
    if (referenceId) next.searchParams.set('reference_id', referenceId);
    if (status) next.searchParams.set('status', status);
    if (amount != null) next.searchParams.set('amount', String(amount));
    if (currency) next.searchParams.set('currency', currency);
    return next.toString();
  } catch {
    return returnUrl;
  }
}

export async function savePartnerReturnFromCheckout({ userId, type, transactionId, gatewayToken, methodId }) {
  const meta = partnerCheckoutMeta(gatewayToken, type, methodId);
  const returnUrl = meta.returnUrl;
  if (!meta.ok || !returnUrl || !transactionId) return;

  try {
    await query(
      `INSERT INTO partner_pay_returns (user_id, type, transaction_id, return_url, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [userId, type, transactionId, returnUrl, nowSqlDateTime()],
    );
  } catch {
    // Unique txn or missing table — do not fail the deposit/withdrawal.
  }
}

async function loadCompletedTxn(type, transactionId) {
  if (type === 'withdrawal') {
    const rows = await query(
      `SELECT transaction_id, transaction_status, cashout_amount, cashout_amount_currency
       FROM withdrawals
       WHERE transaction_id = ?
       LIMIT 1`,
      [transactionId],
    );
    const row = rows[0];
    if (!row || String(row.transaction_status) !== 'Completed') return null;
    return {
      type: 'withdrawal',
      referenceId: row.transaction_id,
      status: 'Completed',
      amount: Number(row.cashout_amount).toFixed(2),
      currency: row.cashout_amount_currency,
    };
  }

  const rows = await query(
    `SELECT transaction_id, transaction_status, deposit_amount, deposit_amount_currency
     FROM deposits
     WHERE transaction_id = ?
     LIMIT 1`,
    [transactionId],
  );
  const row = rows[0];
  if (!row || String(row.transaction_status) !== 'Completed') return null;
  return {
    type: 'deposit',
    referenceId: row.transaction_id,
    status: 'Completed',
    amount: Number(row.deposit_amount).toFixed(2),
    currency: row.deposit_amount_currency,
  };
}

export async function takeCompletedPartnerReturn(userId) {
  let pending = [];
  try {
    pending = await query(
      `SELECT id, type, transaction_id, return_url
       FROM partner_pay_returns
       WHERE user_id = ?
         AND redirected_at IS NULL
       ORDER BY id ASC`,
      [userId],
    );
  } catch {
    return { redirect_url: null };
  }

  for (const row of pending) {
    const details = await loadCompletedTxn(row.type, row.transaction_id);
    if (!details) continue;

    const now = nowSqlDateTime();
    const result = await query(
      `UPDATE partner_pay_returns
       SET redirected_at = ?
       WHERE id = ?
         AND redirected_at IS NULL`,
      [now, row.id],
    );
    const changed = Number(result?.affectedRows ?? result?.changes ?? 0);
    if (!changed) continue;

    return {
      redirect_url: buildPartnerReturnUrl(row.return_url, details),
    };
  }

  return { redirect_url: null };
}
