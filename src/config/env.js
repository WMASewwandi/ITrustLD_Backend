import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');

dotenv.config({ path: path.join(projectRoot, '.env') });
dotenv.config({ path: path.join(projectRoot, '../ITrustLD_Existing/.env'), override: false });

function parseCorsOrigins(value) {
  const defaults =
    'http://localhost:3000,http://127.0.0.1:3000,http://localhost:3001,http://127.0.0.1:3001';
  return (value || defaults)
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT) || 4000,
  db: {
    connection: (process.env.DB_CONNECTION || 'mysql').toLowerCase(),
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT) || 3306,
    database: process.env.DB_DATABASE || 'itrustld',
    username: process.env.DB_USERNAME || 'root',
    password: process.env.DB_PASSWORD || '',
  },
  corsAllowedOrigins: parseCorsOrigins(process.env.CORS_ALLOWED_ORIGINS),
  jwtSecret: process.env.JWT_SECRET || 'change-me-in-production',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '12h',
  userAppUrl: (process.env.USER_APP_URL || 'http://localhost:3000').replace(/\/$/, ''),
  mail: {
    host: process.env.MAIL_HOST || '127.0.0.1',
    port: Number(process.env.MAIL_PORT) || 587,
    secure: process.env.MAIL_ENCRYPTION === 'ssl',
    requireTls: process.env.MAIL_ENCRYPTION === 'tls',
    user: process.env.MAIL_USERNAME && process.env.MAIL_USERNAME !== 'null' ? process.env.MAIL_USERNAME : undefined,
    pass: process.env.MAIL_PASSWORD && process.env.MAIL_PASSWORD !== 'null' ? process.env.MAIL_PASSWORD : undefined,
    fromAddress: (process.env.MAIL_FROM_ADDRESS || 'hello@example.com').replace(/"/g, ''),
    fromName: (process.env.MAIL_FROM_NAME || 'iTrustLD').replace(/"/g, ''),
    logOnly: (process.env.MAIL_MAILER || 'smtp') === 'log',
    forceSmtp: process.env.MAIL_FORCE_SMTP === 'true',
  },
  projectRoot,
  turnstile: {
    secret: process.env.TURNSTILE_SECRET_KEY || process.env.TURNSTILE_SECRET || '',
    siteKey: process.env.TURNSTILE_SITE_KEY || process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || '',
  },
  loyalty: {
    starterWithdrawalTransactionId:
      Number(process.env.STARTER_LOYALTY_WITHDRAWAL_TRANSACTION) || 0,
    starterBonusTransactionId:
      Number(process.env.STARTER_LOYALTY_BONUS_COLLECTION_TRANSACTION) || 0,
    pointDivider: 10000,
    standardUsdPerBlock: 10,
    partnerUsdPerBlock: 35,
    minimumPoints: 10000,
    staffAlertNumbers: ['94766850647', '94767676684', '94767676023', '94752256911', '94763383069'],
  },
  sms: {
    // Prefer DIALOG_SMS_*; also accept Laravel SMS_API_* and legacy SMS_DIALOG_* aliases.
    username:
      process.env.DIALOG_SMS_USERNAME ||
      process.env.SMS_API_USERNAME ||
      process.env.SMS_DIALOG_USERNAME ||
      '',
    password:
      process.env.DIALOG_SMS_PASSWORD ||
      process.env.SMS_API_PASSWORD ||
      process.env.SMS_DIALOG_PASSWORD ||
      '',
    enabled:
      process.env.SMS_ENABLED !== 'false' &&
      Boolean(
        (process.env.DIALOG_SMS_USERNAME ||
          process.env.SMS_API_USERNAME ||
          process.env.SMS_DIALOG_USERNAME) &&
          (process.env.DIALOG_SMS_PASSWORD ||
            process.env.SMS_API_PASSWORD ||
            process.env.SMS_DIALOG_PASSWORD),
      ),
  },
  /** Sri Lanka wall-clock for shifts, business days, and display (mirrors Laravel app.shift_timezone). */
  shiftTimezone:
    process.env.APP_TIMEZONE || process.env.SHIFT_TIMEZONE || 'Asia/Colombo',
};
