#!/usr/bin/env bash
set -euo pipefail

# Detect available compose command
if docker compose version &>/dev/null; then
  COMPOSE="docker compose"
elif command -v docker-compose &>/dev/null; then
  COMPOSE="docker-compose"
else
  echo "Error: docker compose is not available. Install the Docker Compose plugin or docker-compose standalone." >&2
  exit 1
fi

# Generate unique identifiers based on PID to avoid collisions
RUN_ID="e2e-$$"
DB_PORT=$((RANDOM % 10000 + 10000))
API_PORT=$((RANDOM % 10000 + 20000))

export DISPATCH_DB_NAME="$RUN_ID"
export DISPATCH_DB_PORT="$DB_PORT"
export E2E_PORT="$API_PORT"
export DATABASE_URL="postgres://dispatch:dispatch@127.0.0.1:${DB_PORT}/dispatch_${RUN_ID}"
export MEDIA_ROOT="/tmp/dispatch-media-${RUN_ID}"

# Disable TLS so the e2e server runs plain HTTP
unset TLS_CERT TLS_KEY

PROJECT="dispatch-${RUN_ID}"

mkdir -p "$MEDIA_ROOT"

cleanup() {
  echo "==> Tearing down isolated environment"
  $COMPOSE -p "$PROJECT" down -v 2>/dev/null || true
  rm -rf "$MEDIA_ROOT"
}
trap cleanup EXIT

echo "==> Starting isolated Postgres (project: ${PROJECT}, port: ${DB_PORT})"
$COMPOSE -p "$PROJECT" up -d --wait

echo "==> Building web bundle"
npm run build:web

echo "==> Running Playwright tests (API port: ${API_PORT})"
E2E_SKIP_WEB_BUILD=1 npx playwright test "$@"
