import { query } from '../config/database.js';
import { sendTemplatedEmailAndSms, sendTemplatedSmsOnly } from './notification.service.js';
import { buildExecutivesForAssignment } from './shiftAssignment.service.js';
import { parseDateWindow } from '../utils/slTime.js';
import {
  depositApprovedEmailHtml,
  depositRejectedEmailHtml,
} from './mail.templates.js';
import { MESSAGE_TEMPLATE_KEYS } from './messageTemplateKeys.js';
import { awardDepositPoints, reverseDepositPoints } from './pointEarning.service.js';
import {
  logSystemUserAction,
  SYSTEM_USER_ACTIONS,
} from './systemUserActionLog.service.js';
import { refillDepositPendingForExecutive } from './depositAssignment.service.js';

function validationError(message, status = 422) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function isAdmin(roles = []) {
  return roles.includes('super-admin') || roles.includes('sub-admin');
}

function isDepositExecutiveOnly(roles = []) {
  return roles.includes('deposit-executive') && !isAdmin(roles);
}

function assertCanUpdateDeposit(auth, deposit) {
  if (!isDepositExecutiveOnly(auth?.roles || [])) return;
  if (Number(deposit.assigned_to) !== Number(auth.userId)) {
    throw validationError('This deposit is not assigned to you.', 403);
  }
}

export async function getExecutivesForAssignment() {
  return buildExecutivesForAssignment('deposit-executive');
}

export async function assignDeposits(auth, { depositIds, executiveId }) {
  if (!isAdmin(auth?.roles || [])) {
    throw validationError('Unauthorized', 403);
  }

  const ids = [...new Set((depositIds || []).map((id) => Number(id)).filter(Boolean))];
  if (!ids.length) {
    throw validationError('At least one deposit is required.');
  }

  const execId =
    executiveId == null || executiveId === '' ? null : Number(executiveId);

  if (execId != null) {
    const execRows = await query(`SELECT id FROM users WHERE id = ? LIMIT 1`, [execId]);
    if (!execRows[0]) {
      throw validationError('Executive not found.');
    }
  }

  const placeholders = ids.map(() => '?').join(', ');
  await query(`UPDATE deposits SET assigned_to = ? WHERE id IN (${placeholders})`, [
    execId,
    ...ids,
  ]);

  return {
    error: false,
    message: execId ? 'Deposits assigned successfully' : 'Deposits unassigned successfully',
    assigned_count: ids.length,
  };
}

async function findDepositRecord(depositId, transactionId) {
  if (depositId) {
    const rows = await query(`SELECT * FROM deposits WHERE id = ? LIMIT 1`, [depositId]);
    return rows[0] || null;
  }
  if (transactionId) {
    const rows = await query(`SELECT * FROM deposits WHERE transaction_id = ? LIMIT 1`, [
      transactionId,
    ]);
    return rows[0] || null;
  }
  return null;
}

async function loadDepositContext(deposit) {
  const [accountHolderRows, topupRows, paymentRows] = await Promise.all([
    query(`SELECT * FROM account_holders WHERE user_id = ? LIMIT 1`, [deposit.user_id]),
    query(`SELECT topup_method_name FROM topup_methods WHERE id = ? LIMIT 1`, [
      deposit.topup_method_id,
    ]),
    query(`SELECT payment_option_name FROM payment_options WHERE id = ? LIMIT 1`, [
      deposit.payment_option_id,
    ]),
  ]);

  return {
    deposit,
    accountHolder: accountHolderRows[0] || null,
    topupMethodName: topupRows[0]?.topup_method_name || '',
    paymentOptionName: paymentRows[0]?.payment_option_name || '',
  };
}

function buildDepositSmsMessage(status, ctx, rejectedReason, rejectedReasonMessage) {
  const { deposit, topupMethodName } = ctx;
  const base = `${deposit.payment_amount_currency} ${deposit.payment_amount}`;
  const platform = topupMethodName;
  const account = deposit.topup_account_id;

  if (status === 'Completed') {
    return `${base} Deposit Completed to ${platform} for ${account}. Check Your Wallet.\n- For more info: +94117 751 751, iTrustLD`;
  }

  const reason = rejectedReasonMessage || rejectedReason || '';
  return `${base} Deposit Rejected to ${platform} for ${account}. ${reason}.\n- For more info: +94117 751 751, iTrustLD`;
}

async function notifyDepositStatus(auth, accountHolder, deposit, ctx, status, rejectedReason, rejectedReasonMessage) {
  if (!accountHolder) return;

  const firstName = String(accountHolder.first_name || accountHolder.email || 'Customer').split(' ')[0];
  const { topupMethodName } = ctx;
  const smsMessage = buildDepositSmsMessage(status, ctx, rejectedReason, rejectedReasonMessage);
  const smsType = status === 'Completed' ? 'DEPOSIT_APPROVED' : 'DEPOSIT_REJECTED';
  const subject =
    status === 'Completed'
      ? `TR# ${deposit.transaction_id} - Deposit Completed`
      : `TR# ${deposit.transaction_id} - Deposit Rejected`;
  const html =
    status === 'Completed'
      ? depositApprovedEmailHtml({
          firstName,
          deposit: { ...deposit, ...ctx },
        })
      : depositRejectedEmailHtml({
          firstName,
          deposit: { ...deposit, ...ctx },
        });
  const amount = `${deposit.payment_amount_currency} ${deposit.payment_amount}`;
  const reason = rejectedReasonMessage || rejectedReason || '';
  const variables = {
    username: accountHolder.first_name || accountHolder.email || 'Customer',
    first_name: firstName,
    transaction_id: deposit.transaction_id,
    amount,
    status,
    platform: topupMethodName,
    account: deposit.topup_account_id,
    reason,
  };
  const emailKey =
    status === 'Completed'
      ? MESSAGE_TEMPLATE_KEYS.DEPOSIT_COMPLETED_EMAIL
      : MESSAGE_TEMPLATE_KEYS.DEPOSIT_REJECTED_EMAIL;
  const smsKey =
    status === 'Completed'
      ? MESSAGE_TEMPLATE_KEYS.DEPOSIT_COMPLETED_SMS
      : MESSAGE_TEMPLATE_KEYS.DEPOSIT_REJECTED_SMS;

  if (accountHolder.email) {
    try {
      await sendTemplatedEmailAndSms({
        email: accountHolder.email,
        msisdn: accountHolder.mobile_number,
        userId: accountHolder.user_id,
        smsType,
        emailKey,
        smsKey,
        variables,
        fallback: {
          subject,
          html,
          text:
            status === 'Completed'
              ? 'Your deposit request has been approved.'
              : 'Your deposit has been rejected.',
          smsMessage,
        },
      });
    } catch (error) {
      console.error(`[deposit-email-${status.toLowerCase()}]`, error.message);
    }
    return;
  }

  if (accountHolder.mobile_number) {
    await sendTemplatedSmsOnly({
      msisdn: accountHolder.mobile_number,
      userId: accountHolder.user_id,
      smsType,
      smsKey,
      variables,
      fallback: smsMessage,
    });
  }
}

export async function updateDepositStatus(
  auth,
  { depositId, transactionId, status, rejectedReason, rejectedReasonMessage },
) {
  const normalizedStatus = String(status || '').trim();
  if (!['Pending', 'Completed', 'Rejected'].includes(normalizedStatus)) {
    throw validationError('Invalid deposit status.');
  }

  const deposit = await findDepositRecord(depositId, transactionId);
  if (!deposit) {
    throw validationError('Deposit not found.', 404);
  }

  assertCanUpdateDeposit(auth, deposit);

  const ctx = await loadDepositContext(deposit);
  const adminId = auth?.userId;
  const accountHolder = ctx.accountHolder;

  if (normalizedStatus === 'Pending') {
    await query(
      `UPDATE deposits
       SET transaction_status = 'Pending',
           pending_date = NOW(),
           pendings_by_admin = ?,
           message = 'Your transaction is in progress',
           updated_at = NOW()
       WHERE id = ?`,
      [adminId, deposit.id],
    );
    await logSystemUserAction(adminId, SYSTEM_USER_ACTIONS.DEPOSIT_PENDING);
  } else if (normalizedStatus === 'Completed') {
    await query(
      `UPDATE deposits
       SET transaction_status = 'Completed',
           approved_date = NOW(),
           approved_by_admin = ?,
           message = 'Please check your wallet',
           updated_at = NOW()
       WHERE id = ?`,
      [adminId, deposit.id],
    );

    await notifyDepositStatus(auth, accountHolder, deposit, ctx, 'Completed');
    await awardDepositPoints(deposit, accountHolder);
    await logSystemUserAction(adminId, SYSTEM_USER_ACTIONS.DEPOSIT_APPROVE);
  } else if (normalizedStatus === 'Rejected') {
    await query(
      `UPDATE deposits
       SET transaction_status = 'Rejected',
           rejected_date = NOW(),
           rejected_by_admin = ?,
           rejected_reason = ?,
           rejected_reason_message = ?,
           message = 'Your transaction has been rejected',
           updated_at = NOW()
       WHERE id = ?`,
      [adminId, rejectedReason || null, rejectedReasonMessage || null, deposit.id],
    );

    await notifyDepositStatus(
      auth,
      accountHolder,
      deposit,
      ctx,
      'Rejected',
      rejectedReason,
      rejectedReasonMessage,
    );
    await reverseDepositPoints(deposit);
    await logSystemUserAction(adminId, SYSTEM_USER_ACTIONS.DEPOSIT_REJECT);
  }

  if (normalizedStatus === 'Completed' || normalizedStatus === 'Rejected') {
    const refillUserId = deposit.assigned_to || adminId;
    try {
      await refillDepositPendingForExecutive(refillUserId);
    } catch (error) {
      console.error('[deposit:refill-pending]', error.message);
    }
  }

  return {
    error: false,
    message: 'Successfully updated the transaction status. ',
  };
}

function csvEscape(value) {
  const text = value == null ? '' : String(value);
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function rowsToCsv(rows, headings) {
  const lines = [headings.join(',')];
  for (const row of rows) {
    lines.push(headings.map((key) => csvEscape(row[key])).join(','));
  }
  return `\uFEFF${lines.join('\n')}`;
}

export async function exportDepositsForAdmin(auth, params = {}) {
  const status = String(params.status || 'Pending');
  let sql = `SELECT
      d.id,
      d.user_id,
      d.transaction_id,
      d.payment_option_id,
      d.deposit_amount_currency,
      d.payment_amount_currency,
      d.deposit_amount,
      d.payment_amount,
      d.transaction_status,
      d.message,
      d.created_at,
      d.approved_date
    FROM deposits d
    WHERE 1=1`;
  const values = [];

  if (status === 'Pending') {
    sql += ` AND d.transaction_status = 'Pending'`;
  } else if (status === 'Completed') {
    sql += ` AND d.transaction_status = 'Completed'`;
  } else if (status === 'Rejected') {
    sql += ` AND d.transaction_status = 'Rejected'`;
  }

  if (params.filter) {
    const { from, to } = parseDateWindow(params.filter, params.fromDate, params.toDate);
    if (from) {
      if (to) {
        sql += ' AND d.updated_at >= ? AND d.updated_at < ?';
        values.push(from, to);
      } else {
        sql += ' AND d.updated_at >= ?';
        values.push(from);
      }
    }
  }

  sql += ' ORDER BY d.id ASC';
  const rows = await query(sql, values);

  const headings =
    status === 'Completed'
      ? [
          'id',
          'user_id',
          'transaction_id',
          'payment_option_id',
          'deposit_amount_currency',
          'payment_amount_currency',
          'deposit_amount',
          'payment_amount',
          'transaction_status',
          'message',
          'created_at',
          'approved_date',
        ]
      : [
          'id',
          'user_id',
          'transaction_id',
          'payment_option_id',
          'deposit_amount_currency',
          'payment_amount_currency',
          'deposit_amount',
          'payment_amount',
          'transaction_status',
          'message',
          'created_at',
        ];

  const filename =
    status === 'Completed'
      ? 'completed_deposits.csv'
      : status === 'Rejected'
        ? 'rejected_deposits.csv'
        : 'pending_deposits.csv';

  return {
    filename,
    contentType: 'text/csv; charset=utf-8',
    body: rowsToCsv(rows, headings),
  };
}
