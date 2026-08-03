#!/usr/bin/env bash
# Build Next.js frontends for production.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

build_app() {
  local dir="$1"
  echo "==> npm run build in $dir"
  cd "$ROOT/$dir"
  if [[ ! -f .env.local ]]; then
    echo "Warning: $dir/.env.local missing — using defaults or existing .env" >&2
  fi
  NODE_ENV=production npm run build
}

if [[ ! -d "$ROOT/ITrustLD_Admin/node_modules" ]]; then
  echo "node_modules missing — run deploy/scripts/install-deps.sh first" >&2
  exit 1
fi

build_app ITrustLD_Admin
build_app ITrustLD_User

echo "Frontend builds complete."
