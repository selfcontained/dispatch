#!/usr/bin/env bash
# Fresh, artifact-only Dispatch installer. It intentionally refuses to
# overwrite an existing installation.
#
# Dispatch 1.x keeps its state, service and database apart from a 0.x
# install (~/.dispatch, dispatch.service / com.dispatch.server, the
# `dispatch` database), which it never reads or changes.
set -euo pipefail

REPO="${DISPATCH_GITHUB_REPO:-selfcontained/dispatch}"
HOME_DIR="${HOME:?HOME must be set}"
STATE_DIR="${DISPATCH_STATE_DIR:-${XDG_DATA_HOME:-$HOME_DIR/.local/share}/dispatch}"
INSTALL_DIR="${DISPATCH_INSTALL_DIR:-$STATE_DIR/server}"
RUNTIME_PATH=""
PORT=""
TAG=""
CHANNEL=""
RELEASE_URL="${DISPATCH_RELEASE_URL:-}"
DATABASE_URL="${DATABASE_URL:-}"
NO_SERVICE=0
INSTALL_SUCCEEDED=0
SERVICE_REGISTERED=0
GENERATED_DATABASE=0
GENERATED_ROLE=""
GENERATED_DB=""

usage() {
  cat <<'EOF'
Usage: install-dispatch.sh [options]

Installs the newest Dispatch release on a channel for the current platform.
  --channel CHANNEL     stable (promoted releases) or preview (every release).
                        Default: stable, or preview while no stable release exists
  --tag TAG             Install this release tag instead of the channel's newest
  --release-url URL     Artifact URL (testing/air-gapped installs)
  --install-dir PATH    Install directory (default: ~/.local/share/dispatch/server)
  --runtime-path PATH   Fixed executable path (default: INSTALL_DIR/dispatch)
  --database-url URL    Use an existing PostgreSQL database
  --port PORT           HTTP port (default: 6767, or the next free port above it)
  --no-service          Install files/configuration without a service or active-release record
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --channel) CHANNEL="$2"; shift 2 ;;
    --tag) TAG="$2"; shift 2 ;;
    --release-url) RELEASE_URL="$2"; shift 2 ;;
    --install-dir) INSTALL_DIR="$2"; shift 2 ;;
    --runtime-path) RUNTIME_PATH="$2"; shift 2 ;;
    --database-url) DATABASE_URL="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --no-service) NO_SERVICE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "error: unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

case "$PORT" in '') ;; *[!0-9]*) echo "error: --port must be numeric" >&2; exit 2;; esac
case "$CHANNEL" in ''|stable|preview) ;; *) echo "error: --channel must be stable or preview" >&2; exit 2;; esac
case "$(uname -s)" in Darwin) PLATFORM=darwin;; Linux) PLATFORM=linux;; *) echo "unsupported OS" >&2; exit 1;; esac
case "$(uname -m)" in arm64|aarch64) ARCH=arm64;; x86_64|amd64) ARCH=x64;; *) echo "unsupported architecture" >&2; exit 1;; esac

RUNTIME_PATH="${RUNTIME_PATH:-$INSTALL_DIR/dispatch}"
ENV_FILE="$INSTALL_DIR/.env"
# Not the 0.x names (dispatch.service, com.dispatch.server), so both can exist.
SERVICE="dispatch-server"
LABEL="dev.dispatch.server"
UNIT="$HOME_DIR/.config/systemd/user/$SERVICE.service"
PLIST="$HOME_DIR/Library/LaunchAgents/$LABEL.plist"
OLD_UNIT="$HOME_DIR/.config/systemd/user/dispatch.service"
OLD_PLIST="$HOME_DIR/Library/LaunchAgents/com.dispatch.server.plist"

for service_path in "$STATE_DIR" "$INSTALL_DIR" "$RUNTIME_PATH" "$ENV_FILE"; do
  case "$service_path" in
    *" "*|*$'\t'*|*$'\n'*|*'&'*|*'<'*|*'>'*|*'"'*|*"'"*)
      echo "error: install and runtime paths cannot contain whitespace or XML-special characters" >&2
      exit 2 ;;
  esac
done

for command in curl tar; do command -v "$command" >/dev/null || { echo "error: $command is required" >&2; exit 1; }; done
if [ -e "$RUNTIME_PATH" ] || [ -e "$ENV_FILE" ] || { [ "$PLATFORM" = linux ] && [ -e "$UNIT" ]; } || { [ "$PLATFORM" = darwin ] && [ -e "$PLIST" ]; }; then
  echo "error: Dispatch is already installed at $INSTALL_DIR; update it from Settings → Updates" >&2
  exit 1
fi
if [ -e "$OLD_UNIT" ] || [ -e "$OLD_PLIST" ] || [ -d "$HOME_DIR/.dispatch/server" ]; then
  echo "==> found Dispatch 0.x (~/.dispatch); it is left untouched and keeps its own data"
fi

# Something already answers on 127.0.0.1:PORT (often a 0.x Dispatch on 6767).
port_in_use() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
if [ -n "$PORT" ]; then
  if [ "$NO_SERVICE" = 0 ] && port_in_use "$PORT"; then
    echo "error: port $PORT is already in use; choose another with --port" >&2; exit 1
  fi
else
  PORT=6767
  while port_in_use "$PORT"; do
    PORT=$((PORT + 1))
    [ "$PORT" -le 6867 ] || { echo "error: no free port between 6767 and 6867; choose one with --port" >&2; exit 1; }
  done
  [ "$PORT" = 6767 ] || echo "==> port 6767 is in use; Dispatch will listen on $PORT"
fi

github_api() {
  curl -fsSL -H 'Accept: application/vnd.github+json' \
    ${GITHUB_TOKEN:+-H "Authorization: Bearer $GITHUB_TOKEN"} \
    "https://api.github.com/repos/$REPO/$1"
}
# Newest release carrying the platform artifact. The list is newest-first and
# excludes drafts; preview includes prereleases, stable only the promoted one.
# 0.x releases are the pre-ACP runtime and are never selected automatically.
newest_artifact_tag() {
  case "$1" in
    stable) github_api releases/latest ;;
    preview) github_api 'releases?per_page=100' ;;
  esac | { grep -oE "releases/download/v[1-9][0-9]*\.[0-9]+\.[0-9]+/dispatch-server\.tar\.gz" || true; } |
    awk -F/ 'NR == 1 { print $3 }'
}
if [ -n "$RELEASE_URL" ] && [ -z "$TAG" ]; then
  echo "error: --release-url requires --tag" >&2; exit 2
fi
if [ -z "$TAG" ]; then
  if [ -z "$CHANNEL" ]; then
    TAG="$(newest_artifact_tag stable 2>/dev/null || true)"
    if [ -n "$TAG" ]; then CHANNEL=stable; else CHANNEL=preview; echo "==> no stable release yet; using the preview channel"; fi
  fi
  if [ -z "$TAG" ]; then
    TAG="$(newest_artifact_tag "$CHANNEL")" || {
      echo "error: unable to reach api.github.com to find the newest $CHANNEL release (set GITHUB_TOKEN if rate limited)" >&2; exit 1;
    }
  fi
  [ -n "$TAG" ] || { echo "error: no $CHANNEL release found for $REPO" >&2; exit 1; }
elif [ -z "$RELEASE_URL" ]; then
  release_json="$(github_api "releases/tags/$TAG")" || { echo "error: unable to inspect release $TAG" >&2; exit 1; }
  if printf '%s' "$release_json" | grep -Eq '"prerelease"[[:space:]]*:[[:space:]]*true'; then
    [ "$CHANNEL" = stable ] && { echo "error: $TAG is a preview release; use --channel preview" >&2; exit 1; }
    CHANNEL=preview
  fi
fi
CHANNEL="${CHANNEL:-stable}"
MEMBER="dist/bun/dispatch-${TAG#v}-bun-$PLATFORM-$ARCH"
RELEASE_URL="${RELEASE_URL:-https://github.com/$REPO/releases/download/$TAG/dispatch-server.tar.gz}"

PARENT="$(dirname "$RUNTIME_PATH")"
mkdir -p "$PARENT" "$INSTALL_DIR" "$STATE_DIR"
HAD_RELEASE_STORE=0; [ -e "$STATE_DIR/release.json" ] && HAD_RELEASE_STORE=1
HAD_CANDIDATE_STORE=0; [ -e "$STATE_DIR/release-candidate.json" ] && HAD_CANDIDATE_STORE=1
TMP="$(mktemp "$PARENT/.dispatch-install.XXXXXX")"
RELEASE_STORE_BACKUP="$TMP.release.json.prior"
CANDIDATE_STORE_BACKUP="$TMP.release-candidate.json.prior"
[ "$HAD_RELEASE_STORE" = 1 ] && cp "$STATE_DIR/release.json" "$RELEASE_STORE_BACKUP"
[ "$HAD_CANDIDATE_STORE" = 1 ] && cp "$STATE_DIR/release-candidate.json" "$CANDIDATE_STORE_BACKUP"
cleanup() {
  status=$?
  rm -f "$TMP" "$TMP.binary"
  if [ "$status" -ne 0 ] && [ "$INSTALL_SUCCEEDED" = 0 ]; then
    if [ "$SERVICE_REGISTERED" = 1 ]; then
      if [ "$PLATFORM" = linux ]; then
        systemctl --user disable --now "$SERVICE.service" >/dev/null 2>&1 || true
        rm -f "$UNIT"
        systemctl --user daemon-reload >/dev/null 2>&1 || true
      else
        launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || true
        rm -f "$PLIST"
      fi
    fi
    rm -f "$RUNTIME_PATH" "$ENV_FILE"
    if [ "$HAD_RELEASE_STORE" = 1 ]; then mv "$RELEASE_STORE_BACKUP" "$STATE_DIR/release.json"; else rm -f "$STATE_DIR/release.json"; fi
    if [ "$HAD_CANDIDATE_STORE" = 1 ]; then mv "$CANDIDATE_STORE_BACKUP" "$STATE_DIR/release-candidate.json"; else rm -f "$STATE_DIR/release-candidate.json"; fi
    if [ "$GENERATED_DATABASE" = 1 ]; then
      echo "The generated PostgreSQL database was retained for retry:" >&2
      echo "  role: $GENERATED_ROLE  database: $GENERATED_DB" >&2
      echo "  cleanup: psql -d postgres -c 'DROP DATABASE $GENERATED_DB' -c 'DROP ROLE $GENERATED_ROLE'" >&2
    fi
  fi
  rm -f "$RELEASE_STORE_BACKUP" "$CANDIDATE_STORE_BACKUP"
  exit "$status"
}
trap cleanup EXIT
echo "==> downloading $TAG ($CHANNEL channel)"
curl -fL --retry 3 -o "$TMP" "$RELEASE_URL"

LISTING="$(tar tzf "$TMP")"
printf '%s\n' "$LISTING" | grep -Eq '(^/|(^|/)\.\.(/|$))' && { echo "error: release contains unsafe archive path" >&2; exit 1; }
printf '%s\n' "$LISTING" | grep -Fx "$MEMBER" >/dev/null || { echo "error: release does not contain $MEMBER" >&2; exit 1; }
[ "$(printf '%s\n' "$LISTING" | grep -Fxc "$MEMBER")" = 1 ] || { echo "error: release contains duplicate runtime member" >&2; exit 1; }
tar tvzf "$TMP" "$MEMBER" | grep -q '^-' || { echo "error: runtime member is not a regular file" >&2; exit 1; }
EXPECTED="$(tar xOf "$TMP" dist/bun/SHA256SUMS.txt | awk -v f="${MEMBER##*/}" '$2 == f { print $1; exit }')"
case "$EXPECTED" in [a-fA-F0-9][a-fA-F0-9]*) ;; *) echo "error: missing runtime checksum" >&2; exit 1;; esac
tar xOf "$TMP" "$MEMBER" > "$TMP.binary"
if command -v sha256sum >/dev/null; then ACTUAL="$(sha256sum "$TMP.binary" | awk '{print $1}')"; else ACTUAL="$(shasum -a 256 "$TMP.binary" | awk '{print $1}')"; fi
[ "$ACTUAL" = "$EXPECTED" ] || { echo "error: runtime checksum mismatch" >&2; exit 1; }
chmod 755 "$TMP.binary"
mv "$TMP.binary" "$RUNTIME_PATH"

if [ -z "$DATABASE_URL" ]; then
  for command in psql openssl; do command -v "$command" >/dev/null || { echo "error: $command is required to create a local PostgreSQL database; rerun with --database-url" >&2; exit 1; }; done
  SUFFIX="$(openssl rand -hex 6 2>/dev/null || date +%s)"
  ROLE="dispatch_$SUFFIX"; DB="dispatch_$SUFFIX"; PASSWORD="$(openssl rand -hex 24)"
  if psql -d postgres -Atqc 'SELECT 1' >/dev/null 2>&1; then PSQL="psql -d postgres";
  elif [ "$PLATFORM" = linux ] && sudo -n -u postgres psql -d postgres -Atqc 'SELECT 1' >/dev/null 2>&1; then PSQL="sudo -n -u postgres psql -d postgres";
  else echo "error: cannot administer local PostgreSQL; rerun with --database-url" >&2; exit 1; fi
  # Names and password are installer-generated hex, never user interpolation.
  $PSQL -v ON_ERROR_STOP=1 -f - <<EOF
CREATE ROLE $ROLE LOGIN PASSWORD '$PASSWORD';
CREATE DATABASE $DB OWNER $ROLE;
\\connect $DB
GRANT ALL ON SCHEMA public TO $ROLE;
EOF
  DATABASE_URL="postgres://$ROLE:$PASSWORD@127.0.0.1:5432/$DB"
  GENERATED_DATABASE=1; GENERATED_ROLE="$ROLE"; GENERATED_DB="$DB"
  PGPASSWORD="$PASSWORD" psql "postgres://$ROLE@127.0.0.1:5432/$DB" -Atqc 'SELECT 1' >/dev/null || {
    echo "error: generated database URL is not connectable; rerun with --database-url" >&2; exit 1;
  }
fi

umask 077
printf '%s\n' "DATABASE_URL=$DATABASE_URL" "DISPATCH_HOST=127.0.0.1" "DISPATCH_PORT=$PORT" "DISPATCH_STATE_DIR=$STATE_DIR" "DISPATCH_SERVER_DIR=$INSTALL_DIR" "DISPATCH_RUNTIME_PATH=$RUNTIME_PATH" "DISPATCH_SERVICE_NAME=$([ "$PLATFORM" = linux ] && echo "$SERVICE" || echo "$LABEL")" "DISPATCH_UPDATE_CHANNEL=$CHANNEL" > "$ENV_FILE"
chmod 600 "$ENV_FILE"

if [ "$NO_SERVICE" = 0 ]; then
  NOW="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  # Keep this shape in sync with apps/server/src/release-candidate-store.ts.
  # The newly healthy binary, not this installer, promotes it to release.json.
  printf '{\n  "tag": "%s",\n  "previousTag": null,\n  "activatedAt": "%s"\n}\n' "$TAG" "$NOW" > "$STATE_DIR/release-candidate.json"
  if [ "$PLATFORM" = linux ]; then
    mkdir -p "$(dirname "$UNIT")"
    printf '[Unit]\nDescription=Dispatch\n[Service]\nWorkingDirectory=%s\nEnvironmentFile=%s\nEnvironment=PATH=/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin\nExecStart=%s\nRestart=on-failure\nRestartSec=3\n# Keep agent host processes alive across a Dispatch service restart.\nKillMode=process\n[Install]\nWantedBy=default.target\n' "$INSTALL_DIR" "$ENV_FILE" "$RUNTIME_PATH" > "$UNIT"
    SERVICE_REGISTERED=1
    systemctl --user daemon-reload; systemctl --user enable --now "$SERVICE.service"
    if command -v loginctl >/dev/null && ! loginctl show-user "$USER" -p Linger --value 2>/dev/null | grep -qx yes; then
      if loginctl enable-linger "$USER" 2>/dev/null; then
        echo "==> enabled systemd lingering so Dispatch starts without a login"
      else
        echo "warning: enable lingering for boot/login-independent service: loginctl enable-linger $USER" >&2
      fi
    fi
  else
    mkdir -p "$(dirname "$PLIST")" "$STATE_DIR/logs"
    LOG_FILE="$STATE_DIR/logs/dispatch.log"
    printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>' '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">' '<plist version="1.0"><dict>' "<key>Label</key><string>$LABEL</string>" "<key>ProgramArguments</key><array><string>$RUNTIME_PATH</string></array>" "<key>WorkingDirectory</key><string>$INSTALL_DIR</string>" "<key>StandardOutPath</key><string>$LOG_FILE</string>" "<key>StandardErrorPath</key><string>$LOG_FILE</string>" '<key>EnvironmentVariables</key><dict><key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>' '<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>' '</dict></plist>' > "$PLIST"
    SERVICE_REGISTERED=1
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
  fi
  for _ in $(seq 1 30); do curl -fsS "http://127.0.0.1:$PORT/api/v1/health" >/dev/null && break; sleep 1; done
  curl -fsS "http://127.0.0.1:$PORT/api/v1/health" >/dev/null || { echo "error: Dispatch did not become healthy${LOG_FILE:+; see $LOG_FILE}" >&2; exit 1; }
fi

if [ "$NO_SERVICE" = 0 ]; then
  # Confirm server-owned promotion (release-store.ts).
  for _ in $(seq 1 10); do
    grep -Fq '"tag": "'"$TAG"'"' "$STATE_DIR/release.json" 2>/dev/null && break
    sleep 1
  done
  grep -Fq '"tag": "'"$TAG"'"' "$STATE_DIR/release.json" 2>/dev/null || { echo "error: healthy Dispatch did not record $TAG" >&2; exit 1; }
fi
INSTALL_SUCCEEDED=1
echo "Dispatch $TAG installed at $RUNTIME_PATH"
echo "  channel: $CHANNEL (change it in Settings → Updates)"
if [ "$NO_SERVICE" = 0 ]; then echo "  open: http://127.0.0.1:$PORT"; fi
