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
  echo "==> Tearing down isolated Postgres"
  $COMPOSE -p "$PROJECT" -f "${REPO_ROOT}/docker-compose.yml" down -v 2>/dev/null || true
}
trap cleanup EXIT

# Sweep survivors of earlier SIGKILL'd runs. The run's start time is already
# encoded in the container name, so the age check needs no docker metadata.
# Scoped to this script's own prefix and to runs more than a day old, so it can
# never touch a dev database, an e2e run, or a concurrent server-suite run.
NOW="$(date +%s)"
docker ps -a --filter "name=^dispatch-postgres-servertest-" --format '{{.Names}}' 2>/dev/null |
  while read -r stale; do
    started="${stale##*-}"
    case "$started" in
      '' | *[!0-9]*) continue ;;
    esac
    if [ "$((NOW - started))" -gt 86400 ]; then
      docker rm -f "$stale" >/dev/null 2>&1 || true
    fi
  done

echo "==> Starting isolated Postgres for the server suite (project: ${PROJECT}, port: ${DB_PORT})"
$COMPOSE -p "$PROJECT" -f "${REPO_ROOT}/docker-compose.yml" up -d --wait

# Connect to the always-present `postgres` maintenance database; the suite
# helpers create and drop their own per-suite databases from there.
export TEST_DATABASE_URL="postgres://dispatch:dispatch@127.0.0.1:${DB_PORT}/postgres"

bun x vitest "$@"
