import { closeDatabase, connectDatabase } from '../src/config/database.js';
import { backfillTransactionAdmins } from '../src/services/backfillTransactionAdmins.service.js';

async function main() {
  await connectDatabase();
  const summary = await backfillTransactionAdmins();
  console.log('Backfilled missing completer / rejector IDs:');
  for (const [key, value] of Object.entries(summary)) {
    console.log(`  ${key}: ${value}`);
  }
}

main()
  .catch((error) => {
    console.error('[backfill] failed:', error.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDatabase();
  });
