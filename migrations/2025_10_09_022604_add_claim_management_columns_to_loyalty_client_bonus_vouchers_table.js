/**
 * Same migration as Laravel (shared database — do not drop/recreate data):
 *   ITrustLD_Existing/database/migrations/2025_10_09_022604_add_claim_management_columns_to_loyalty_client_bonus_vouchers_table.php
 *
 * Already applied on the live DB by Laravel. This file keeps the same id in
 * schema_migrations. up() does not alter existing tables/data.
 */
export const id = "2025_10_09_022604_add_claim_management_columns_to_loyalty_client_bonus_vouchers_table";
export const description = "Laravel: 2025_10_09_022604_add_claim_management_columns_to_loyalty_client_bonus_vouchers_table";

export async function up() {
  // no-op on shared DB — schema/data already applied by Laravel
}
