#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

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
# Per-run database: never resurrect it on daemon start. Without this, a run
# that dies before `cleanup` leaves a container Docker keeps bringing back.
export DISPATCH_DB_RESTART="no"
export E2E_PORT="$API_PORT"
# Agent runtime defaults to inert (no real agent processes). Live mode is an
# explicit opt-in via E2E_AGENT_RUNTIME=acp (`pnpm run test:e2e:live`), which
# runs real agent hosts against the fake ACP engine in e2e/fixtures, so no
# provider CLI or login is needed. It is deliberately a dedicated variable
# rather than DISPATCH_AGENT_RUNTIME itself, so a suite run started from
# inside an agent session cannot inherit live mode. Hosts live under this
# run's own state root and are stopped on teardown.
export DISPATCH_AGENT_RUNTIME="${E2E_AGENT_RUNTIME:-inert}"
export DISPATCH_AGENT_STATE_ROOT="/tmp/dispatch-agents-${RUN_ID}"
# The adapters ship inside the binary; this stands a fake engine in for both
# so the runtime can be driven with no engine installed (test seam only).
export DISPATCH_ACP_ADAPTER_COMMAND="[\"$ROOT_DIR/e2e/fixtures/fake-acp-agent.mjs\"]"

# `pnpm install` does not fetch Playwright browser binaries, so a Playwright
# version bump in the lockfile leaves the newly pinned revision missing and
# every browser test fails at launch with "Executable doesn't exist at
# ~/Library/Caches/ms-playwright/...". CI installs chromium as its own step;
# do the same here so a local run cannot fail that way. Already-installed is a
# sub-second no-op that touches no network, and running it before the database
# and web build means a genuinely missing browser fails fast.
echo "==> Ensuring the pinned Playwright chromium build is installed"
pnpm exec playwright install chromium

export DATABASE_URL="postgres://dispatch:dispatch@127.0.0.1:${DB_PORT}/dispatch_${RUN_ID}"
export DISPATCH_FILES_ROOT="/tmp/dispatch-files-${RUN_ID}"
# Keep the release store out of the host's ~/.dispatch/ — a stale version
# there surfaces the update-available toast and intercepts clicks.
export DISPATCH_RELEASE_STORE_PATH="/tmp/dispatch-release-${RUN_ID}.json"
export DISPATCH_RELEASE_CANDIDATE_STORE_PATH="/tmp/dispatch-release-candidate-${RUN_ID}.json"
# Disable TLS so the e2e server runs plain HTTP
unset TLS_CERT TLS_KEY

PROJECT="dispatch-${RUN_ID}"

mkdir -p "$DISPATCH_FILES_ROOT"

cleanup() {
  echo "==> Tearing down isolated environment"
  # Agent hosts outlive the server by design; stop the ones this run made.
  for pidfile in "$DISPATCH_AGENT_STATE_ROOT"/*/host.pid; do
    [ -f "$pidfile" ] || continue
    pid="$(cat "$pidfile" 2>/dev/null || true)"
    [ -n "$pid" ] && kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  done
  rm -rf "$DISPATCH_AGENT_STATE_ROOT"
  $COMPOSE -p "$PROJECT" down -v 2>/dev/null || true
  rm -rf "$DISPATCH_FILES_ROOT"
  rm -f "$DISPATCH_RELEASE_STORE_PATH" "$DISPATCH_RELEASE_CANDIDATE_STORE_PATH"
}
trap cleanup EXIT

echo "==> Starting isolated Postgres (project: ${PROJECT}, port: ${DB_PORT})"
$COMPOSE -p "$PROJECT" up -d --wait

echo "==> Building web bundle"
pnpm run build:web

echo "==> Running Playwright tests (API port: ${API_PORT})"
E2E_SKIP_WEB_BUILD=1 pnpm exec playwright test "$@"
