import { PARTNER_PAY_METHOD_ALIASES } from '../src/data/partnerPayMethodAliases.js';

export const id = '2026_09_19_230000_create_partner_pay_method_aliases';
export const description =
  'Alternate partner-pay method GUIDs for document sets 2–5 (existing method GUIDs stay unchanged)';

export async function up({ createTableIfMissing, query }) {
  await createTableIfMissing('partner_pay_method_aliases', {
    mysql: `
      CREATE TABLE partner_pay_method_aliases (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        pack VARCHAR(64) NOT NULL,
        method_name VARCHAR(120) NOT NULL,
        kind VARCHAR(20) NOT NULL,
        guid CHAR(36) NOT NULL,
        method_id BIGINT UNSIGNED NOT NULL,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY partner_pay_method_aliases_guid_unique (guid),
        KEY partner_pay_method_aliases_pack (pack),
        KEY partner_pay_method_aliases_method (kind, method_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `,
    sqlite: `
      CREATE TABLE partner_pay_method_aliases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pack TEXT NOT NULL,
        method_name TEXT NOT NULL,
        kind TEXT NOT NULL,
        guid TEXT NOT NULL,
        method_id INTEGER NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT,
        UNIQUE (guid)
      )
    `,
  });

  for (const alias of PARTNER_PAY_METHOD_ALIASES) {
    const table = alias.kind === 'deposit' ? 'topup_methods' : 'cashout_methods';
    const methods = await query(`SELECT id FROM ${table} WHERE guid = ? LIMIT 1`, [alias.sourceGuid]);
    if (!methods[0]) continue;

    const existing = await query(`SELECT id FROM partner_pay_method_aliases WHERE guid = ? LIMIT 1`, [
      alias.guid,
    ]);
    if (existing[0]) continue;

    await query(
      `INSERT INTO partner_pay_method_aliases (pack, method_name, kind, guid, method_id, is_active)
       VALUES (?, ?, ?, ?, ?, 1)`,
      [alias.pack, alias.method, alias.kind, alias.guid, methods[0].id],
    );
  }
}
