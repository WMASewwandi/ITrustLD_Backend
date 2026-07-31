import { Router } from 'express';
import { adminAuthRouter } from './admin/auth.routes.js';
import { adminRolesRouter } from './admin/roles.routes.js';
import { adminSystemUsersRouter } from './admin/system-users.routes.js';
import { healthRouter } from './health.routes.js';

export const apiRouter = Router();

apiRouter.use(healthRouter);
apiRouter.use('/admin/auth', adminAuthRouter);
apiRouter.use('/admin/roles', adminRolesRouter);
apiRouter.use('/admin/system-users', adminSystemUsersRouter);

apiRouter.get('/', (_req, res) => {
  res.json({
    name: 'iTrustLD API',
    version: '1.0.0',
    docs: 'Add feature routes under /api/v1',
  });
});
