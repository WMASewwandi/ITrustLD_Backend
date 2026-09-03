export const id = '2026_09_03_140000_add_pay_account_link_to_wallet_methods';
export const description =
  'Optional pay-account link on top-up and cash-out wallets (type + id, no FK)';

export async function up({ addColumnIfMissing }) {
  for (const table of ['topup_methods', 'cashout_methods']) {
    await addColumnIfMissing(table, 'pay_account_type', {
      mysql: 'pay_account_type VARCHAR(32) NULL',
      sqlite: 'pay_account_type TEXT NULL',
    });
    await addColumnIfMissing(table, 'pay_account_id', {
      mysql: 'pay_account_id BIGINT NULL',
      sqlite: 'pay_account_id INTEGER NULL',
    });
  }
}
