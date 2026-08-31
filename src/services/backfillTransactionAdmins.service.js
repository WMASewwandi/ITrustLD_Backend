import { query } from '../config/database.js';
import { columnExists, tableExists } from '../db/helpers.js';

function emptyId(column) {
  return `(${column} IS NULL OR ${column} = 0)`;
}

function actorSource({ hasAssigned = false } = {}) {
  return hasAssigned
    ? 'COALESCE(NULLIF(assigned_to, 0), NULLIF(pendings_by_admin, 0))'
    : 'NULLIF(pendings_by_admin, 0)';
}

async function runUpdate(sql) {
  const result = await query(sql);
  return Number(result?.affectedRows ?? result?.changes ?? 0) || 0;
}

/**
 * Fill approved_by_admin / rejected_by_admin on historical rows so ADMIN
 * and team-performance handled counts have someone to credit.
 * Never overwrites an ID that is already set.
 */
export async function backfillTransactionAdmins() {
  const summary = {
    withdrawals_completed: 0,
    withdrawals_rejected: 0,
    deposits_completed: 0,
    deposits_rejected: 0,
    loyalty_orders_approved: 0,
    loyalty_orders_rejected: 0,
    loyalty_bonus_approved: 0,
    loyalty_bonus_rejected: 0,
  };

  if (await tableExists('withdrawals')) {
    const source = actorSource({
      hasAssigned: await columnExists('withdrawals', 'assigned_to'),
    });
    summary.withdrawals_completed = await runUpdate(`
      UPDATE withdrawals
      SET approved_by_admin = ${source}
      WHERE transaction_status = 'Completed'
        AND ${emptyId('approved_by_admin')}
        AND ${source} IS NOT NULL
    `);
    summary.withdrawals_rejected = await runUpdate(`
      UPDATE withdrawals
      SET rejected_by_admin = ${source}
      WHERE transaction_status = 'Rejected'
        AND ${emptyId('rejected_by_admin')}
        AND ${source} IS NOT NULL
    `);
  }

  if (await tableExists('deposits')) {
    const source = actorSource({
      hasAssigned: await columnExists('deposits', 'assigned_to'),
    });
    summary.deposits_completed = await runUpdate(`
      UPDATE deposits
      SET approved_by_admin = ${source}
      WHERE transaction_status = 'Completed'
        AND ${emptyId('approved_by_admin')}
        AND ${source} IS NOT NULL
    `);
    summary.deposits_rejected = await runUpdate(`
      UPDATE deposits
      SET rejected_by_admin = ${source}
      WHERE transaction_status = 'Rejected'
        AND ${emptyId('rejected_by_admin')}
        AND ${source} IS NOT NULL
    `);
  }

  if (await tableExists('point_withdrawals')) {
    const source = actorSource();
    summary.loyalty_orders_approved = await runUpdate(`
      UPDATE point_withdrawals
      SET approved_by_admin = ${source}
      WHERE status = 'Approved'
        AND ${emptyId('approved_by_admin')}
        AND ${source} IS NOT NULL
    `);
    summary.loyalty_orders_rejected = await runUpdate(`
      UPDATE point_withdrawals
      SET rejected_by_admin = ${source}
      WHERE status = 'Rejected'
        AND ${emptyId('rejected_by_admin')}
        AND ${source} IS NOT NULL
    `);
  }

  if (await tableExists('loyalty_bonus_collects')) {
    const source = actorSource();
    summary.loyalty_bonus_approved = await runUpdate(`
      UPDATE loyalty_bonus_collects
      SET approved_by_admin = ${source}
      WHERE status = 'Approved'
        AND ${emptyId('approved_by_admin')}
        AND ${source} IS NOT NULL
    `);
    summary.loyalty_bonus_rejected = await runUpdate(`
      UPDATE loyalty_bonus_collects
      SET rejected_by_admin = ${source}
      WHERE status = 'Rejected'
        AND ${emptyId('rejected_by_admin')}
        AND ${source} IS NOT NULL
    `);
  }

  summary.total = Object.values(summary).reduce((sum, value) => sum + (Number(value) || 0), 0);
  return summary;
}
