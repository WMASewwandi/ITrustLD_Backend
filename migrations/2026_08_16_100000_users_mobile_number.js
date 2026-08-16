export const id = '2026_08_16_100000_users_mobile_number';
export const description =
  'Backend-only: add users.mobile_number for system users (not in Laravel history)';

export async function up({ addColumnIfMissing }) {
  await addColumnIfMissing('users', 'mobile_number', {
    mysql: 'mobile_number VARCHAR(32) NULL',
    sqlite: 'mobile_number TEXT NULL',
  });
}
