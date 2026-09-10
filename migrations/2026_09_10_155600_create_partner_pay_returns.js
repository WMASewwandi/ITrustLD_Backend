export const id = '2026_09_10_155600_create_partner_pay_returns';
export const description =
  'One-time partner return URLs after admin completes a partner-pay deposit/withdrawal';

export async function up({ createTableIfMissing }) {
  await createTableIfMissing('partner_pay_returns', {
    mysql: `
      CREATE TABLE partner_pay_returns (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        user_id BIGINT UNSIGNED NOT NULL,
        type VARCHAR(20) NOT NULL,
        transaction_id VARCHAR(40) NOT NULL,
        return_url VARCHAR(500) NOT NULL,
        redirected_at DATETIME NULL,
        created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY partner_pay_returns_txn_unique (type, transaction_id),
        KEY partner_pay_returns_user_pending (user_id, redirected_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `,
    sqlite: `
      CREATE TABLE partner_pay_returns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        type TEXT NOT NULL,
        transaction_id TEXT NOT NULL,
        return_url TEXT NOT NULL,
        redirected_at TEXT,
        created_at TEXT,
        UNIQUE (type, transaction_id)
      )
    `,
  });
}
