/**
 * Import Laravel migrations into Backend as the same migration set (1:1 ids).
 *
 * - Does NOT recreate or wipe the database
 * - Writes one JS file per Laravel PHP migration under migrations/
 * - up() is a no-op for history already applied by Laravel on the shared DB
 * - Existing DBs: npm run migrate:baseline (records only — no DDL)
 * - New work: add new YYYY_MM_DD_*.js files with real additive up()
 *
 * Usage (from ITrustLD_Backend):
 *   node scripts/sync-laravel-migrations.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(__dirname, '..');
const laravelMigrationsDir = path.resolve(
  backendRoot,
  '../ITrustLD_Existing/database/migrations',
);
const outDir = path.join(backendRoot, 'migrations');

const KEEP = new Set([
  'README.md',
  '2026_08_16_100000_users_mobile_number.js',
]);

function main() {
  if (!fs.existsSync(laravelMigrationsDir)) {
    throw new Error(`Laravel migrations not found: ${laravelMigrationsDir}`);
  }

  const phpFiles = fs
    .readdirSync(laravelMigrationsDir)
    .filter((name) => name.endsWith('.php'))
    .sort((a, b) => a.localeCompare(b));

  // Remove previously generated Laravel stamps only (keep Backend-owned files).
  for (const name of fs.readdirSync(outDir)) {
    if (!name.endsWith('.js')) continue;
    if (KEEP.has(name)) continue;
    if (name === '2026_08_16_100000_users_mobile_number.js') continue;
    fs.unlinkSync(path.join(outDir, name));
  }

  for (const file of phpFiles) {
    const id = file.replace(/\.php$/i, '');
    const out = path.join(outDir, `${id}.js`);
    const contents = `/**
 * Same migration as Laravel (shared database — do not drop/recreate data):
 *   ITrustLD_Existing/database/migrations/${file}
 *
 * Already applied on the live DB by Laravel. This file keeps the same id in
 * schema_migrations. up() does not alter existing tables/data.
 */
export const id = ${JSON.stringify(id)};
export const description = ${JSON.stringify(`Laravel: ${id}`)};

export async function up() {
  // no-op on shared DB — schema/data already applied by Laravel
}
`;
    fs.writeFileSync(out, contents, 'utf8');
  }

  console.log(
    `[sync] imported ${phpFiles.length} Laravel migrations into migrations/ (same ids, no data changes)`,
  );
}

main();
