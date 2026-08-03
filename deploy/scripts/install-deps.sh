#!/usr/bin/env bash
# Install Node dependencies for all iTrustLD apps (no build).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

require_node() {
  if ! command -v node >/dev/null 2>&1; then
    echo "Error: Node.js is required (>= 20). Install Node and retry." >&2
    exit 1
  fi
  local version major
  version="$(node -p "process.versions.node")"
  major="${version%%.*}"
  if [[ "$major" -lt 20 ]]; then
    echo "Error: Node.js $version found; need >= 20." >&2
    exit 1
  fi
  echo "Node.js $version"
}

ensure_build_tools() {
  if [[ "$(uname -s)" != "Linux" ]]; then
    return 0
  fi
  if command -v g++ >/dev/null 2>&1 && command -v python3 >/dev/null 2>&1; then
    return 0
  fi
  echo "==> Installing build tools for native Node modules (better-sqlite3)..."
  if command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update -qq
    sudo apt-get install -y build-essential python3
  else
    echo "Warning: install build-essential and python3 if npm install fails on better-sqlite3." >&2
  fi
}

install_app() {
  local dir="$1"
  echo "==> npm install in $dir"
  cd "$ROOT/$dir"
  if [[ -f package-lock.json ]]; then
    npm ci
  else
    npm install
  fi
}

require_node
ensure_build_tools
install_app ITrustLD_Backend
install_app ITrustLD_Admin
install_app ITrustLD_User

echo "Dependencies installed."
