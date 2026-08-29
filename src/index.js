import { createApp } from './app.js';
import { closeDatabase, connectDatabase } from './config/database.js';
import { env } from './config/env.js';
import { runPendingMigrations } from './db/migrationRunner.js';
import { warmAdminDashboardCache } from './services/adminDashboard.service.js';
import { ensureSystemActivitiesCatalog } from './services/ensureSystemActivities.service.js';
import { seedExistingRejectReasons } from './services/rejectReason.service.js';
import { startShiftRolloverScheduler } from './services/shiftAssignment.service.js';

async function main() {
  await connectDatabase();

  // Backend owns schema going forward — no Laravel `php artisan migrate` required for new features.
  // Set AUTO_MIGRATE=false to skip boot-time migrate (then run `npm run migrate` in deploy).
  if (env.autoMigrate) {
    await runPendingMigrations();
  }

  await ensureSystemActivitiesCatalog();
  await seedExistingRejectReasons();

  // Warm default dashboard before accepting traffic so the first admin load is fast.
  await warmAdminDashboardCache();

  const app = createApp();
  startShiftRolloverScheduler();
  const server = app.listen(env.port, () => {
    console.log(`iTrustLD backend listening on http://localhost:${env.port}`);
    console.log(`Health: http://localhost:${env.port}/api/v1/health`);
  });

  const shutdown = async (signal) => {
    console.log(`\n${signal} received, shutting down...`);
    server.close(async () => {
      await closeDatabase();
      process.exit(0);
    });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
