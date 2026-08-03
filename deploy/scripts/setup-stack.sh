#!/usr/bin/env bash
# Copy deploy/ from ITrustLD_Backend to the stack parent folder (sibling of Backend/Admin/User).
set -euo pipefail

DEPLOY_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STACK_ROOT="$(cd "$DEPLOY_SRC/../.." && pwd)"
DEPLOY_DEST="$STACK_ROOT/deploy"

if [[ ! -d "$STACK_ROOT/ITrustLD_Backend" ]] || [[ ! -d "$STACK_ROOT/ITrustLD_Admin" ]]; then
  echo "Expected stack layout in $STACK_ROOT:" >&2
  echo "  ITrustLD_Backend  ITrustLD_Admin  ITrustLD_User" >&2
  echo "Clone all three repos into the same parent, then run this script again." >&2
  exit 1
fi

if [[ -f "$DEPLOY_DEST/ecosystem.config.cjs" ]]; then
  echo "deploy/ already exists at $DEPLOY_DEST — skipping copy."
  exit 0
fi

cp -r "$DEPLOY_SRC" "$DEPLOY_DEST"
echo "Copied deploy to $DEPLOY_DEST"
echo "Next: cp deploy/env/*.example env files and run install-deps.sh"
