export const id = '2026_09_09_105700_set_account_holder_29124_address_number';
export const description =
  'One-time: set address_number for account_holders.user_id 29124';

const USER_ID = 29124;
const ADDRESS_NUMBER = 'Boralu Kanda, Bulanawewa, Dewahuwa';

export async function up({ query, tableExists, logger = console } = {}) {
  if (!(await tableExists('account_holders'))) {
    logger.info?.(`[migrate] ${id}: account_holders missing, skipped`);
    return;
  }

  const result = await query(
    `UPDATE account_holders
     SET address_number = ?
     WHERE user_id = ?`,
    [ADDRESS_NUMBER, USER_ID],
  );

  const affected = Number(result?.affectedRows ?? result?.changes ?? 0);
  logger.info?.(`[migrate] ${id}: updated ${affected} row(s)`);
}
