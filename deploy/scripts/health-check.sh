#!/usr/bin/env bash
# Smoke-test local services after deploy.
set -euo pipefail

API_URL="${API_URL:-http://127.0.0.1:4000}"
ADMIN_URL="${ADMIN_URL:-http://127.0.0.1:3001}"
USER_URL="${USER_URL:-http://127.0.0.1:3000}"

check_http() {
  local name="$1"
  local url="$2"
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 5 "$url" || echo "000")"
  if [[ "$code" =~ ^[23] ]]; then
    echo "OK  $name ($url) → HTTP $code"
  else
    echo "FAIL $name ($url) → HTTP $code" >&2
    return 1
  fi
}

failed=0

echo "==> Health checks"

if curl -sf --connect-timeout 5 "${API_URL}/api/v1/health" >/dev/null; then
  echo "OK  API health (${API_URL}/api/v1/health)"
else
  echo "FAIL API health" >&2
  failed=1
fi

if curl -sf --connect-timeout 5 "${API_URL}/api/v1/health/db" >/dev/null; then
  echo "OK  API database (${API_URL}/api/v1/health/db)"
else
  echo "FAIL API database — check DB_* in ITrustLD_Backend/.env" >&2
  failed=1
fi

check_http "Admin login" "${ADMIN_URL}/login" || failed=1
check_http "User home" "${USER_URL}/" || failed=1

if [[ "$failed" -ne 0 ]]; then
  echo "Some checks failed." >&2
  exit 1
fi

echo "All checks passed."
