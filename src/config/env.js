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

const isProduction = (process.env.NODE_ENV || 'development') === 'production';
const mailer = process.env.MAIL_MAILER || (isProduction ? 'smtp' : '');
const mailUser =
  process.env.MAIL_USERNAME && process.env.MAIL_USERNAME !== 'null'
    ? process.env.MAIL_USERNAME
    : undefined;
const smsUsername =
  process.env.SMS_API_USERNAME ||
  process.env.DIALOG_SMS_USERNAME ||
  process.env.SMS_DIALOG_USERNAME ||
  '';
const smsPassword =
  process.env.SMS_API_PASSWORD ||
  process.env.DIALOG_SMS_PASSWORD ||
  process.env.SMS_DIALOG_PASSWORD ||
  '';
const smsCredentialsReady = Boolean(smsUsername && smsPassword);

export const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT) || 4000,
  /** Run pending Backend migrations on boot (default true). */
  autoMigrate: process.env.AUTO_MIGRATE !== 'false',
  db: {
    connection: (process.env.DB_CONNECTION || 'mysql').toLowerCase(),
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT) || 3306,
    database: process.env.DB_DATABASE || 'itrustld_live',
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
    user: mailUser,
    pass: process.env.MAIL_PASSWORD && process.env.MAIL_PASSWORD !== 'null' ? process.env.MAIL_PASSWORD : undefined,
    fromAddress: (process.env.MAIL_FROM_ADDRESS || 'hello@example.com').replace(/"/g, ''),
    fromName: (process.env.MAIL_FROM_NAME || 'iTrustLD').replace(/"/g, ''),
    logOnly: mailer === 'log',
    forceSmtp: process.env.MAIL_FORCE_SMTP === 'true',
    // Local only: skip when MAIL_* is commented. Production keeps the previous send path.
    enabled: isProduction
      ? true
      : Boolean(mailer && mailer !== 'log' && process.env.MAIL_HOST && mailUser),
  },
  projectRoot,
  turnstile: {
    secret: process.env.TURNSTILE_SECRET_KEY || process.env.TURNSTILE_SECRET || '',
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
  },
  sms: {
    // Dialog eSMS v2 (esms.dialog.lk). SMS_API_* preferred; DIALOG_SMS_* still accepted.
    username: smsUsername,
    password: smsPassword,
    loginUrl:
      process.env.SMS_API_LOGIN_URL || 'https://esms.dialog.lk/api/v2/user/login',
    sendUrl: process.env.SMS_API_SEND_URL || 'https://esms.dialog.lk/api/v2/sms',
    sourceAddress: process.env.SMS_SOURCE_ADDRESS || 'ITrustLD',
    paymentMethod: process.env.SMS_PAYMENT_METHOD || '0',
    enabled: isProduction
      ? process.env.SMS_ENABLED !== 'false' && smsCredentialsReady
      : process.env.SMS_ENABLED === 'true' && smsCredentialsReady,
    twilioAccountSid: process.env.TWILIO_ACCOUNT_SID || '',
    twilioAuthToken: process.env.TWILIO_AUTH_TOKEN || '',
    twilioFrom: process.env.TWILIO_FROM_NUMBER || process.env.TWILIO_FROM || '',
  },
  /** Sri Lanka wall-clock for shifts, business days, and display (mirrors Laravel app.shift_timezone). */
  shiftTimezone:
    process.env.APP_TIMEZONE || process.env.SHIFT_TIMEZONE || 'Asia/Colombo',
};
