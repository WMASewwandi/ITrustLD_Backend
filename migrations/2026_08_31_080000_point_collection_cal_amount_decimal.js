export const id = '2026_08_31_080000_point_collection_cal_amount_decimal';
export const description = 'Allow decimal cal_amount on loyalty point collections';

export async function up({ query, driver, tableExists }) {
  if (driver === 'sqlite') return;
  if (!(await tableExists('loyalty_management_point_collections'))) return;
  await query(
    `ALTER TABLE loyalty_management_point_collections
     MODIFY cal_amount DECIMAL(12,4) NOT NULL`,
  );
}
