#!/usr/bin/env bash
# VM fixture: convert a healthy fixed-path Linux Dispatch install into the
# ≤v0.31.x legacy shape where the systemd ExecStart resolves through a
# bin/dispatch symlink hard-pinned to a versioned dist/bun binary.
#
# Use this ONLY inside a disposable VM (see docs/vm-release-validation.md,
# "Existing legacy Linux service" row). It models the failure mode where a
# managed update restarts back into the old pinned binary, whose boot-time
# release-binary pruning deletes the freshly extracted target artifact while
# release.json claims success.
#
# After running it, exercise the assisted update to the target release and
# verify the fixed-runtime cutover happens BEFORE the first restart and that
# the actually-running executable is the target version (X-Dispatch-Version
# header or /proc/<MainPID>/exe), not just release.json.
set -euo pipefail

if [ "$(uname -s)" != "Linux" ]; then
  echo "error: this fixture models a Linux systemd install" >&2
  exit 1
fi

INSTALL_DIR="${DISPATCH_INSTALL_DIR:-$HOME/.dispatch/server}"
ENV_FILE="$INSTALL_DIR/.env"
UNIT="$HOME/.config/systemd/user/dispatch.service"
STATE_DIR="$HOME/.dispatch"
APPLIED_STORE="$STATE_DIR/applied-migrations.json"

# Resolve the configured runtime path the same way the server does.
RUNTIME_PATH="$INSTALL_DIR/dispatch"
if [ -f "$ENV_FILE" ]; then
  configured="$(sed -n 's/^DISPATCH_RUNTIME_PATH=//p' "$ENV_FILE" | tail -n 1)"
  [ -n "$configured" ] && RUNTIME_PATH="$configured"
fi

[ -f "$RUNTIME_PATH" ] || { echo "error: no fixed runtime at $RUNTIME_PATH — install Dispatch first" >&2; exit 1; }
[ -f "$UNIT" ] || { echo "error: no user unit at $UNIT" >&2; exit 1; }

# The version the fixture pins to: the currently installed one.
PINNED_VERSION="$(sed -n 's/.*"tag": *"v\([^"]*\)".*/\1/p' "$STATE_DIR/release.json" | head -n 1)"
[ -n "$PINNED_VERSION" ] || { echo "error: could not read installed tag from $STATE_DIR/release.json" >&2; exit 1; }

case "$(uname -m)" in
  arm64|aarch64) ARCH=arm64 ;;
  x86_64|amd64) ARCH=x64 ;;
  *) echo "unsupported architecture" >&2; exit 1 ;;
esac
PINNED_BINARY="$INSTALL_DIR/dist/bun/dispatch-$PINNED_VERSION-bun-linux-$ARCH"

echo "==> pinning service to dist/bun/dispatch-$PINNED_VERSION-bun-linux-$ARCH"

# 1. Materialize the versioned binary the legacy install would have.
mkdir -p "$INSTALL_DIR/dist/bun" "$INSTALL_DIR/bin"
cp -p "$RUNTIME_PATH" "$PINNED_BINARY"

# 2. Legacy entrypoint: bin/dispatch symlink hard-pinned to the versioned binary.
ln -sfn "$PINNED_BINARY" "$INSTALL_DIR/bin/dispatch"

# 3. Repoint ExecStart at the pinned symlink and drop KillMode=process
#    (legacy units predate it). Keep a copy of the fixture unit for the
#    procedure's "backup of the fixture unit" step.
cp -p "$UNIT" "$UNIT.fixture-backup"
sed -i \
  -e "s|^ExecStart=.*|ExecStart=$INSTALL_DIR/bin/dispatch|" \
  -e '/^KillMode=process$/d' \
  "$UNIT"

# 4. Remove fixed-path artifacts the legacy install never had.
rm -f "$RUNTIME_PATH" "$RUNTIME_PATH.previous"

# 5. Mark the fixed-runtime migrations as never applied so the assisted
#    update treats them as pending (fresh installs seed them as applied).
if [ -f "$APPLIED_STORE" ]; then
  python3 - "$APPLIED_STORE" <<'PY'
import json, sys
path = sys.argv[1]
state = json.load(open(path))
for mid in ("fixed-runtime-entrypoint", "agent-restart-safety"):
    state.get("appliedMigrations", {}).pop(mid, None)
json.dump(state, open(path, "w"), indent=2)
PY
fi

systemctl --user daemon-reload
systemctl --user restart dispatch

echo "==> legacy pinned-symlink fixture in place:"
echo "    ExecStart -> $INSTALL_DIR/bin/dispatch -> $PINNED_BINARY"
echo "    fixed runtime removed: $RUNTIME_PATH"
echo "    unit backup: $UNIT.fixture-backup"
systemctl --user --no-pager status dispatch || true
