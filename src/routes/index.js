import { Router } from 'express';
import { authRouter } from './auth.routes.js';
import { verificationRouter } from './verification.routes.js';
import { adminAuthRouter } from './admin/auth.routes.js';
import { adminRolesRouter } from './admin/roles.routes.js';
import { adminSystemUsersRouter } from './admin/system-users.routes.js';
import { adminCustomersRouter } from './admin/customers.routes.js';
import { adminBlogsRouter } from './admin/blogs.routes.js';
import { adminWalletsRouter } from './admin/wallets.routes.js';
import { adminPayAccountsRouter } from './admin/payAccounts.routes.js';
import { adminPaymentMethodsRouter } from './admin/paymentMethods.routes.js';
import { adminCurrencyTypesRouter } from './admin/currencyTypes.routes.js';
import { adminUserCountDisplayRouter } from './admin/userCountDisplay.routes.js';
import { adminRatesRouter } from './admin/rates.routes.js';
import { adminDepositsRouter } from './admin/deposits.routes.js';
import { adminWithdrawalsRouter } from './admin/withdrawals.routes.js';
import { adminScammersRouter } from './admin/scammers.routes.js';
import { adminNotificationsRouter } from './admin/notifications.routes.js';
import { publicCommunityStatsRouter } from './public/community-stats.routes.js';
import { healthRouter } from './health.routes.js';
import { userDashboardRouter } from './user/dashboard.routes.js';
import { userDepositsRouter } from './user/deposits.routes.js';
import { userWithdrawalsRouter } from './user/withdrawals.routes.js';
import { userPaymentAccountsRouter } from './user/payment-accounts.routes.js';
import { userProfileRouter } from './user/profile.routes.js';
import { publicBlogBannersRouter } from './public/blog-banners.routes.js';
import { publicBlogsRouter } from './public/blogs.routes.js';
import { publicWalletLogosRouter } from './public/wallet-logos.routes.js';

export const apiRouter = Router();

apiRouter.use(healthRouter);
apiRouter.use('/auth', authRouter);
apiRouter.use('/auth/verification', verificationRouter);
apiRouter.use('/user/dashboard', userDashboardRouter);
apiRouter.use('/user/deposits', userDepositsRouter);
apiRouter.use('/user/withdrawals', userWithdrawalsRouter);
apiRouter.use('/user/payment-accounts', userPaymentAccountsRouter);
apiRouter.use('/user/profile', userProfileRouter);
apiRouter.use('/public/blog-banners', publicBlogBannersRouter);
apiRouter.use('/public/blogs', publicBlogsRouter);
apiRouter.use('/public/wallet-logos', publicWalletLogosRouter);
apiRouter.use('/public/community-stats', publicCommunityStatsRouter);
apiRouter.use('/admin/auth', adminAuthRouter);
apiRouter.use('/admin/roles', adminRolesRouter);
apiRouter.use('/admin/system-users', adminSystemUsersRouter);
apiRouter.use('/admin/customers', adminCustomersRouter);
apiRouter.use('/admin/blogs', adminBlogsRouter);
apiRouter.use('/admin/wallets', adminWalletsRouter);
apiRouter.use('/admin/pay-accounts', adminPayAccountsRouter);
apiRouter.use('/admin/payment-methods', adminPaymentMethodsRouter);
apiRouter.use('/admin/currency-types', adminCurrencyTypesRouter);
apiRouter.use('/admin/user-count-display', adminUserCountDisplayRouter);
apiRouter.use('/admin/rates', adminRatesRouter);
apiRouter.use('/admin/deposits', adminDepositsRouter);
apiRouter.use('/admin/withdrawals', adminWithdrawalsRouter);
apiRouter.use('/admin/scammers', adminScammersRouter);
apiRouter.use('/admin/notifications', adminNotificationsRouter);

apiRouter.get('/', (_req, res) => {
  res.json({
    name: 'iTrustLD API',
    version: '1.0.0',
    docs: 'Add feature routes under /api/v1',
  });
});
