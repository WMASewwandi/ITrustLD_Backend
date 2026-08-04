import { createApp } from './app.js';
import { closeDatabase, connectDatabase } from './config/database.js';
import { env } from './config/env.js';
import { warmAdminDashboardCache } from './services/adminDashboard.service.js';
import { ensureSystemActivitiesCatalog } from './services/ensureSystemActivities.service.js';
import { startShiftRolloverScheduler } from './services/shiftAssignment.service.js';

async function main() {
  await connectDatabase();
  await ensureSystemActivitiesCatalog();

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
