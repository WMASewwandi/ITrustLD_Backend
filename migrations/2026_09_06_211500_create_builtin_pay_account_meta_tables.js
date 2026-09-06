export const id = '2026_09_06_211500_create_builtin_pay_account_meta_tables';
export const description =
  'Overlay tables for built-in pay-account display names and extra fields (does not alter original account tables)';

export async function up({ createTableIfMissing }) {
  await createTableIfMissing('pay_account_builtin_meta', {
    mysql: `
      CREATE TABLE pay_account_builtin_meta (
        account_type VARCHAR(32) NOT NULL PRIMARY KEY,
        display_name VARCHAR(120) NOT NULL,
        created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `,
    sqlite: `
      CREATE TABLE pay_account_builtin_meta (
        account_type TEXT NOT NULL PRIMARY KEY,
        display_name TEXT NOT NULL,
        created_at TEXT,
        updated_at TEXT
      )
    `,
  });

  await createTableIfMissing('pay_account_builtin_fields', {
    mysql: `
      CREATE TABLE pay_account_builtin_fields (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        account_type VARCHAR(32) NOT NULL,
        label VARCHAR(120) NOT NULL,
        field_key VARCHAR(80) NOT NULL,
        field_type VARCHAR(20) NOT NULL DEFAULT 'text',
        is_required TINYINT(1) NOT NULL DEFAULT 0,
        sort_order INT NOT NULL DEFAULT 0,
        is_deleted TINYINT(1) NOT NULL DEFAULT 0,
        created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        KEY pay_account_builtin_fields_type_index (account_type, is_deleted, sort_order)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `,
    sqlite: `
      CREATE TABLE pay_account_builtin_fields (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_type TEXT NOT NULL,
        label TEXT NOT NULL,
        field_key TEXT NOT NULL,
        field_type TEXT NOT NULL DEFAULT 'text',
        is_required INTEGER NOT NULL DEFAULT 0,
        sort_order INTEGER NOT NULL DEFAULT 0,
        is_deleted INTEGER NOT NULL DEFAULT 0,
        created_at TEXT,
        updated_at TEXT
      )
    `,
  });

  await createTableIfMissing('pay_account_builtin_values', {
    mysql: `
      CREATE TABLE pay_account_builtin_values (
        account_type VARCHAR(32) NOT NULL,
        account_id BIGINT UNSIGNED NOT NULL,
        field_values TEXT NULL,
        created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (account_type, account_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `,
    sqlite: `
      CREATE TABLE pay_account_builtin_values (
        account_type TEXT NOT NULL,
        account_id INTEGER NOT NULL,
        field_values TEXT,
        created_at TEXT,
        updated_at TEXT,
        PRIMARY KEY (account_type, account_id)
      )
    `,
  });
}
