/**
 * PM2 ecosystem file for iTrustLD stack.
 *
 * Usage (from repo root):
 *   pm2 start deploy/ecosystem.config.cjs --env production
 *   pm2 reload deploy/ecosystem.config.cjs --env production
 *
 * Set APP_ROOT if the repo is not the current working directory:
 *   APP_ROOT=/var/www/itrustld pm2 start deploy/ecosystem.config.cjs --env production
 */
const path = require('node:path');

const root = process.env.APP_ROOT || path.resolve(__dirname, '..');

module.exports = {
  apps: [
    {
      name: 'itrustld-api',
      cwd: path.join(root, 'ITrustLD_Backend'),
      script: 'src/index.js',
      interpreter: 'node',
      instances: 2,
      exec_mode: 'cluster',
      wait_ready: true,
      listen_timeout: 20000,
      kill_timeout: 8000,
      autorestart: true,
      max_memory_restart: '512M',
      time: true,
      env: {
        NODE_ENV: 'development',
      },
      env_production: {
        NODE_ENV: 'production',
      },
    },
    {
      name: 'itrustld-user',
      cwd: path.join(root, 'ITrustLD_User'),
      script: 'node_modules/next/dist/bin/next',
      args: 'start -p 3000 -H 0.0.0.0',
      interpreter: 'node',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '768M',
      time: true,
      env: {
        NODE_ENV: 'development',
        PORT: '3000',
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: '3000',
      },
    },
    {
      name: 'itrustld-admin',
      cwd: path.join(root, 'ITrustLD_Admin'),
      script: 'node_modules/next/dist/bin/next',
      args: 'start -p 3001 -H 0.0.0.0',
      interpreter: 'node',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '768M',
      time: true,
      env: {
        NODE_ENV: 'development',
        PORT: '3001',
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: '3001',
      },
    },
  ],
};
