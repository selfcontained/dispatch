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

# Grab a free port from the OS. There is a small TOCTOU window between closing
# the probe socket and the actual service binding, but this is acceptable for
# dev/test tooling — collisions are extremely unlikely in practice.
find_free_port() {
  node -e '
    const net = require("net");
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      console.log(srv.address().port);
      srv.close();
    });
  '
}

# Include timestamp for uniqueness across CI parallel containers
RUN_ID="e2e-$$-$(date +%s)"
DB_PORT="$(find_free_port)"
API_PORT="$(find_free_port)"

export DISPATCH_DB_NAME="$RUN_ID"
export DISPATCH_DB_PORT="$DB_PORT"
export E2E_PORT="$API_PORT"
export DATABASE_URL="postgres://dispatch:dispatch@127.0.0.1:${DB_PORT}/dispatch_${RUN_ID}"
export MEDIA_ROOT="/tmp/dispatch-media-${RUN_ID}"
# Keep the release store out of the host's ~/.dispatch/ — a stale version
# there surfaces the update-available toast and intercepts clicks.
export DISPATCH_RELEASE_STORE_PATH="/tmp/dispatch-release-${RUN_ID}.json"
# Keep assisted-update rehydration state out of the host's ~/.dispatch/ too.
# A stale in-flight update there forces the Updates pane into takeover mode
# and hides the controls the release/settings E2E specs expect to exercise.
export DISPATCH_ASSISTED_UPDATE_STORE_PATH="/tmp/dispatch-assisted-update-${RUN_ID}.json"

# Disable TLS so the e2e server runs plain HTTP
unset TLS_CERT TLS_KEY

PROJECT="dispatch-${RUN_ID}"

mkdir -p "$MEDIA_ROOT"

cleanup() {
  echo "==> Tearing down isolated environment"
  $COMPOSE -p "$PROJECT" down -v 2>/dev/null || true
  rm -rf "$MEDIA_ROOT"
  rm -f "$DISPATCH_RELEASE_STORE_PATH"
  rm -f "$DISPATCH_ASSISTED_UPDATE_STORE_PATH"
}
trap cleanup EXIT

echo "==> Starting isolated Postgres (project: ${PROJECT}, port: ${DB_PORT})"
$COMPOSE -p "$PROJECT" up -d --wait

echo "==> Building web bundle"
pnpm run build:web

echo "==> Running Playwright tests (API port: ${API_PORT})"
DISPATCH_AGENT_RUNTIME=inert E2E_SKIP_WEB_BUILD=1 pnpm exec playwright test "$@"
