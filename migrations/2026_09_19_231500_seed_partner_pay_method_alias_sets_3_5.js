import { PARTNER_PAY_METHOD_ALIASES } from '../src/data/partnerPayMethodAliases.js';

export const id = '2026_09_19_231500_seed_partner_pay_method_alias_sets_3_5';
export const description = 'Seed partner-pay method GUID aliases for document sets 3–5 if missing';

export async function up({ query }) {
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
