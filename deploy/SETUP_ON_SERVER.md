# Server setup (3 separate repos)

After cloning **Backend**, **Admin**, and **User** into the same parent folder:

```text
/var/www/itrustld-new-stack/
├── ITrustLD_Backend/   ← includes this deploy/ folder
├── ITrustLD_Admin/
└── ITrustLD_User/
```

## 1. Copy deploy to parent (one time)

From the parent folder (not inside Backend):

```bash
cd /var/www/itrustld-new-stack
bash ITrustLD_Backend/deploy/scripts/setup-stack.sh
```

Or manually:

```bash
cd /var/www/itrustld-new-stack
cp -r ITrustLD_Backend/deploy .
```

## 2. Configure env

```bash
cp deploy/env/backend.env.example ITrustLD_Backend/.env
cp deploy/env/admin.env.production.example ITrustLD_Admin/.env.local
cp deploy/env/user.env.production.example ITrustLD_User/.env.local
# Edit all three — DB_* from Laravel dev, URLs with this server's public IP
```

## 3. Install, build, start

```bash
bash deploy/scripts/install-deps.sh
bash deploy/scripts/build-frontends.sh
export APP_ROOT=/var/www/itrustld-new-stack
pm2 start deploy/ecosystem.config.cjs --env production
pm2 save
```

See `deploy/README.md` for nginx, DB security groups, and updates.
