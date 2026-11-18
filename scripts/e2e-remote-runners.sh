#!/usr/bin/env bash
# Integrated remote-runner acceptance: local agent + two Docker-hosted runners
# with the same workspace name. Requires docker and bun. No VMs, no prod data.
#   pnpm run test:e2e:remote-runners [extra playwright args]
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE="${REMOTE_E2E_ROOT:-$HOME/.cache/dispatch-remote-e2e}"  # must be shared with the Docker VM (not /tmp on Colima)
mkdir -p "$BASE"
RUN_DIR="$BASE/run-$$-$(date +%s)"
cleanup() {
  node "$ROOT_DIR/e2e/remote-runner/setup.mjs" down "$RUN_DIR" || true
  rm -rf "$RUN_DIR"
  # Credentials live only inside the containers; prove none survive.
  left="$(docker ps -aq --filter "label=dispatch-remote-e2e=$(basename "$RUN_DIR")")"
  [ -z "$left" ] || { echo "LEAK: runner containers remain: $left" >&2; exit 1; }
}
trap cleanup EXIT
node "$ROOT_DIR/e2e/remote-runner/setup.mjs" up "$RUN_DIR"
# shellcheck disable=SC1091
. "$RUN_DIR/env"
exec_status=0
bash "$ROOT_DIR/scripts/e2e-isolated.sh" -c e2e/remote-runner/playwright.config.ts "$@" || exec_status=$?
exit "$exec_status"
