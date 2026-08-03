#!/usr/bin/env bash
# Pull latest code, install, build, and reload PM2 processes.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export APP_ROOT="$ROOT"
cd "$ROOT"

echo "Deploy root: $ROOT"

if [[ -d .git ]]; then
  echo "==> git pull"
  git pull --ff-only
fi

bash "$ROOT/deploy/scripts/install-deps.sh"
bash "$ROOT/deploy/scripts/build-frontends.sh"

if command -v pm2 >/dev/null 2>&1; then
  echo "==> pm2 reload"
  if pm2 describe itrustld-api >/dev/null 2>&1; then
    pm2 reload "$ROOT/deploy/ecosystem.config.cjs" --env production
  else
    pm2 start "$ROOT/deploy/ecosystem.config.cjs" --env production
  fi
  pm2 save
else
  echo "PM2 not found. Restart services manually or install PM2." >&2
  exit 1
fi

bash "$ROOT/deploy/scripts/health-check.sh"

echo "Deploy complete."
