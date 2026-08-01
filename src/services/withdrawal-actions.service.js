import { query } from '../config/database.js';
import { LARAVEL_USER_MODEL } from '../constants/adminRoles.js';
import { sendEmailAndSms, queueSmsMessage } from './notification.service.js';
import {
  withdrawalApprovedEmailHtml,
  withdrawalRejectedEmailHtml,
} from './mail.templates.js';

function validationError(message, status = 422) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function isAdmin(roles = []) {
  return roles.includes('super-admin') || roles.includes('sub-admin');
}

function getShiftDateString(date = new Date()) {
  const d = new Date(date);
  if (d.getHours() === 0 && d.getMinutes() < 10) {
    d.setDate(d.getDate() - 1);
  }
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

async function getActiveShiftForDate() {
  const shiftDate = getShiftDateString();
  const rows = await query(
    `SELECT active_shift FROM shift_history WHERE shift_date = ? LIMIT 1`,
    [shiftDate],
  );
  if (rows[0]?.active_shift) return rows[0].active_shift;

  const previousDate = new Date(`${shiftDate}T12:00:00`);
  previousDate.setDate(previousDate.getDate() - 1);
  const prevRows = await query(
    `SELECT active_shift FROM shift_history WHERE shift_date = ? LIMIT 1`,
    [getShiftDateString(previousDate)],
  );
  const previousShift = prevRows[0]?.active_shift || 'B';
  const activeShift = previousShift === 'A' ? 'B' : 'A';

  try {
    await query(
      `INSERT INTO shift_history (shift_date, active_shift, created_at, updated_at)
       VALUES (?, ?, NOW(), NOW())`,
      [shiftDate, activeShift],
    );
  } catch {
    const again = await query(
      `SELECT active_shift FROM shift_history WHERE shift_date = ? LIMIT 1`,
      [shiftDate],
    );
    if (again[0]?.active_shift) return again[0].active_shift;
  }

  return activeShift;
}

function roleDisplayName(roles) {
  if (roles.includes('sub-admin')) return 'Sub Admin';
  if (roles.includes('deposit-executive')) return 'Deposit Executive';
  if (roles.includes('withdrawal-executive')) return 'Withdrawal Executive';
  return 'Executive';
}

async function getUserRoles(userId) {
  const rows = await query(
    `SELECT r.name
     FROM roles r
     INNER JOIN model_has_roles mhr ON mhr.role_id = r.id
     WHERE mhr.model_id = ? AND mhr.model_type = ?`,
    [userId, LARAVEL_USER_MODEL],
  );
  return rows.map((row) => row.name);
}

async function getPendingWithdrawalCount(userId, roles) {
  if (roles.includes('sub-admin')) {
    const rows = await query(
      `SELECT
         (SELECT COUNT(*) FROM deposits
          WHERE assigned_to = ? AND transaction_status = 'Pending' AND payment_proof IS NOT NULL)
         +
         (SELECT COUNT(*) FROM withdrawals
          WHERE assigned_to = ? AND transaction_status = 'Pending' AND cashout_payment_proof IS NOT NULL)
         AS total`,
      [userId, userId],
    );
    return Number(rows[0]?.total) || 0;
  }

  const rows = await query(
    `SELECT COUNT(*) AS total
     FROM withdrawals
     WHERE assigned_to = ?
       AND transaction_status = 'Pending'
       AND cashout_payment_proof IS NOT NULL`,
    [userId],
  );
  return Number(rows[0]?.total) || 0;
}

export async function getExecutivesForWithdrawalAssignment() {
  const activeShift = await getActiveShiftForDate();
  const users = await query(
    `SELECT DISTINCT u.id, u.name, u.email, u.is_online, u.shift, u.shift_start_time, u.shift_end_time
     FROM users u
     INNER JOIN model_has_roles mhr ON mhr.model_id = u.id AND mhr.model_type = ?
     INNER JOIN roles r ON r.id = mhr.role_id
     WHERE r.name IN ('withdrawal-executive', 'sub-admin')
     ORDER BY u.name ASC`,
    [LARAVEL_USER_MODEL],
  );

  const executives = [];
  for (const user of users) {
    const roles = await getUserRoles(user.id);
    const pendingCount = await getPendingWithdrawalCount(user.id, roles);
    executives.push({
      id: user.id,
      name: user.name,
      email: user.email,
      role: roleDisplayName(roles),
      shift: user.shift,
      is_online: Boolean(user.is_online),
      is_in_active_shift: user.shift === activeShift,
      is_in_shift_time: true,
      pending_count: pendingCount,
      shift_time_label:
        user.shift === 'A' || user.shift === 'B' ? '0:10 AM – 0:10 AM (next day)' : '',
      sort_key: [
        user.shift !== activeShift,
        !user.is_online,
        pendingCount,
        user.id,
      ],
    });
  }

  executives.sort((a, b) => {
    for (let i = 0; i < a.sort_key.length; i += 1) {
      if (a.sort_key[i] !== b.sort_key[i]) {
        return a.sort_key[i] < b.sort_key[i] ? -1 : 1;
      }
    }
    return 0;
  });

  return {
    active_shift: activeShift,
    executives: executives.map(({ sort_key: _sort, ...rest }) => rest),
  };
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
  await query(`UPDATE withdrawals SET assigned_to = ? WHERE id IN (${placeholders})`, [
    execId,
    ...ids,
  ]);

  return {
    error: false,
    message: execId ? 'Withdrawals assigned successfully' : 'Withdrawals unassigned successfully',
    assigned_count: ids.length,
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

async function sendDetailedWithdrawalSms(adminUserId, mobile, message, smsType) {
  if (!mobile) return;
  await queueSmsMessage({
    message,
    msisdn: mobile,
    userId: adminUserId,
    smsType,
  });
}

export async function updateWithdrawalStatus(
  auth,
  { withdrawalId, transactionId, status, rejectedReason, rejectedReasonMessage },
) {
  const normalizedStatus = String(status || '').trim();
  if (!['Pending', 'Completed', 'Rejected'].includes(normalizedStatus)) {
    throw validationError('Invalid withdrawal status.');
  }

  const withdrawal = await findWithdrawalRecord(withdrawalId, transactionId);
  if (!withdrawal) {
    throw validationError('Withdrawal not found.', 404);
  }

  const ctx = await loadWithdrawalContext(withdrawal);
  const adminId = auth?.userId;
  const accountHolder = ctx.accountHolder;

  if (normalizedStatus === 'Pending') {
    await query(
      `UPDATE withdrawals
       SET transaction_status = 'Pending',
           pending_date = NOW(),
           pendings_by_admin = ?,
           message = 'Your transaction is in progress',
           updated_at = NOW()
       WHERE id = ?`,
      [adminId, withdrawal.id],
    );
  } else if (normalizedStatus === 'Completed') {
    await query(
      `UPDATE withdrawals
       SET transaction_status = 'Completed',
           approved_date = NOW(),
           approved_by_admin = ?,
           message = 'Please check your wallet',
           updated_at = NOW()
       WHERE id = ?`,
      [adminId, withdrawal.id],
    );

    const smsMessage = buildWithdrawalSmsMessage('Completed', ctx);
    await sendDetailedWithdrawalSms(
      adminId,
      accountHolder?.mobile_number,
      smsMessage,
      'Your transaction has been Completed',
    );

    if (accountHolder?.email) {
      const subject = `TR# ${withdrawal.transaction_id} - Withdrawal Completed`;
      const html = withdrawalApprovedEmailHtml({
        firstName: String(accountHolder.first_name || accountHolder.email || 'Customer').split(' ')[0],
        withdrawal: { ...withdrawal, ...ctx },
      });
      try {
        await sendEmailAndSms({
          email: accountHolder.email,
          subject,
          html,
          text: 'Your withdrawal request has been approved.',
          smsMessage: 'Your withdrawal has been approved.',
          msisdn: accountHolder.mobile_number,
          userId: accountHolder.user_id,
          smsType: 'WITHDRAWAL_APPROVED',
        });
      } catch (error) {
        console.error('[withdrawal-email-approved]', error.message);
      }
    }
  } else if (normalizedStatus === 'Rejected') {
    await query(
      `UPDATE withdrawals
       SET transaction_status = 'Rejected',
           rejected_date = NOW(),
           rejected_by_admin = ?,
           rejected_reason = ?,
           rejected_reason_message = ?,
           message = 'Your transaction has been rejected',
           updated_at = NOW()
       WHERE id = ?`,
      [adminId, rejectedReason || null, rejectedReasonMessage || null, withdrawal.id],
    );

    const smsMessage = buildWithdrawalSmsMessage(
      'Rejected',
      ctx,
      rejectedReason,
      rejectedReasonMessage,
    );
    await sendDetailedWithdrawalSms(
      adminId,
      accountHolder?.mobile_number,
      smsMessage,
      'Withdrawal Rejected',
    );

    if (accountHolder?.email) {
      const subject = `TR# ${withdrawal.transaction_id} - Withdrawal Rejected`;
      const html = withdrawalRejectedEmailHtml({
        firstName: String(accountHolder.first_name || accountHolder.email || 'Customer').split(' ')[0],
        withdrawal: { ...withdrawal, ...ctx },
      });
      try {
        await sendEmailAndSms({
          email: accountHolder.email,
          subject,
          html,
          text: 'Your withdrawal has been rejected.',
          smsMessage: 'Your withdrawal has been rejected.',
          msisdn: accountHolder.mobile_number,
          userId: accountHolder.user_id,
          smsType: 'WITHDRAWAL_REJECTED',
        });
      } catch (error) {
        console.error('[withdrawal-email-rejected]', error.message);
      }
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
    const now = new Date();
    const startOfDay = (date) => {
      const d = new Date(date);
      d.setHours(0, 10, 0, 0);
      return d;
    };
    switch (params.filter) {
      case 'today': {
        const from = startOfDay(now);
        const to = new Date(from);
        to.setDate(to.getDate() + 1);
        sql += ' AND w.updated_at >= ? AND w.updated_at < ?';
        values.push(from, to);
        break;
      }
      case 'yesterday': {
        const from = startOfDay(now);
        from.setDate(from.getDate() - 1);
        const to = startOfDay(now);
        sql += ' AND w.updated_at >= ? AND w.updated_at < ?';
        values.push(from, to);
        break;
      }
      case 'last7days':
        sql += ' AND w.updated_at >= ?';
        values.push(new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000));
        break;
      case 'lastmonth':
        sql += ' AND w.updated_at >= ?';
        values.push(new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000));
        break;
      default:
        break;
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
