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
# Per-run database: never resurrect it on daemon start. Without this, a run
# that dies before `cleanup` leaves a container Docker keeps bringing back.
export DISPATCH_DB_RESTART="no"
export E2E_PORT="$API_PORT"
# Agent runtime defaults to inert (no real agent processes). Live mode is an
# explicit opt-in via E2E_AGENT_RUNTIME=tmux (`pnpm run test:e2e:live`), which
# runs the terminal-live tests against real tmux sessions. It is deliberately
# a dedicated variable rather than DISPATCH_AGENT_RUNTIME itself: the Dispatch
# server exports DISPATCH_AGENT_RUNTIME=tmux into every agent shell it
# launches, so honoring the inherited value would silently flip suite runs
# started from inside an agent session to live mode. Live sessions are
# namespaced under this run's unique session prefix and killed on teardown,
# so they can never collide with a production Dispatch server on the same
# machine. (Sessions from a SIGKILL'd run are not reaped by later runs —
# each run only matches its own prefix; kill stale e2e-* sessions manually.)
export DISPATCH_AGENT_RUNTIME="${E2E_AGENT_RUNTIME:-inert}"
export DISPATCH_SESSION_PREFIX="$RUN_ID"
# dsh agents talk to a harness over ACP stdio. The suite never runs the real
# DeepSeek Harness: the fake in e2e/fixtures speaks the protocol and scripts
# one turn, and its home stays out of ~/.dispatch.
export DISPATCH_DSH_BIN="${DISPATCH_DSH_BIN:-$PWD/e2e/fixtures/fake-dsh.mjs}"
export DISPATCH_DSH_HOME="/tmp/dispatch-dsh-home-${RUN_ID}"

if [ "$DISPATCH_AGENT_RUNTIME" = "tmux" ] && ! command -v tmux &>/dev/null; then
  echo "Error: E2E_AGENT_RUNTIME=tmux but tmux is not on PATH." >&2
  exit 1
fi

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
export MEDIA_ROOT="/tmp/dispatch-media-${RUN_ID}"
# Keep the release store out of the host's ~/.dispatch/ — a stale version
# there surfaces the update-available toast and intercepts clicks.
export DISPATCH_RELEASE_STORE_PATH="/tmp/dispatch-release-${RUN_ID}.json"
export DISPATCH_RELEASE_CANDIDATE_STORE_PATH="/tmp/dispatch-release-candidate-${RUN_ID}.json"
# Disable TLS so the e2e server runs plain HTTP
unset TLS_CERT TLS_KEY

PROJECT="dispatch-${RUN_ID}"

mkdir -p "$MEDIA_ROOT"

cleanup() {
  echo "==> Tearing down isolated environment"
  if [ "$DISPATCH_AGENT_RUNTIME" = "tmux" ] && command -v tmux &>/dev/null; then
    tmux list-sessions -F '#{session_name}' 2>/dev/null \
      | grep "^${DISPATCH_SESSION_PREFIX}_" \
      | while read -r session; do
          tmux kill-session -t "$session" 2>/dev/null || true
        done || true
  fi
  $COMPOSE -p "$PROJECT" down -v 2>/dev/null || true
  rm -rf "$MEDIA_ROOT" "$DISPATCH_DSH_HOME"
  rm -f "$DISPATCH_RELEASE_STORE_PATH" "$DISPATCH_RELEASE_CANDIDATE_STORE_PATH"
}
trap cleanup EXIT

echo "==> Starting isolated Postgres (project: ${PROJECT}, port: ${DB_PORT})"
$COMPOSE -p "$PROJECT" up -d --wait

echo "==> Building web bundle"
pnpm run build:web

echo "==> Running Playwright tests (API port: ${API_PORT})"
E2E_SKIP_WEB_BUILD=1 pnpm exec playwright test "$@"
