export const id = '2026_09_01_085500_loyalty_management_vip_vvip_configs';
export const description = 'Allow VIP-BONUS and VVIP-BONUS master config identifiers';

const IDENTIFIERS = [
  'POINT-COLLECTION',
  'POINT-COLLECTION-AFFILIATE',
  'BONUS',
  'BONUS-AFFILIATE',
  'SILVER-BONUS',
  'GOLD-BONUS',
  'DIAMOND-BONUS',
  'VIP-BONUS',
  'VVIP-BONUS',
];

export async function up({ query, driver }) {
  if (driver !== 'sqlite') {
    const columns = await query(`SHOW COLUMNS FROM loyalty_management_configs LIKE 'identifier'`);
    const type = String(columns[0]?.Type || '').toLowerCase();
    if (type.startsWith('enum') && (!type.includes('vip-bonus') || !type.includes('vvip-bonus'))) {
      await query(
        `ALTER TABLE loyalty_management_configs
         MODIFY identifier VARCHAR(64) NOT NULL`,
      );
    }
  }

  const existing = await query(`SELECT identifier FROM loyalty_management_configs`);
  const have = new Set(existing.map((row) => String(row.identifier || '').trim()));
  for (const identifier of IDENTIFIERS) {
    if (have.has(identifier)) continue;
    await query(
      `INSERT INTO loyalty_management_configs
        (identifier, is_active, date_activated, date_deactivated, created_at, updated_at)
       VALUES (?, 0, NOW(), NOW(), NOW(), NOW())`,
      [identifier],
    );
  }
}
