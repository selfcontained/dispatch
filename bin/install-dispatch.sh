#!/usr/bin/env bash
# Fresh, artifact-only Dispatch installer. Existing installations migrate via
# the assisted-update flow; this command intentionally refuses to overwrite
# one.
set -euo pipefail

REPO="${DISPATCH_GITHUB_REPO:-selfcontained/dispatch}"
HOME_DIR="${HOME:?HOME must be set}"
INSTALL_DIR="${DISPATCH_INSTALL_DIR:-$HOME_DIR/.dispatch/server}"
RUNTIME_PATH=""
PORT="6767"
TAG=""
RELEASE_URL="${DISPATCH_RELEASE_URL:-}"
DATABASE_URL="${DATABASE_URL:-}"
NO_SERVICE=0
ALLOW_PRERELEASE=0
INSTALL_SUCCEEDED=0
SERVICE_REGISTERED=0
GENERATED_DATABASE=0
GENERATED_ROLE=""
GENERATED_DB=""
MIGRATIONS_TMP=""

usage() {
  cat <<'EOF'
Usage: install-dispatch.sh [options]

Installs the latest stable Dispatch release for the current platform.
  --tag TAG             Install this stable release tag
  --allow-prerelease    Permit an explicitly selected prerelease tag
  --release-url URL     Artifact URL (testing/air-gapped installs)
  --install-dir PATH    Install directory (default: ~/.dispatch/server)
  --runtime-path PATH   Fixed executable path (default: INSTALL_DIR/dispatch)
  --database-url URL    Use an existing PostgreSQL database
  --port PORT           HTTP port (default: 6767)
  --no-service          Install files/configuration without a service or active-release record
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --tag) TAG="$2"; shift 2 ;;
    --allow-prerelease) ALLOW_PRERELEASE=1; shift ;;
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

case "$PORT" in *[!0-9]*|'') echo "error: --port must be numeric" >&2; exit 2;; esac
case "$(uname -s)" in Darwin) PLATFORM=darwin;; Linux) PLATFORM=linux;; *) echo "unsupported OS" >&2; exit 1;; esac
case "$(uname -m)" in arm64|aarch64) ARCH=arm64;; x86_64|amd64) ARCH=x64;; *) echo "unsupported architecture" >&2; exit 1;; esac

RUNTIME_PATH="${RUNTIME_PATH:-$INSTALL_DIR/dispatch}"
STATE_DIR="$HOME_DIR/.dispatch"
ENV_FILE="$INSTALL_DIR/.env"
LABEL="com.dispatch.server"
UNIT="$HOME_DIR/.config/systemd/user/dispatch.service"
PLIST="$HOME_DIR/Library/LaunchAgents/$LABEL.plist"

for service_path in "$INSTALL_DIR" "$RUNTIME_PATH" "$ENV_FILE"; do
  case "$service_path" in
    *" "*|*$'\t'*|*$'\n'*|*'&'*|*'<'*|*'>'*|*'"'*|*"'"*)
      echo "error: install and runtime paths cannot contain whitespace or XML-special characters" >&2
      exit 2 ;;
  esac
done

for command in curl tar; do command -v "$command" >/dev/null || { echo "error: $command is required" >&2; exit 1; }; done
if [ -e "$RUNTIME_PATH" ] || [ -e "$ENV_FILE" ] || { [ "$PLATFORM" = linux ] && [ -e "$UNIT" ]; } || { [ "$PLATFORM" = darwin ] && [ -e "$PLIST" ]; }; then
  echo "error: an existing Dispatch installation or service was found; use the assisted-update migration" >&2
  exit 1
fi

latest_tag() {
  curl -fsSL -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$REPO/releases/latest" || {
    echo "error: unable to reach api.github.com while finding the latest stable release" >&2; return 1;
  }
}
latest_tag_name() {
  latest_tag |
    sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1
}
if [ -n "$RELEASE_URL" ] && [ -z "$TAG" ]; then
  echo "error: --release-url requires --tag" >&2; exit 2
fi
TAG="${TAG:-$(latest_tag_name)}"
[ -n "$TAG" ] || { echo "error: no stable release found for $REPO" >&2; exit 1; }
if [ "$ALLOW_PRERELEASE" = 0 ] && [ -z "$RELEASE_URL" ]; then
  release_json="$(curl -fsSL -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$REPO/releases/tags/$TAG")" || {
    echo "error: unable to inspect release $TAG" >&2; exit 1;
  }
  if printf '%s' "$release_json" | grep -Eq '"prerelease"[[:space:]]*:[[:space:]]*true'; then
    echo "error: $TAG is a prerelease; pass --allow-prerelease to install it" >&2
    exit 1
  fi
fi
MEMBER="dist/bun/dispatch-${TAG#v}-bun-$PLATFORM-$ARCH"
RELEASE_URL="${RELEASE_URL:-https://github.com/$REPO/releases/download/$TAG/dispatch-release.tar.gz}"

PARENT="$(dirname "$RUNTIME_PATH")"
mkdir -p "$PARENT" "$INSTALL_DIR" "$STATE_DIR"
HAD_RELEASE_STORE=0; [ -e "$STATE_DIR/release.json" ] && HAD_RELEASE_STORE=1
HAD_MIGRATIONS_STORE=0; [ -e "$STATE_DIR/applied-migrations.json" ] && HAD_MIGRATIONS_STORE=1
HAD_CANDIDATE_STORE=0; [ -e "$STATE_DIR/release-candidate.json" ] && HAD_CANDIDATE_STORE=1
TMP="$(mktemp "$PARENT/.dispatch-install.XXXXXX")"
RELEASE_STORE_BACKUP="$TMP.release.json.prior"
MIGRATIONS_STORE_BACKUP="$TMP.applied-migrations.json.prior"
CANDIDATE_STORE_BACKUP="$TMP.release-candidate.json.prior"
[ "$HAD_RELEASE_STORE" = 1 ] && cp "$STATE_DIR/release.json" "$RELEASE_STORE_BACKUP"
[ "$HAD_MIGRATIONS_STORE" = 1 ] && cp "$STATE_DIR/applied-migrations.json" "$MIGRATIONS_STORE_BACKUP"
[ "$HAD_CANDIDATE_STORE" = 1 ] && cp "$STATE_DIR/release-candidate.json" "$CANDIDATE_STORE_BACKUP"
cleanup() {
  status=$?
  rm -f "$TMP" "$TMP.binary" "$MIGRATIONS_TMP"
  if [ "$status" -ne 0 ] && [ "$INSTALL_SUCCEEDED" = 0 ]; then
    if [ "$SERVICE_REGISTERED" = 1 ]; then
      if [ "$PLATFORM" = linux ]; then
        systemctl --user disable --now dispatch.service >/dev/null 2>&1 || true
        rm -f "$UNIT"
        systemctl --user daemon-reload >/dev/null 2>&1 || true
      else
        launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || true
        rm -f "$PLIST"
      fi
    fi
    rm -f "$RUNTIME_PATH" "$ENV_FILE"
    if [ "$HAD_RELEASE_STORE" = 1 ]; then mv "$RELEASE_STORE_BACKUP" "$STATE_DIR/release.json"; else rm -f "$STATE_DIR/release.json"; fi
    if [ "$HAD_MIGRATIONS_STORE" = 1 ]; then mv "$MIGRATIONS_STORE_BACKUP" "$STATE_DIR/applied-migrations.json"; else rm -f "$STATE_DIR/applied-migrations.json"; fi
    if [ "$HAD_CANDIDATE_STORE" = 1 ]; then mv "$CANDIDATE_STORE_BACKUP" "$STATE_DIR/release-candidate.json"; else rm -f "$STATE_DIR/release-candidate.json"; fi
    if [ "$GENERATED_DATABASE" = 1 ]; then
      echo "The generated PostgreSQL database was retained for retry:" >&2
      echo "  role: $GENERATED_ROLE  database: $GENERATED_DB" >&2
      echo "  cleanup: psql -d postgres -c 'DROP DATABASE $GENERATED_DB' -c 'DROP ROLE $GENERATED_ROLE'" >&2
    fi
  fi
  rm -f "$RELEASE_STORE_BACKUP" "$MIGRATIONS_STORE_BACKUP" "$CANDIDATE_STORE_BACKUP"
  exit "$status"
}
trap cleanup EXIT
echo "==> downloading $TAG"
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
printf '%s\n' "DATABASE_URL=$DATABASE_URL" "DISPATCH_HOST=127.0.0.1" "DISPATCH_PORT=$PORT" "DISPATCH_SERVER_DIR=$INSTALL_DIR" "DISPATCH_RUNTIME_PATH=$RUNTIME_PATH" "DISPATCH_RELEASE_STORE_PATH=$STATE_DIR/release.json" "DISPATCH_APPLIED_MIGRATIONS_STORE_PATH=$STATE_DIR/applied-migrations.json" "DISPATCH_RELEASE_CANDIDATE_STORE_PATH=$STATE_DIR/release-candidate.json" "DISPATCH_ASSISTED_UPDATE_STORE_PATH=$STATE_DIR/assisted-update.json" > "$ENV_FILE"
chmod 600 "$ENV_FILE"

if [ "$NO_SERVICE" = 0 ]; then
  NOW="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  # Keep this JSON shape in sync with the server-owned applied-migrations store.
  MIGRATIONS_TMP="$STATE_DIR/.applied-migrations.json.$$"
  {
    printf '{\n  "appliedMigrations": {'
    first=1
    while IFS= read -r migration; do
      [ -n "$migration" ] || continue
      migration_id="$(tar xOf "$TMP" "$migration" | sed -n 's/^id:[[:space:]]*//p' | head -n 1 | tr -d '\r')"
      case "$migration_id" in *[!a-z0-9-]*|'') echo "error: invalid migration id in $migration" >&2; exit 1 ;; esac
      [ "$first" = 1 ] || printf ','
      printf '\n    "%s": { "appliedAt": "%s", "targetTag": "%s" }' "$migration_id" "$NOW" "$TAG"
      first=0
    done <<EOF
$(printf '%s\n' "$LISTING" | grep -E '^update-migrations/[0-9]+-[a-z0-9-]+\.yaml$' || true)
EOF
    printf '\n  }\n}\n'
  } > "$MIGRATIONS_TMP"
  mv "$MIGRATIONS_TMP" "$STATE_DIR/applied-migrations.json"
  # Keep this shape in sync with apps/server/src/release-candidate-store.ts.
  # The newly healthy binary, not this installer, promotes it to release.json.
  printf '{\n  "tag": "%s",\n  "previousTag": null,\n  "activatedAt": "%s"\n}\n' "$TAG" "$NOW" > "$STATE_DIR/release-candidate.json"
  if [ "$PLATFORM" = linux ]; then
    mkdir -p "$(dirname "$UNIT")"
    printf '[Unit]\nDescription=Dispatch\n[Service]\nWorkingDirectory=%s\nEnvironmentFile=%s\nEnvironment=PATH=/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin\nExecStart=%s\nRestart=on-failure\nRestartSec=3\n[Install]\nWantedBy=default.target\n' "$INSTALL_DIR" "$ENV_FILE" "$RUNTIME_PATH" > "$UNIT"
    SERVICE_REGISTERED=1
    systemctl --user daemon-reload; systemctl --user enable --now dispatch.service
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
