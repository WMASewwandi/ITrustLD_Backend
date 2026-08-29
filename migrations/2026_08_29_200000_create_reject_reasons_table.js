/**
 * Master reject-reason lists. Empty by design — admins add reasons per category.
 */
export const id = "2026_08_29_200000_create_reject_reasons_table";
export const description = "Create reject_reasons table for Master > Reject Reasons";

export async function up(ctx) {
  await ctx.createTableIfMissing("reject_reasons", {
    mysql: `
      CREATE TABLE reject_reasons (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        category VARCHAR(50) NOT NULL,
        message VARCHAR(500) NOT NULL,
        sort_order INT NOT NULL DEFAULT 0,
        created_by BIGINT UNSIGNED NULL,
        created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY reject_reasons_category_message_unique (category, message),
        KEY reject_reasons_category_sort_index (category, sort_order)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `,
    sqlite: `
      CREATE TABLE reject_reasons (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL,
        message TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_by INTEGER,
        created_at TEXT,
        updated_at TEXT,
        UNIQUE (category, message)
      )
    `,
  });
}
