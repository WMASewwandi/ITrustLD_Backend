import { Router } from 'express';
import { authRouter } from './auth.routes.js';
import { verificationRouter } from './verification.routes.js';
import { adminAuthRouter } from './admin/auth.routes.js';
import { adminRolesRouter } from './admin/roles.routes.js';
import { adminSystemUsersRouter } from './admin/system-users.routes.js';
import { adminCustomersRouter } from './admin/customers.routes.js';
import { adminBlogsRouter } from './admin/blogs.routes.js';
import { adminNotificationsRouter } from './admin/notifications.routes.js';
import { healthRouter } from './health.routes.js';
import { userDashboardRouter } from './user/dashboard.routes.js';
import { publicBlogBannersRouter } from './public/blog-banners.routes.js';
import { publicBlogsRouter } from './public/blogs.routes.js';

export const apiRouter = Router();

apiRouter.use(healthRouter);
apiRouter.use('/auth', authRouter);
apiRouter.use('/auth/verification', verificationRouter);
apiRouter.use('/user/dashboard', userDashboardRouter);
apiRouter.use('/public/blog-banners', publicBlogBannersRouter);
apiRouter.use('/public/blogs', publicBlogsRouter);
apiRouter.use('/admin/auth', adminAuthRouter);
apiRouter.use('/admin/roles', adminRolesRouter);
apiRouter.use('/admin/system-users', adminSystemUsersRouter);
apiRouter.use('/admin/customers', adminCustomersRouter);
apiRouter.use('/admin/blogs', adminBlogsRouter);
apiRouter.use('/admin/notifications', adminNotificationsRouter);

apiRouter.get('/', (_req, res) => {
  res.json({
    name: 'iTrustLD API',
    version: '1.0.0',
    docs: 'Add feature routes under /api/v1',
  });
});
