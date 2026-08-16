/**
 * Same migration as Laravel (shared database — do not drop/recreate data):
 *   ITrustLD_Existing/database/migrations/2025_04_04_175100_update_withdrawals_with_account.php
 *
 * Already applied on the live DB by Laravel. This file keeps the same id in
 * schema_migrations. up() does not alter existing tables/data.
 */
export const id = "2025_04_04_175100_update_withdrawals_with_account";
export const description = "Laravel: 2025_04_04_175100_update_withdrawals_with_account";

export async function up() {
  // no-op on shared DB — schema/data already applied by Laravel
}
