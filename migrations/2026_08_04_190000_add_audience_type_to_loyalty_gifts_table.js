/**
 * Same migration as Laravel (shared database — do not drop/recreate data):
 *   ITrustLD_Existing/database/migrations/2026_08_04_190000_add_audience_type_to_loyalty_gifts_table.php
 *
 * Already applied on the live DB by Laravel. This file keeps the same id in
 * schema_migrations. up() does not alter existing tables/data.
 */
export const id = "2026_08_04_190000_add_audience_type_to_loyalty_gifts_table";
export const description = "Laravel: 2026_08_04_190000_add_audience_type_to_loyalty_gifts_table";

export async function up() {
  // no-op on shared DB — schema/data already applied by Laravel
}
