/**
 * Same migration as Laravel (shared database — do not drop/recreate data):
 *   ITrustLD_Existing/database/migrations/2024_04_25_045449_create_user_bank_accounts_table.php
 *
 * Already applied on the live DB by Laravel. This file keeps the same id in
 * schema_migrations. up() does not alter existing tables/data.
 */
export const id = "2024_04_25_045449_create_user_bank_accounts_table";
export const description = "Laravel: 2024_04_25_045449_create_user_bank_accounts_table";

export async function up() {
  // no-op on shared DB — schema/data already applied by Laravel
}
