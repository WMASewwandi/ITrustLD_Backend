import crypto from 'node:crypto';

export const id = '2026_09_11_053000_add_guid_to_wallet_methods';
export const description = 'GUID on top-up and cash-out methods for partner API (numeric id stays internal)';

export async function up({ addColumnIfMissing, query }) {
  for (const table of ['topup_methods', 'cashout_methods']) {
    await addColumnIfMissing(table, 'guid', {
      mysql: 'guid CHAR(36) NULL',
      sqlite: 'guid TEXT NULL',
    });
    const rows = await query(`SELECT id FROM ${table} WHERE guid IS NULL OR guid = ''`);
    for (const row of rows) {
      await query(`UPDATE ${table} SET guid = ? WHERE id = ?`, [crypto.randomUUID(), row.id]);
    }
  }
}
