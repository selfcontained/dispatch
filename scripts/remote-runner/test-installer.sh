#!/usr/bin/env bash
# Exercise the installer with temporary files, a fixture signer and a fake
# service manager. Run from the worktree root.
set -euo pipefail
root=$(mktemp -d)
trap 'rm -rf -- "$root"' EXIT

cat > "$root/run" <<'HARNESS'
source bin/install-dispatch-runner.sh
root=$1
action=$2
tag=$3
arch=${4:-x64}
runtime="$root/runtime"
stage="$root/stage"
settings="$root/settings"
config="$settings/runner.json"
state="$root/state"
account=dispatch-runner
unit=dispatch-runner.service
unit_path="$root/$unit"
command_path="$root/bin/dispatch-runner"
cgroup_root="$root/cgroups"
frozen=0
umask 077
mkdir -p "$runtime" "$stage" "$cgroup_root/service"
if [[ ! -e "$cgroup_root/service/cgroup.events" ]]; then
  printf 'populated 0\nfrozen 0\n' > "$cgroup_root/service/cgroup.events"
fi
trap cleanup EXIT

curl() {
  local destination="${@: -1}" url="${@: -3:1}"
  cp "$root/releases/${url#https://github.com/selfcontained/dispatch/releases/download/}" "$destination"
}
gh() {
  [[ "$1 $2" == 'attestation verify' && "$*" == *'--repo selfcontained/dispatch'* &&
     "$*" == *'--signer-workflow selfcontained/dispatch/.github/workflows/release.yml'* ]] || return 1
  openssl dgst -sha256 -verify "$root/public.pem" -signature "$3.sigstore.json" "$3"
}
systemctl() {
  local command="$1"
  printf '%s\n' "$*" >> "$root/systemctl"
  case "$command" in
    start)
      if [[ -e "$root/reject-new" ]] && grep -q release-new "$runtime/dispatch"; then
        return 1
      fi
      : > "$root/running"
      ;;
    enable)
      [[ "$*" == 'enable --now dispatch-runner.service' ]] || return 1
      [[ -s "$settings/key.pem" && -s "$settings/cert.pem" && -s "$settings/ca.pem" ]] || return 1
      : > "$root/enabled"
      : > "$root/running"
      ;;
    is-active) [[ -e "$root/running" ]];;
    is-enabled)
      if [[ -e "$root/enabled" ]]; then
        printf 'enabled\n'
      else
        printf 'disabled\n'
        return 1
      fi
      ;;
    stop)
      rm -f "$root/running"
      printf 'populated 0\nfrozen 0\n' > "$cgroup_root/service/cgroup.events"
      ;;
    show)
      case "$3" in
        ActiveState) printf 'inactive\n' ;;
        MainPID) printf '101\n' ;;
        ControlGroup) printf '/service\n' ;;
        *) return 1 ;;
      esac
      ;;
    freeze)
      printf 'populated 1\nfrozen 1\n' > "$cgroup_root/service/cgroup.events"
      printf '%s\n' 101 > "$cgroup_root/service/cgroup.procs"
      if [[ -e "$root/busy" ]]; then
        mkdir -p "$cgroup_root/service/child"
        printf '%s\n' 102 > "$cgroup_root/service/child/cgroup.procs"
      fi
      ;;
    thaw) rm -rf "$cgroup_root/service/child" ;;
    kill) [[ "$*" == 'kill --kill-whom=main --signal=SIGKILL dispatch-runner.service' ]];;
    daemon-reload) ;;
    *) return 1 ;;
  esac
}
getent() {
  [[ -e "$root/account" ]] || return 2
  printf 'dispatch-runner:x:103:104::%s:/usr/sbin/nologin\n' "$state/home"
}
useradd() { : > "$root/account"; }
id() {
  case "$1" in -u) printf '103\n';; -g) printf '104\n';; *) return 1;; esac
}
install() {
  # Skip ownership changes in the unprivileged fixture.
  local args=()
  while [[ $# -gt 0 ]]; do
    case "$1" in -o|-g) shift 2;; *) args+=("$1"); shift;; esac
  done
  command install "${args[@]}"
}
mv() {
  [[ "$1" == -fT && ! -d "$3" ]] || return 1
  command mv -f "$2" "$3"
}
sleep() { :; }
sync() { :; }
flock() { [[ "$*" == '-n 9' ]]; }

case "$action" in
  install) stage_release; install_runner ;;
  connect)
    export root settings
    export -f systemctl flock
    "$command_path" connect --service "$tag"
    ;;
  *) update_runner ;;
esac
HARNESS

openssl genrsa -out "$root/private.pem" 2048 2>/dev/null
openssl rsa -in "$root/private.pem" -pubout -out "$root/public.pem" 2>/dev/null
mkdir -p "$root/archive/dist/bun" "$root/archive/bin"
cp bin/{dispatch-runner,dispatch-runner.service,install-dispatch-runner.sh,pack-release} "$root/archive/bin/"
touch "$root/archive/README.md" "$root/archive/.env.example"
for version in 1.0.0 1.0.1; do
  release="$root/releases/v$version"
  mkdir -p "$release"
  for arch in x64 arm64; do
    cat > "$root/archive/dist/bun/dispatch-$version-bun-linux-$arch" <<'RUNNER'
#!/usr/bin/env bash
[[ "$*" == 'connect --service https://dispatch.example' ]] || exit 1
printf 'fixture-key\n' > "$settings/key.pem"
printf 'fixture-cert\n' > "$settings/cert.pem"
printf 'fixture-ca\n' > "$settings/ca.pem"
RUNNER
    if [[ "$version" == 1.0.1 ]]; then
      printf '# release-new %s\n' "$arch" >> "$root/archive/dist/bun/dispatch-$version-bun-linux-$arch"
    fi
  done
  "$root/archive/bin/pack-release" --output "$release/dispatch-server.tar.gz" > /dev/null
  tar -xOzf "$release/dispatch-server.tar.gz" bin/install-dispatch-runner.sh > "$release/bootstrap"
  cmp bin/install-dispatch-runner.sh "$release/bootstrap"
  openssl dgst -sha256 -sign "$root/private.pem" -out "$release/dispatch-server.tar.gz.sigstore.json" \
    "$release/dispatch-server.tar.gz"
done

run() { bash "$root/run" "$root" "$@"; }
expect_status() {
  local expected="$1" status=0
  shift
  run "$@" || status=$?
  if [[ "$expected" != "$status" ]]; then
    printf 'Expected exit %s, got %s from %s\n' "$expected" "$status" "$*" >&2
    exit 1
  fi
}

run install v1.0.0
run install v1.0.0
[[ "$(readlink "$root/bin/dispatch-runner")" == "$root/runtime/runner-cli" ]]
[[ ! -e "$root/running" && ! -e "$root/settings/key.pem" ]]
! grep -Eq '^(start|enable) ' "$root/systemctl"
[[ "$(find "$root/settings/runner.json" -perm 0600 -print)" == "$root/settings/runner.json" ]]
grep -q '"workspaces": {}' "$root/settings/runner.json"
node - "$root/settings/runner.json" <<'JS'
const assert = require("node:assert/strict");
const fs = require("node:fs");
const config = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const packages = { codex: "@openai/codex", claude: "@anthropic-ai/claude-code", opencode: "opencode-ai" };
for (const [engine, pkg] of Object.entries(packages)) {
  const prefix = config.home + "/.local";
  assert.equal(config.bins[engine + "Bin"], prefix + "/bin/" + engine);
  for (const action of ["install", "update"]) {
    assert.deepEqual(config.engines[engine][action], {
      executable: "npm",
      args: ["install", "--global", "--prefix", prefix, pkg + "@latest"]
    });
  }
}
JS
cp "$root/runtime/dispatch" "$root/original"

run update v1.0.1
grep -q 'release-new x64' "$root/runtime/dispatch"
[[ ! -e "$root/running" && ! -e "$root/settings/key.pem" ]]

# Verify the wrapper starts the service only after a successful connect.
cp "$root/original" "$root/runtime/dispatch"
expect_status 1 connect https://unapproved.example
[[ ! -e "$root/running" && ! -e "$root/enabled" ]]
run connect https://dispatch.example
[[ $(grep -c '^enable --now ' "$root/systemctl") == 1 ]]
[[ -e "$root/running" && -e "$root/enabled" ]]
run install v1.0.0
[[ $(grep -c '^enable --now ' "$root/systemctl") == 1 ]]
cp -R "$root/settings" "$root/original-settings"

: > "$root/busy"
expect_status 75 update v1.0.1
cmp "$root/original" "$root/runtime/dispatch"
[[ ! -e "$root/runtime/previous" ]]
! grep -q '^kill ' "$root/systemctl"
grep -q '^thaw ' "$root/systemctl"
rm "$root/busy"

: > "$root/reject-new"
expect_status 1 update v1.0.1 arm64
cmp "$root/original" "$root/runtime/dispatch"
[[ ! -e "$root/runtime/previous" && -e "$root/running" ]]
rm "$root/reject-new"

run update v1.0.1 arm64
grep -q 'release-new arm64' "$root/runtime/dispatch"
[[ ! -e "$root/runtime/previous" ]]
diff -r "$root/original-settings" "$root/settings"

# A recovery record survives an interrupted swap.
cp "$root/original" "$root/runtime/previous"
run recover ""
cmp "$root/original" "$root/runtime/dispatch"
diff -r "$root/original-settings" "$root/settings"

printf 'tampered\n' >> "$root/releases/v1.0.1/dispatch-server.tar.gz"
expect_status 1 update v1.0.1
cmp "$root/original" "$root/runtime/dispatch"
printf 'Runner installer fixtures passed.\n'
