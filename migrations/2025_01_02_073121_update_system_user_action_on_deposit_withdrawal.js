/**
 * Same migration as Laravel (shared database — do not drop/recreate data):
 *   ITrustLD_Existing/database/migrations/2025_01_02_073121_update_system_user_action_on_deposit_withdrawal.php
 *
 * Already applied on the live DB by Laravel. This file keeps the same id in
 * schema_migrations. up() does not alter existing tables/data.
 */
export const id = "2025_01_02_073121_update_system_user_action_on_deposit_withdrawal";
export const description = "Laravel: 2025_01_02_073121_update_system_user_action_on_deposit_withdrawal";

export async function up() {
  // no-op on shared DB — schema/data already applied by Laravel
}
