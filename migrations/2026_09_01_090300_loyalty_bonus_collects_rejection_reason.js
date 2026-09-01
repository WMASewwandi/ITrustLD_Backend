export const id = '2026_09_01_090300_loyalty_bonus_collects_rejection_reason';
export const description = 'Store rejection reason on loyalty bonus claims';

export async function up({ addColumnIfMissing }) {
  await addColumnIfMissing('loyalty_bonus_collects', 'rejection_reason', {
    mysql: 'rejection_reason TEXT NULL',
    sqlite: 'rejection_reason TEXT',
  });
}
