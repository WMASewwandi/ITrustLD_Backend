# iTrustLD Backend

Express.js API for the split iTrustLD stack. It uses the **same database** as `ITrustLD_Existing` (Laravel). Configure `DB_*` in `.env` to match the Laravel app's `.env`.

**Linux deployment:** this repo includes `deploy/`. After cloning Backend + Admin + User into one folder, run:

```bash
cd /var/www/your-stack-folder
bash ITrustLD_Backend/deploy/scripts/setup-stack.sh
```

Then follow `deploy/SETUP_ON_SERVER.md` and `deploy/README.md`.

## Prerequisites

- Node.js 20+
- MySQL/MariaDB (typical production) or SQLite (Laravel local default)

## Setup

```bash
cd ITrustLD_Backend
cp .env.example .env
# Edit .env — copy DB_HOST, DB_DATABASE, DB_USERNAME, DB_PASSWORD from ITrustLD_Existing/.env
npm install
npm run dev
```

API base URL: `http://localhost:4000/api/v1`

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1` | API info |
| GET | `/api/v1/health` | Process health |
| GET | `/api/v1/health/db` | DB connectivity + `users` table check |
| POST | `/api/v1/admin/auth/login` | Admin login (`email`, `password`) |
| GET | `/api/v1/admin/auth/me` | Current admin user (Bearer token) |
| POST | `/api/v1/admin/auth/logout` | Sign out, sets `is_online` false |

## CORS

`CORS_ALLOWED_ORIGINS` mirrors Laravel (`ITrustLD_Existing/.env.example`): user app on port 3000, admin on 3001.

## Project layout

```
src/
  config/       env + database (MySQL / SQLite)
  middleware/   errors
  routes/       API routes (extend here)
  app.js        Express app
  index.js      Server entry
```

Add new route modules under `src/routes/` and mount them from `src/routes/index.js`.
