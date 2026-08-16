import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getDbDriver, query } from '../config/database.js';
import { migrationContext, tableExists } from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

async function ensureMigrationsTable() {
  const exists = await tableExists('schema_migrations');
  if (exists) return;

  const driver = migrationContext().driver;
  if (driver === 'sqlite') {
    await query(`
      CREATE TABLE schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      )
    `);
  } else {
    await query(`
      CREATE TABLE schema_migrations (
        id VARCHAR(191) NOT NULL PRIMARY KEY,
        applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
  }
}

async function listAppliedIds() {
  await ensureMigrationsTable();
  const rows = await query(`SELECT id FROM schema_migrations ORDER BY id ASC`);
  return new Set(rows.map((row) => String(row.id)));
}

async function markApplied(id) {
  if (getDbDriver() === 'sqlite') {
    await query(
      `INSERT INTO schema_migrations (id, applied_at) VALUES (?, datetime('now'))`,
      [id],
    );
    return;
  }
  await query(`INSERT INTO schema_migrations (id, applied_at) VALUES (?, NOW())`, [id]);
}

function listMigrationFiles(migrationsDir) {
  if (!fs.existsSync(migrationsDir)) {
    return [];
  }
  return fs
    .readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.js'))
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Mark all pending migrations as applied without running up().
 * Use on databases that already have the full Laravel-era schema.
 */
export async function stampPendingMigrations({
  migrationsDir = DEFAULT_MIGRATIONS_DIR,
  logger = console,
} = {}) {
  const applied = await listAppliedIds();
  const files = listMigrationFiles(migrationsDir);
  const stamped = [];

  for (const file of files) {
    const migration = await loadMigration(path.join(migrationsDir, file));
    if (applied.has(migration.id)) continue;
    await markApplied(migration.id);
    stamped.push(migration.id);
    logger.info?.(`[migrate] stamped ${migration.id}`);
  }

  if (!stamped.length) {
    logger.info?.('[migrate] nothing to stamp — all migrations already recorded');
  }

  return { stamped };
}

async function loadMigration(filePath) {
  const mod = await import(pathToFileURL(filePath).href);
  const id = String(mod.id || path.basename(filePath, '.js'));
  if (typeof mod.up !== 'function') {
    throw new Error(`Migration ${id} must export an async up(ctx) function.`);
  }
  return {
    id,
    description: String(mod.description || ''),
    up: mod.up,
    filePath,
  };
}

export async function getMigrationStatus(migrationsDir = DEFAULT_MIGRATIONS_DIR) {
  const applied = await listAppliedIds();
  const files = listMigrationFiles(migrationsDir);
  const migrations = [];

  for (const file of files) {
    const loaded = await loadMigration(path.join(migrationsDir, file));
    migrations.push({
      id: loaded.id,
      description: loaded.description,
      file,
      applied: applied.has(loaded.id),
    });
  }

  return migrations;
}

/**
 * Run all pending Backend migrations.
 * Safe on DBs already patched by Laravel or ensure* helpers (migrations are idempotent).
 */
export async function runPendingMigrations({
  migrationsDir = DEFAULT_MIGRATIONS_DIR,
  logger = console,
} = {}) {
  const applied = await listAppliedIds();
  const files = listMigrationFiles(migrationsDir);
  const ctx = migrationContext();
  const ran = [];

  for (const file of files) {
    const migration = await loadMigration(path.join(migrationsDir, file));
    if (applied.has(migration.id)) continue;

    logger.info?.(`[migrate] applying ${migration.id}${migration.description ? ` — ${migration.description}` : ''}`);
    await migration.up(ctx);
    await markApplied(migration.id);
    ran.push(migration.id);
    logger.info?.(`[migrate] applied ${migration.id}`);
  }

  if (!ran.length) {
    logger.info?.('[migrate] no pending migrations');
  }

  return { applied: ran, pendingRemaining: 0 };
}

export { DEFAULT_MIGRATIONS_DIR };
