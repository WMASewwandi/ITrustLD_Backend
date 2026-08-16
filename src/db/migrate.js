import { connectDatabase, closeDatabase } from '../config/database.js';
import {
  getMigrationStatus,
  runPendingMigrations,
  stampPendingMigrations,
} from './migrationRunner.js';

const command = process.argv[2] || 'up';

async function main() {
  await connectDatabase();

  if (command === 'status') {
    const rows = await getMigrationStatus();
    if (!rows.length) {
      console.log('No migration files found in migrations/');
      return;
    }
    for (const row of rows) {
      const mark = row.applied ? 'applied' : 'pending';
      console.log(
        `${mark.padEnd(8)} ${row.id}${row.description ? ` — ${row.description}` : ''}`,
      );
    }
    return;
  }

  if (command === 'up' || command === 'migrate') {
    const result = await runPendingMigrations();
    if (result.applied.length) {
      console.log(`Applied ${result.applied.length} migration(s).`);
    }
    return;
  }

  if (command === 'baseline' || command === 'stamp') {
    const result = await stampPendingMigrations();
    if (result.stamped.length) {
      console.log(
        `Stamped ${result.stamped.length} migration(s) as applied (schema assumed present).`,
      );
    }
    return;
  }

  console.error(`Unknown command: ${command}. Use: up | status | baseline`);
  process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error('[migrate] failed:', error.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDatabase();
  });
