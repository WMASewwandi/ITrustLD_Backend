import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');

dotenv.config({ path: path.join(projectRoot, '.env') });

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
  projectRoot,
};
