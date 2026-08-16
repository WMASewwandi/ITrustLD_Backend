/**
 * Same migration as Laravel (shared database — do not drop/recreate data):
 *   ITrustLD_Existing/database/migrations/2024_08_23_093756_create_loyalty_client_bonus_vouchers_table.php
 *
 * Already applied on the live DB by Laravel. This file keeps the same id in
 * schema_migrations. up() does not alter existing tables/data.
 */
export const id = "2024_08_23_093756_create_loyalty_client_bonus_vouchers_table";
export const description = "Laravel: 2024_08_23_093756_create_loyalty_client_bonus_vouchers_table";

export async function up() {
  // no-op on shared DB — schema/data already applied by Laravel
}
