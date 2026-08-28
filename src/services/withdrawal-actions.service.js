import { query } from '../config/database.js';
import { LARAVEL_USER_MODEL } from '../constants/adminRoles.js';
import { sendTemplatedEmailAndSms, sendTemplatedSmsOnly } from './notification.service.js';
import { buildExecutivesForAssignment } from './shiftAssignment.service.js';
import { nowSqlDateTime, parseDateWindow } from '../utils/slTime.js';
import {
  withdrawalApprovedEmailHtml,
  withdrawalRejectedEmailHtml,
} from './mail.templates.js';
import { MESSAGE_TEMPLATE_KEYS } from './messageTemplateKeys.js';
import {
  logSystemUserAction,
  SYSTEM_USER_ACTIONS,
} from './systemUserActionLog.service.js';
import {
  autoAssignWithdrawalAuthorizer,
  refillWithdrawalPendingForExecutive,
} from './withdrawalAssignment.service.js';
import { notifyAssignedSystemUser } from './assignedUserNotify.service.js';
import {
  ensureWithdrawalAuthorizationSchema,
  hasActiveWithdrawalAuthorizers,
  canAuthorizeWithdrawals,
} from './withdrawal.service.js';
import { assertCanUpdateRecordStatus } from './statusUpdateScope.service.js';
import { bumpAdminNavCounts } from './adminNavCountsRevision.service.js';

function validationError(message, status = 422) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function isAdmin(roles = []) {
  return roles.includes('super-admin') || roles.includes('sub-admin');
}

function isWithdrawalExecutiveOnly(roles = []) {
  return roles.includes('withdrawal-executive') && !isAdmin(roles);
}

function assertCanUpdateWithdrawal(auth, withdrawal, nextStatus, makerCheckerEnabled) {
  const roles = auth?.roles || [];
  const permissions = auth?.permissions || [];
  if (isAdmin(roles)) return;

  const canAuthorize = canAuthorizeWithdrawals(permissions);
  const isExec = isWithdrawalExecutiveOnly(roles);
  const isAuthorizerOnly = canAuthorize && !isExec;

  if (isAuthorizerOnly) {
    if (nextStatus === 'Pending Authorization') {
      throw validationError('Authorizer cannot send withdrawals for authorization.', 403);
    }
    if (
      withdrawal.transaction_status !== 'Pending Authorization' &&
      nextStatus !== 'Rejected'
    ) {
      throw validationError('Authorizer can only action withdrawals pending authorization.', 403);
    }
    return;
  }

  if (isExec) {
    if (Number(withdrawal.assigned_to) !== Number(auth.userId)) {
      throw validationError('This withdrawal is not assigned to you.', 403);
    }
    if (
      makerCheckerEnabled &&
      nextStatus === 'Completed' &&
      withdrawal.transaction_status !== 'Pending Authorization'
    ) {
      throw validationError(
        'This withdrawal must be authorized before it can be completed.',
        403,
      );
    }
    if (nextStatus === 'Completed' && withdrawal.transaction_status === 'Pending Authorization') {
      if (!canAuthorize) {
        throw validationError('You do not have permission to authorize withdrawals.', 403);
      }
      return;
    }
    if (nextStatus === 'Pending Authorization' && withdrawal.transaction_status !== 'Pending') {
      throw validationError('Only pending withdrawals can be sent for authorization.', 403);
    }
    return;
  }

  if (nextStatus === 'Completed' && withdrawal.transaction_status === 'Pending Authorization') {
    if (!canAuthorize) {
      throw validationError('You do not have permission to authorize withdrawals.', 403);
    }
  }
}

export async function getExecutivesForWithdrawalAssignment() {
  return buildExecutivesForAssignment('withdrawal-executive');
}

export async function getAuthorizersForWithdrawalAssignment() {
  return buildExecutivesForAssignment('withdrawal-authorizer', { includeSubAdmin: false });
}

export async function assignWithdrawals(auth, { withdrawalIds, executiveId }) {
  if (!isAdmin(auth?.roles || [])) {
    throw validationError('Unauthorized', 403);
  }

  const ids = [...new Set((withdrawalIds || []).map((id) => Number(id)).filter(Boolean))];
  if (!ids.length) {
    throw validationError('At least one withdrawal is required.');
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
  const selectedRows = await query(
    `SELECT id, transaction_status FROM withdrawals WHERE id IN (${placeholders})`,
    ids,
  );
  const statuses = [...new Set(selectedRows.map((row) => row.transaction_status))];
  if (!selectedRows.length) {
    throw validationError('Withdrawal not found.', 404);
  }
  if (statuses.length !== 1) {
    throw validationError('Select withdrawals with the same status to assign.');
  }
  const queueStatus = statuses[0];
  if (queueStatus !== 'Pending' && queueStatus !== 'Pending Authorization') {
    throw validationError('Only pending or pending-authorization withdrawals can be assigned.');
  }

  const assignableIds = selectedRows.map((row) => Number(row.id)).filter(Boolean);
  const expectedRole =
    queueStatus === 'Pending Authorization' ? 'withdrawal-authorizer' : 'withdrawal-executive';

  if (execId != null) {
    const roleRows = await query(
      `SELECT r.name
       FROM model_has_roles mhr
       INNER JOIN roles r ON r.id = mhr.role_id
       WHERE mhr.model_id = ? AND mhr.model_type = ?`,
      [execId, LARAVEL_USER_MODEL],
    );
    const roleNames = roleRows.map((row) => row.name);
    if (
      !roleNames.includes(expectedRole) &&
      !(queueStatus === 'Pending' && roleNames.includes('sub-admin'))
    ) {
      throw validationError(
        queueStatus === 'Pending Authorization'
          ? 'Select a Withdrawal Authorizer.'
          : 'Select a Withdrawal Executive.',
      );
    }
  }

  const assignPlaceholders = assignableIds.map(() => '?').join(', ');
  await query(`UPDATE withdrawals SET assigned_to = ? WHERE id IN (${assignPlaceholders})`, [
    execId,
    ...assignableIds,
  ]);

  if (execId) {
    const count = assignableIds.length;
    await notifyAssignedSystemUser({
      userId: execId,
      message:
        queueStatus === 'Pending Authorization'
          ? `${count} pending authorization request(s) have been assigned to you. Please review. Thanks`
          : `${count} pending withdrawal request(s) have been assigned to you. Please review. Thanks`,
      smsType: 'WITHDRAWAL_PENDING',
    }).catch((error) => {
      console.error('[withdrawal:assigned-sms]', error.message);
    });
  }

  return {
    error: false,
    message: execId ? 'Withdrawals assigned successfully' : 'Withdrawals unassigned successfully',
    assigned_count: assignableIds.length,
  };
}

async function findWithdrawalRecord(withdrawalId, transactionId) {
  if (withdrawalId) {
    const rows = await query(`SELECT * FROM withdrawals WHERE id = ? LIMIT 1`, [withdrawalId]);
    return rows[0] || null;
  }
  if (transactionId) {
    const rows = await query(`SELECT * FROM withdrawals WHERE transaction_id = ? LIMIT 1`, [
      transactionId,
    ]);
    return rows[0] || null;
  }
  return null;
}

async function loadWithdrawalContext(withdrawal) {
  const [accountHolderRows, cashoutRows, receivingRows] = await Promise.all([
    query(`SELECT * FROM account_holders WHERE user_id = ? LIMIT 1`, [withdrawal.user_id]),
    query(`SELECT cashout_method_name FROM cashout_methods WHERE id = ? LIMIT 1`, [
      withdrawal.cashout_method_id,
    ]),
    query(`SELECT payment_option_name FROM payment_options WHERE id = ? LIMIT 1`, [
      withdrawal.receiving_payment_option_id,
    ]),
  ]);

  return {
    withdrawal,
    accountHolder: accountHolderRows[0] || null,
    cashoutMethodName: cashoutRows[0]?.cashout_method_name || '',
    receivingOptionName: receivingRows[0]?.payment_option_name || '',
  };
}

function buildWithdrawalSmsMessage(status, ctx, rejectedReason, rejectedReasonMessage) {
  const { withdrawal, cashoutMethodName } = ctx;
  const base = `${withdrawal.receiving_amount_currency} ${withdrawal.receiving_amount}`;
  const account = withdrawal.cashout_account_id;

  if (status === 'Completed') {
    return `${base} Withdrawal Completed from ${cashoutMethodName} for ${account}. Check Your Bank Account.\n- For more info: +94117 751 751, iTrustLD`;
  }

  const reason = rejectedReasonMessage || rejectedReason || '';
  return `${base} Withdrawal Rejected to ${cashoutMethodName} for ${account}. ${reason}.\n- For more info: +94117 751 751, iTrustLD`;
}

async function notifyWithdrawalStatus(
  accountHolder,
  withdrawal,
  ctx,
  status,
  rejectedReason,
  rejectedReasonMessage,
) {
  if (!accountHolder) return;

  const firstName = String(accountHolder.first_name || accountHolder.email || 'Customer').split(' ')[0];
  const { cashoutMethodName } = ctx;
  const smsMessage = buildWithdrawalSmsMessage(status, ctx, rejectedReason, rejectedReasonMessage);
  const smsType = status === 'Completed' ? 'WITHDRAWAL_APPROVED' : 'WITHDRAWAL_REJECTED';
  const subject =
    status === 'Completed'
      ? `TR# ${withdrawal.transaction_id} - Withdrawal Completed`
      : `TR# ${withdrawal.transaction_id} - Withdrawal Rejected`;
  const html =
    status === 'Completed'
      ? withdrawalApprovedEmailHtml({
          firstName,
          withdrawal: { ...withdrawal, ...ctx },
        })
      : withdrawalRejectedEmailHtml({
          firstName,
          withdrawal: { ...withdrawal, ...ctx },
        });
  const amount = `${withdrawal.receiving_amount_currency} ${withdrawal.receiving_amount}`;
  const reason = rejectedReasonMessage || rejectedReason || '';
  const variables = {
    username: accountHolder.first_name || accountHolder.email || 'Customer',
    first_name: firstName,
    transaction_id: withdrawal.transaction_id,
    amount,
    status,
    platform: cashoutMethodName,
    account: withdrawal.cashout_account_id,
    reason,
  };
  const emailKey =
    status === 'Completed'
      ? MESSAGE_TEMPLATE_KEYS.WITHDRAWAL_COMPLETED_EMAIL
      : MESSAGE_TEMPLATE_KEYS.WITHDRAWAL_REJECTED_EMAIL;
  const smsKey =
    status === 'Completed'
      ? MESSAGE_TEMPLATE_KEYS.WITHDRAWAL_COMPLETED_SMS
      : MESSAGE_TEMPLATE_KEYS.WITHDRAWAL_REJECTED_SMS;

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
              ? 'Your withdrawal request has been approved.'
              : 'Your withdrawal has been rejected.',
          smsMessage,
        },
      });
    } catch (error) {
      console.error(`[withdrawal-email-${status.toLowerCase()}]`, error.message);
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

export async function updateWithdrawalStatus(
  auth,
  { withdrawalId, transactionId, status, rejectedReason, rejectedReasonMessage },
) {
  await ensureWithdrawalAuthorizationSchema();
  const normalizedStatus = String(status || '').trim();
  if (!['Pending', 'Pending Authorization', 'Completed', 'Rejected'].includes(normalizedStatus)) {
    throw validationError('Invalid withdrawal status.');
  }

  const withdrawal = await findWithdrawalRecord(withdrawalId, transactionId);
  if (!withdrawal) {
    throw validationError('Withdrawal not found.', 404);
  }

  const makerCheckerEnabled = await hasActiveWithdrawalAuthorizers();
  assertCanUpdateWithdrawal(auth, withdrawal, normalizedStatus, makerCheckerEnabled);
  await assertCanUpdateRecordStatus(auth?.userId, 'withdrawal', withdrawal.transaction_status);

  const ctx = await loadWithdrawalContext(withdrawal);
  const adminId = auth?.userId;
  const accountHolder = ctx.accountHolder;

  if (normalizedStatus === 'Pending') {
    const now = nowSqlDateTime();
    await query(
      `UPDATE withdrawals
       SET transaction_status = 'Pending',
           pending_date = ?,
           pendings_by_admin = ?,
           message = 'Your transaction is in progress',
           updated_at = ?
       WHERE id = ?`,
      [now, adminId, now, withdrawal.id],
    );
    await logSystemUserAction(adminId, SYSTEM_USER_ACTIONS.WITHDRAWAL_PENDING);
  } else if (normalizedStatus === 'Pending Authorization') {
    const now = nowSqlDateTime();
    await query(
      `UPDATE withdrawals
       SET transaction_status = 'Pending Authorization',
           pending_date = ?,
           pendings_by_admin = ?,
           message = 'Your transaction is awaiting authorization',
           updated_at = ?
       WHERE id = ?`,
      [now, adminId, now, withdrawal.id],
    );
    await logSystemUserAction(adminId, SYSTEM_USER_ACTIONS.WITHDRAWAL_PENDING);
    try {
      await refillWithdrawalPendingForExecutive(withdrawal.assigned_to || adminId);
    } catch (error) {
      console.error('[withdrawal:refill-pending]', error.message);
    }
    try {
      await autoAssignWithdrawalAuthorizer(withdrawal);
    } catch (error) {
      console.error('[withdrawal:assign-authorizer]', error.message);
    }
  } else if (normalizedStatus === 'Completed') {
    const now = nowSqlDateTime();
    await query(
      `UPDATE withdrawals
       SET transaction_status = 'Completed',
           approved_date = ?,
           approved_by_admin = ?,
           message = 'Please check your wallet',
           updated_at = ?
       WHERE id = ?`,
      [now, adminId, now, withdrawal.id],
    );

    await notifyWithdrawalStatus(accountHolder, withdrawal, ctx, 'Completed');
    await logSystemUserAction(adminId, SYSTEM_USER_ACTIONS.WITHDRAWAL_APPROVE);
  } else if (normalizedStatus === 'Rejected') {
    const now = nowSqlDateTime();
    await query(
      `UPDATE withdrawals
       SET transaction_status = 'Rejected',
           rejected_date = ?,
           rejected_by_admin = ?,
           rejected_reason = ?,
           rejected_reason_message = ?,
           message = 'Your transaction has been rejected',
           updated_at = ?
       WHERE id = ?`,
      [now, adminId, rejectedReason || null, rejectedReasonMessage || null, now, withdrawal.id],
    );

    await notifyWithdrawalStatus(
      accountHolder,
      withdrawal,
      ctx,
      'Rejected',
      rejectedReason,
      rejectedReasonMessage,
    );
    await logSystemUserAction(adminId, SYSTEM_USER_ACTIONS.WITHDRAWAL_REJECT);
  }

  if (normalizedStatus === 'Completed' || normalizedStatus === 'Rejected') {
    const refillUserId = withdrawal.assigned_to || adminId;
    try {
      await refillWithdrawalPendingForExecutive(refillUserId);
    } catch (error) {
      console.error('[withdrawal:refill-pending]', error.message);
    }
  }

  bumpAdminNavCounts();

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

export async function exportWithdrawalsForAdmin(auth, params = {}) {
  const status = String(params.status || 'Pending');
  let sql = `SELECT
      w.id,
      w.user_id,
      w.transaction_id,
      w.receiving_payment_option_id,
      w.cashout_amount_currency,
      w.receiving_amount_currency,
      w.cashout_amount,
      w.receiving_amount,
      w.transaction_status,
      w.message,
      w.created_at,
      w.approved_date
    FROM withdrawals w
    WHERE w.cashout_payment_proof IS NOT NULL`;
  const values = [];

  if (status === 'Pending') {
    sql += ` AND w.transaction_status = 'Pending'`;
  } else if (status === 'Completed') {
    sql += ` AND w.transaction_status = 'Completed'`;
  } else if (status === 'Rejected') {
    sql += ` AND w.transaction_status = 'Rejected'`;
  }

  if (params.filter) {
    const { from, to } = parseDateWindow(params.filter, params.fromDate, params.toDate);
    if (from) {
      if (to) {
        sql += ' AND w.updated_at >= ? AND w.updated_at < ?';
        values.push(from, to);
      } else {
        sql += ' AND w.updated_at >= ?';
        values.push(from);
      }
    }
  }

  sql += ' ORDER BY w.id ASC';
  const rows = await query(sql, values);

  const headings =
    status === 'Completed'
      ? [
          'id',
          'user_id',
          'transaction_id',
          'receiving_payment_option_id',
          'cashout_amount_currency',
          'receiving_amount_currency',
          'cashout_amount',
          'receiving_amount',
          'transaction_status',
          'message',
          'created_at',
          'approved_date',
        ]
      : [
          'id',
          'user_id',
          'transaction_id',
          'receiving_payment_option_id',
          'cashout_amount_currency',
          'receiving_amount_currency',
          'cashout_amount',
          'receiving_amount',
          'transaction_status',
          'message',
          'created_at',
        ];

  const filename =
    status === 'Completed'
      ? 'completed_withdrawals.csv'
      : status === 'Rejected'
        ? 'rejected_withdrawals.csv'
        : 'pending_withdrawals.csv';

  return {
    filename,
    contentType: 'text/csv; charset=utf-8',
    body: rowsToCsv(rows, headings),
  };
}
