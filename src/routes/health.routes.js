import { Router } from 'express';
import { getDbDriver, query } from '../config/database.js';

export const healthRouter = Router();

healthRouter.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'itrustld-backend',
  });
});

healthRouter.get('/health/db', async (_req, res, next) => {
  try {
    const driver = getDbDriver();
    const countSql =
      driver === 'sqlite'
        ? 'SELECT COUNT(*) AS count FROM users'
        : 'SELECT COUNT(*) AS count FROM users';

    const rows = await query(countSql);
    const count = Number(rows[0]?.count ?? 0);

    res.json({
      status: 'ok',
      database: {
        driver,
        usersTableReachable: true,
        userCount: count,
      },
    });
  } catch (error) {
    next(error);
  }
});
