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

# Disable TLS so the e2e server runs plain HTTP
unset TLS_CERT TLS_KEY

PROJECT="dispatch-${RUN_ID}"

mkdir -p "$MEDIA_ROOT"

cleanup() {
  echo "==> Tearing down isolated environment"
  # Kill tmux sessions created by e2e test agents. These are named like
  # dispatch_agt_xxxx_e2e-agent-*, so we can match them by the e2e prefix
  # without needing to query the (possibly empty) test database.
  tmux list-sessions -F '#{session_name}' 2>/dev/null \
    | grep '^dispatch_agt_.*e2e-agent' \
    | while read -r s; do tmux kill-session -t "$s" 2>/dev/null || true; done
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
