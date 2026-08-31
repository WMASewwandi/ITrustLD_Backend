export const id = '2026_08_31_233500_point_withdrawals_rejection_reason';
export const description = 'Store rejection reason on loyalty point withdrawals';

export async function up({ addColumnIfMissing }) {
  await addColumnIfMissing('point_withdrawals', 'rejection_reason', {
    mysql: 'rejection_reason TEXT NULL',
    sqlite: 'rejection_reason TEXT',
  });
}
