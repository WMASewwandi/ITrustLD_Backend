# iTrustLD deployment (Linux)

Deploy the new stack (`ITrustLD_Backend`, `ITrustLD_Admin`, `ITrustLD_User`) on a Linux server and connect to the **existing Laravel dev database** (same MySQL instance as `ITrustLD_Existing`).

## Architecture

| Service | Default port | Role |
|---------|--------------|------|
| `ITrustLD_User` | 3000 | User portal (Next.js) |
| `ITrustLD_Admin` | 3001 | Admin portal (Next.js) |
| `ITrustLD_Backend` | 4000 | Express API |
| MySQL (existing) | 3306 | Shared with Laravel — **do not duplicate** |

## Prerequisites

- Node.js **20+**
- PM2 (`npm install -g pm2`) or systemd
- nginx (recommended for HTTPS)
- Network access to the existing MySQL server

## Quick start (PM2)

### 1. Clone and install

```bash
cd /var/www/itrustld   # or your install path
git pull

export APP_ROOT="$(pwd)"
bash deploy/scripts/install-deps.sh
```

### 2. Configure environment

Copy templates and edit with your server values:

```bash
cp deploy/env/backend.env.example ITrustLD_Backend/.env
cp deploy/env/admin.env.production.example ITrustLD_Admin/.env.local
cp deploy/env/user.env.production.example ITrustLD_User/.env.local
```

**Database:** copy `DB_HOST`, `DB_PORT`, `DB_DATABASE`, `DB_USERNAME`, `DB_PASSWORD` from the Laravel `.env` on the same server (or remote DB host if applicable).

### 3. Build frontends

```bash
bash deploy/scripts/build-frontends.sh
```

### 4. Start with PM2

```bash
pm2 start deploy/ecosystem.config.cjs --env production
pm2 save
pm2 startup   # follow the printed command for boot persistence
```

### 5. nginx + TLS

Production (HTTPS):

```bash
sudo cp deploy/nginx/itrustld.conf.example /etc/nginx/sites-available/itrustld
sudo nano /etc/nginx/sites-available/itrustld   # set domains + SSL paths
sudo ln -sf /etc/nginx/sites-available/itrustld /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

Dev server (HTTP only, path-based routing): see `deploy/nginx/itrustld-dev.conf.example`.

### 6. Verify

```bash
bash deploy/scripts/health-check.sh
```

Or manually:

```bash
curl -s http://127.0.0.1:4000/api/v1/health/db
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3001/login
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/
```

## Updating a release

```bash
cd /var/www/itrustld
bash deploy/scripts/deploy.sh
```

## Remote MySQL (DB on another host)

If MySQL is not on the same machine as the API:

1. Set `DB_HOST` to the database server IP/hostname in `ITrustLD_Backend/.env`.
2. On the DB server: allow connections (`bind-address`), firewall for port 3306 from the app server only.
3. Grant a user for the app host:

```sql
CREATE USER 'itrustld_api'@'10.0.0.5' IDENTIFIED BY 'strong-password';
GRANT ALL PRIVILEGES ON itrustld.* TO 'itrustld_api'@'10.0.0.5';
FLUSH PRIVILEGES;
```

Test from the app server: `mysql -h <db-host> -u itrustld_api -p itrustld`

## systemd (alternative to PM2)

```bash
sudo cp deploy/systemd/itrustld-api.service.example /etc/systemd/system/itrustld-api.service
sudo cp deploy/systemd/itrustld-admin.service.example /etc/systemd/system/itrustld-admin.service
sudo cp deploy/systemd/itrustld-user.service.example /etc/systemd/system/itrustld-user.service
# Edit User=, WorkingDirectory=, and EnvironmentFile= paths
sudo systemctl daemon-reload
sudo systemctl enable --now itrustld-api itrustld-admin itrustld-user
```

## Shared database notes

- Admin login uses existing `users` table and Spatie roles (same as Laravel).
- On startup, the API may upsert system activities and create some tables with `CREATE TABLE IF NOT EXISTS`.
- Do not run conflicting Laravel migrations without coordinating both stacks.

## File index

| Path | Purpose |
|------|---------|
| `deploy/ecosystem.config.cjs` | PM2 process definitions |
| `deploy/nginx/itrustld.conf.example` | Reverse proxy |
| `deploy/systemd/*.service.example` | systemd units |
| `deploy/env/*.example` | Environment templates |
| `deploy/scripts/*.sh` | Install, build, deploy, health check |
