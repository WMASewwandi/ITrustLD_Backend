# Backend database migrations

Same shared MySQL database as Laravel. Migrations here use the **same ids** as
`ITrustLD_Existing/database/migrations`. They do **not** drop or recreate tables.

| Files | Role |
|-------|------|
| `0001_…` / `2024_…` / `2026_…` (from Laravel) | Same migration history; `up()` is no-op (already on DB) |
| `2026_08_16_100000_users_mobile_number.js` | Backend-only additive change |
| New `YYYY_MM_DD_HHMMSS_*.js` | Forward, additive DDL only |

Refresh Laravel history stamps (safe — does not touch data):

```bash
npm run migrate:sync-laravel
```

## Commands

```bash
npm run migrate              # Apply pending (additive only)
npm run migrate:status
npm run migrate:baseline     # Record Laravel history as applied — no DDL, no data loss
```

### Shared / production DB (already migrated by Laravel)

```bash
npm run migrate:baseline
```

This only inserts rows into `schema_migrations`. It does not alter tables or data.

### New schema changes

Add a new JS migration that only **adds** columns/tables (use `addColumnIfMissing` /
`createTableIfMissing`). Never drop tables in place of “rewriting” history.
