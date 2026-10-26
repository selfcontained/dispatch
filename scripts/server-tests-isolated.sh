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

# Collects a PID and every current descendant into a flat list, walking
# depth-first. `vitest` (via bun's launcher) forks its own worker
# processes; a launcher that dies on TERM without itself forwarding
# anything to a child it forked would otherwise leave that worker running,
# now re-parented and no longer discoverable through it. Collecting the
# whole tree up front — before anything in it has been signaled — and
# killing from that fixed list (rather than re-querying pgrep as things
# die) is what still finds it.
collect_tree() {
  local pid="${1:-}"
  [ -n "$pid" ] || return 0
  local children
  children=$(pgrep -P "$pid" 2>/dev/null) || true
  local child
  for child in $children; do
    collect_tree "$child"
  done
  echo "$pid"
}

# Never signals a process group: a backgrounded job in a non-interactive
# script can share this script's own pgid (job control is off here), so a
# group-wide kill could just as easily hit this wrapper or an unrelated
# sibling process as the owned tree. PIDs only.
kill_pids() {
  local sig="$1"
  shift
  local pid
  for pid in "$@"; do
    kill -"$sig" "$pid" 2>/dev/null || true
  done
}

any_alive() {
  local pid
  for pid in "$@"; do
    kill -0 "$pid" 2>/dev/null && return 0
  done
  return 1
}

# Forwards a caught signal to the running vitest process *and its owned
# descendants*, waits (bounded) for the whole tree to actually exit, and
# escalates to SIGKILL for anything still alive — e.g. a worker that
# ignored the forwarded signal — before this script itself does. Without
# this, bash only runs the EXIT trap above once a *foreground* command
# returns on its own — a signal sent to this script's own PID while vitest
# is still running would sit pending until vitest finishes by itself,
# leaving it (and anything it forked) to keep running un-interrupted in the
# meantime. Backgrounding vitest below and `wait`-ing on it (rather than
# running it as a plain foreground command) is what makes this script's
# own wait interruptible in the first place.
TEST_PID=""
forward_and_wait() {
  local sig="$1"
  local code="$2"
  echo "" >&2
  echo "Interrupted (SIG${sig}); forwarding to the running test process..." >&2
  if [ -n "$TEST_PID" ] && kill -0 "$TEST_PID" 2>/dev/null; then
    local tree
    tree="$(collect_tree "$TEST_PID")"
    # shellcheck disable=SC2086
    kill_pids "$sig" $tree
    local i=0
    # shellcheck disable=SC2086
    while [ $i -lt 10 ] && any_alive $tree; do
      sleep 0.5
      i=$((i + 1))
    done
    # shellcheck disable=SC2086
    any_alive $tree && kill_pids 9 $tree
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
