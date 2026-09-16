export const id = '2026_09_16_160000_create_partner_pay_integrations';
export const description =
  'Per-partner API credentials for the partner-pay gateway (replaces the single env key/secret)';

export async function up({ createTableIfMissing }) {
  await createTableIfMissing('partner_pay_integrations', {
    mysql: `
      CREATE TABLE partner_pay_integrations (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(120) NOT NULL,
        api_key VARCHAR(191) NOT NULL,
        api_secret VARCHAR(191) NOT NULL,
        allowed_return_urls TEXT NULL,
        webhook_url VARCHAR(500) NULL,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY partner_pay_integrations_api_key_unique (api_key),
        KEY partner_pay_integrations_active (is_active)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `,
    sqlite: `
      CREATE TABLE partner_pay_integrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        api_key TEXT NOT NULL,
        api_secret TEXT NOT NULL,
        allowed_return_urls TEXT,
        webhook_url TEXT,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT,
        updated_at TEXT,
        UNIQUE (api_key)
      )
    `,
  });
}
