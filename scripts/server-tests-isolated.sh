#!/usr/bin/env bash
set -euo pipefail

# Runs the server vitest suite against a Postgres it provisions itself.
#
# ~39 of the server's test files open a database in `beforeAll` (see
# apps/server/test/db/setup.ts, which creates a throwaway `dispatch_test_*`
# database per suite). Without a reachable Postgres they all fail at collection
# time with ECONNREFUSED while the non-DB tests still report as passing — a red
# suite that looks like a product regression but is only a missing container.
# Previously the only thing making `pnpm run test` work locally was whatever
# Postgres happened to be listening on the compose default port, so the suite
# silently broke whenever that container went away.
#
# Precedence:
#   1. TEST_DATABASE_URL already set -> use it untouched. This is the CI path
#      (.github/workflows/ci.yml starts its own Postgres and exports the URL)
#      and the escape hatch for anyone pointing the suite at an existing
#      database, e.g. the `docker compose up -d` dev instance on port 5433.
#   2. Otherwise start a dedicated Postgres on a free port, run the suite
#      against it, and tear it down on exit.
#
# Any arguments are forwarded to vitest (e.g. a file filter, or `--coverage`).

if [ -n "${TEST_DATABASE_URL:-}" ]; then
  # Say which database was used. An exported TEST_DATABASE_URL outlives the
  # container it pointed at, and a silent passthrough to a dead port looks
  # exactly like the ECONNREFUSED wall this script exists to remove.
  echo "==> Using TEST_DATABASE_URL (${TEST_DATABASE_URL##*@})"
  exec bun x vitest "$@"
fi

# `docker compose version` only proves the CLI plugin is installed; `ls` also
# needs a running daemon, so both ways of "docker is missing" land on the same
# actionable message instead of a raw daemon error mid-run.
if docker compose ls &>/dev/null; then
  COMPOSE="docker compose"
elif docker-compose ls &>/dev/null; then
  COMPOSE="docker-compose"
else
  echo "Error: the server test suite needs a Postgres, and docker compose is not usable." >&2
  echo "Start Docker (or install the Docker Compose plugin), or point the suite at an existing database:" >&2
  echo '  TEST_DATABASE_URL="postgres://dispatch:dispatch@127.0.0.1:5433/postgres" pnpm --filter @dispatch/server test' >&2
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

# Include the timestamp for uniqueness across concurrent runs on one machine.
RUN_ID="servertest-$$-$(date +%s)"
DB_PORT="$(find_free_port)"

export DISPATCH_DB_NAME="$RUN_ID"
export DISPATCH_DB_PORT="$DB_PORT"
# The compose default (`unless-stopped`) is right for the long-lived dev
# database but wrong here: this container is per-run, and a run killed with
# SIGKILL skips the trap below, leaving a survivor that Docker would then
# resurrect on every daemon start.
export DISPATCH_DB_RESTART="no"

PROJECT="dispatch-${RUN_ID}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cleanup() {
  local exit_code=$?
  echo "==> Tearing down isolated Postgres"
  if [ "$exit_code" -ne 0 ]; then
    echo "==> Run failed (exit ${exit_code}); capturing Postgres diagnostics before teardown" >&2
    $COMPOSE -p "$PROJECT" -f "${REPO_ROOT}/docker-compose.yml" logs --tail 100 >&2 2>&1 || true
  fi
  local down_output
  if ! down_output="$($COMPOSE -p "$PROJECT" -f "${REPO_ROOT}/docker-compose.yml" down -v 2>&1)"; then
    echo "Warning: failed to tear down Postgres project ${PROJECT}:" >&2
    echo "$down_output" >&2
    echo "Clean it up manually with: $COMPOSE -p ${PROJECT} -f ${REPO_ROOT}/docker-compose.yml down -v" >&2
    # A passing suite must not report success when it leaked a container;
    # a failing suite keeps its own exit code rather than being masked by
    # this secondary failure.
    if [ "$exit_code" -eq 0 ]; then
      echo "Marking this run as failed: the suite passed, but teardown did not." >&2
      exit 1
    fi
  fi
}
trap cleanup EXIT

# Forwards a caught signal to the running vitest process and waits for it to
# actually exit before this script does. Without this, bash only runs the
# EXIT trap above once a *foreground* command returns on its own — a signal
# sent to this script's own PID while vitest is still running would sit
# pending until vitest finishes by itself, leaving it to keep running
# un-interrupted in the meantime. Backgrounding vitest below and `wait`-ing
# on it (rather than running it as a plain foreground command) is what
# makes this script's own wait interruptible in the first place.
TEST_PID=""
forward_and_wait() {
  local sig="$1"
  local code="$2"
  echo "" >&2
  echo "Interrupted (SIG${sig}); forwarding to the running test process..." >&2
  if [ -n "$TEST_PID" ] && kill -0 "$TEST_PID" 2>/dev/null; then
    kill -"$sig" "$TEST_PID" 2>/dev/null || true
    wait "$TEST_PID" 2>/dev/null || true
  fi
  exit "$code"
}
trap 'forward_and_wait INT 130' INT
trap 'forward_and_wait TERM 143' TERM

echo "==> Starting isolated Postgres for the server suite (project: ${PROJECT}, port: ${DB_PORT})"
$COMPOSE -p "$PROJECT" -f "${REPO_ROOT}/docker-compose.yml" up -d --wait

# Connect to the always-present `postgres` maintenance database; the suite
# helpers create and drop their own per-suite databases from there.
export TEST_DATABASE_URL="postgres://dispatch:dispatch@127.0.0.1:${DB_PORT}/postgres"

bun x vitest "$@" &
TEST_PID=$!
set +e
wait "$TEST_PID"
TEST_EXIT=$?
set -e
trap - INT TERM
exit "$TEST_EXIT"
