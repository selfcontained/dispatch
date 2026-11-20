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
dedicated=0
requested_user=
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
      [[ ! -e "$root/frozen" ]] || return 1
      rm -f "$root/running"
      printf 'populated 0\nfrozen 0\n' > "$cgroup_root/service/cgroup.events"
      ;;
    show)
      case "$3" in
        KillMode) if [[ -e "$root/custom-kill" ]]; then echo control-group; else echo process; fi ;;
        ExecStop|ExecStopPost|SubState) : ;;
        ActiveState) printf 'inactive\n' ;;
        MainPID) printf '101\n' ;;
        ControlGroup) printf '/service\n' ;;
        *) return 1 ;;
      esac
      ;;
    freeze)
      : > "$root/frozen"
      printf 'populated 1\nfrozen 1\n' > "$cgroup_root/service/cgroup.events"
      printf '%s\n' 101 > "$cgroup_root/service/cgroup.procs"
      if [[ -e "$root/busy" ]]; then
        mkdir -p "$cgroup_root/service/child"
        printf '%s\n' 102 > "$cgroup_root/service/child/cgroup.procs"
      fi
      ;;
    thaw) rm -f "$root/frozen"; rm -rf "$cgroup_root/service/child" ;;
    --kill-whom=main) [[ "$2" == --version && ! -e "$root/legacy-systemctl" ]];;
    kill)
      local target=--kill-whom=main
      [[ ! -e "$root/legacy-systemctl" ]] || target=--kill-who=main
      [[ "$*" == "kill $target --signal=SIGKILL dispatch-runner.service" || "$*" == "kill $target --signal=SIGSTOP dispatch-runner.service" ]]
      ;;
    daemon-reload) ;;
    *) return 1 ;;
  esac
}
python3() {
  # Process identity checks run against real /proc in the Linux VM. Here the
  # fixture models an open, recoverable host to exercise the installer gates.
  [[ "$1" == -I && "$2" == "$stage/handoff.py" && "$3" == "$config" &&
     "$5" == 101 && -f "$root/idle-host" ]] &&
    cmp -s "$2" bin/runner-handoff-v1.py && grep -Fxq 102 "$4"
}
getent() {
  case "${@: -1}" in
    dispatch-runner)
      [[ -e "$root/account" ]] || return 2
      printf 'dispatch-runner:x:103:104::%s:/usr/sbin/nologin\n' "$state/home"
      ;;
    installer) printf 'installer:x:1000:1001::%s:/bin/bash\n' "$root/installer home" ;;
    alternate) printf 'alternate:x:2000:2001::%s:/bin/zsh\n' "$root/alternate home" ;;
    root) printf 'root:x:0:0::/root:/bin/bash\n' ;;
    *) return 2 ;;
  esac
}
useradd() { : > "$root/account"; }
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
# Run the account lookup as this fixture user; record any package install.
setpriv() {
  while [[ "$1" == --* ]]; do shift; done
  "$@"
}
apt-get() { printf 'apt-get %s\n' "$*" >> "$root/package-installs"; }
apt() { printf 'apt %s\n' "$*" >> "$root/package-installs"; }

case "$action" in
  install) parse_install_options "${@:5}"; stage_release; install_runner ;;
  deps)
    (
      unset -f gh curl
      PATH="$root/rootbin"
      check_dependencies
      check_workload_tools installer 1000 1001 "$root/installer home" /bin/bash
    )
    ;;
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
cp bin/{dispatch-runner,dispatch-runner.service,install-dispatch-runner.sh,runner-handoff-v1.py,pack-release} "$root/archive/bin/"
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

run() { bash "$root/run" "${fixture_root:-$root}" "$@"; }
expect_status() {
  local expected="$1" status=0
  shift
  run "$@" || status=$?
  if [[ "$expected" != "$status" ]]; then
    printf 'Expected exit %s, got %s from %s\n' "$expected" "$status" "$*" >&2
    exit 1
  fi
}

for fixture in invalid default explicit; do
  fixture_root="$root/$fixture"
  mkdir -p "$fixture_root"
  ln -s "$root/releases" "$fixture_root/releases"
  ln -s "$root/public.pem" "$fixture_root/public.pem"
  case "$fixture" in
    invalid)
      SUDO_USER= expect_status 1 install v1.0.0
      SUDO_USER=root expect_status 1 install v1.0.0
      SUDO_USER=installer expect_status 1 install v1.0.0 x64 --user unknown
      SUDO_USER=installer expect_status 1 install v1.0.0 x64 --user alternate --dedicated-user
      [[ ! -e "$fixture_root/settings/runner.json" && ! -e "$fixture_root/account" ]]
      ;;
    default)
      mkdir "$fixture_root/installer home"
      SUDO_USER=installer run install v1.0.0
      SUDO_USER=installer run install v1.0.0 x64 --user alternate 2> "$fixture_root/reinstall"
      grep -Fq 'Keeping the configured workload account.' "$fixture_root/reinstall"
      grep -Fq '"uid": 1000' "$fixture_root/settings/runner.json"
      grep -Fq "\"home\": \"$fixture_root/installer home\"" "$fixture_root/settings/runner.json"
      ;;
    explicit)
      mkdir "$fixture_root/alternate home"
      SUDO_USER=installer run install v1.0.0 x64 --user alternate
      grep -Fq '"uid": 2000' "$fixture_root/settings/runner.json"
      grep -Fq "\"home\": \"$fixture_root/alternate home\"" "$fixture_root/settings/runner.json"
      ;;
  esac
  if [[ "$fixture" != invalid ]]; then
    [[ -n "$(find "$fixture_root/state" -maxdepth 0 -perm 0755 -print)" ]]
    [[ -n "$(find "$fixture_root/state/runner" -maxdepth 0 -perm 0751 -print)" ]]
    chmod 0711 "$fixture_root/state"
    run update v1.0.1
    [[ -n "$(find "$fixture_root/state" -maxdepth 0 -perm 0755 -print)" ]]
  fi
  [[ ! -e "$fixture_root/state/home" && ! -e "$fixture_root/account" ]]
  [[ -z "$(find "$fixture_root" -path '* home/*' -print)" ]]
done
unset fixture_root

# Dependencies: tools already present are reported and left alone; a missing
# one is named and nothing is installed. sudo's PATH may lack the invoking
# user's own gh, so it is found through their login profile.
deps="$root/deps"
mkdir -p "$deps/rootbin" "$deps/installer home/tools/bin"
for tool in curl tar ps find grep tail env; do
  ln -s "$(command -v "$tool")" "$deps/rootbin/$tool"
done
printf '#!/bin/sh\n[ "$1 $2 $3" = "attestation verify --help" ]\n' > "$deps/rootbin/gh"
cp "$deps/rootbin/gh" "$deps/installer home/tools/bin/gh"
ln -s "$(command -v git)" "$deps/installer home/tools/bin/git"
chmod 0755 "$deps/rootbin/gh" "$deps/installer home/tools/bin/gh"
printf 'PATH="$HOME/tools/bin:/usr/bin:/bin"\n' > "$deps/installer home/.bash_profile"
fixture_root=$deps
SUDO_USER=installer run deps "" > "$deps/out"
for tool in curl tar ps find; do
  grep -Fxq "Found $tool: $deps/rootbin/$tool" "$deps/out"
done
grep -Fxq "Found gh: $deps/rootbin/gh" "$deps/out"
grep -Fxq "Found git for installer: $deps/installer home/tools/bin/git" "$deps/out"
grep -Fxq "Found gh for installer: $deps/installer home/tools/bin/gh" "$deps/out"
[[ ! -e "$deps/package-installs" ]]

rm "$deps/rootbin/tar" "$deps/rootbin/gh"
SUDO_USER=installer expect_status 1 deps "" > "$deps/out" 2> "$deps/err"
grep -Fxq "Missing tar" "$deps/out"
grep -Fxq "Found curl: $deps/rootbin/curl" "$deps/out"
grep -Fxq "Found gh: $deps/installer home/tools/bin/gh" "$deps/out"
grep -Fxq "error: Install tar. The installer does not install or upgrade packages" "$deps/err"
[[ ! -e "$deps/package-installs" ]]

ln -s "$(command -v tar)" "$deps/rootbin/tar"
printf '#!/bin/sh\nexit 1\n' > "$deps/installer home/tools/bin/gh"
SUDO_USER=installer expect_status 1 deps "" > /dev/null 2> "$deps/err"
grep -Fq "cannot verify release attestations" "$deps/err"
[[ ! -e "$deps/package-installs" ]]
unset fixture_root

run install v1.0.0 x64 --dedicated-user
run install v1.0.0 x64 --dedicated-user
[[ -e "$root/account" && -d "$root/state/home" ]]
grep -Fq '"uid": 103' "$root/settings/runner.json"
[[ "$(readlink "$root/bin/dispatch-runner")" == "$root/runtime/runner-cli" ]]
[[ ! -e "$root/running" && ! -e "$root/settings/key.pem" ]]
! grep -Eq '^(start|enable) ' "$root/systemctl"
[[ "$(find "$root/settings/runner.json" -perm 0600 -print)" == "$root/settings/runner.json" ]]
grep -q '"workspaces": {}' "$root/settings/runner.json"
node - "$root/settings/runner.json" "$root/runtime/dispatch" <<'JS'
const assert = require("node:assert/strict");
const fs = require("node:fs");
const config = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const packages = { codex: "@openai/codex", claude: "@anthropic-ai/claude-code", opencode: "opencode-ai" };
for (const [engine, pkg] of Object.entries(packages)) {
  const prefix = config.home + "/.local";
  assert.equal(config.bins[engine + "Bin"], prefix + "/bin/" + engine);
  for (const action of ["install", "update"]) {
    assert.deepEqual(config.engines[engine][action], {
      executable: process.argv[3],
      args: ["add", "--global", "--trust", pkg + "@latest"],
      env: {BUN_BE_BUN: "1", BUN_INSTALL: prefix}
    });
  }
}
JS
cp "$root/runtime/dispatch" "$root/original"
# A verified upgrade migrates the exact managed prototype unit.
sed 's/^KillMode=process$/KillMode=control-group/' "$root/dispatch-runner.service" > "$root/legacy-unit"
cp "$root/legacy-unit" "$root/dispatch-runner.service"

chmod 0711 "$root/state"
run update v1.0.1
[[ -n "$(find "$root/state" -maxdepth 0 -perm 0755 -print)" ]]
[[ -n "$(find "$root/state/runner" -maxdepth 0 -perm 0751 -print)" ]]
[[ -n "$(find "$root/state/home" -maxdepth 0 -perm 0700 -print)" ]]
[[ -n "$(find "$root/settings" -maxdepth 0 -perm 0711 -print)" ]]
grep -qx 'KillMode=process' "$root/dispatch-runner.service"
printf '# administrator setting\n' >> "$root/dispatch-runner.service"
run update v1.0.1
grep -qx '# administrator setting' "$root/dispatch-runner.service"
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
# Even a recoverable host must survive the effective unit's stop policy.
touch "$root/idle-host" "$root/custom-kill"
expect_status 75 update v1.0.1
[[ ! -e "$root/runtime/previous" && ! -e "$root/frozen" ]]
rm "$root/custom-kill"

: > "$root/reject-new"
expect_status 1 update v1.0.1 arm64
cmp "$root/original" "$root/runtime/dispatch"
[[ ! -e "$root/runtime/previous" && -e "$root/running" ]]
rm "$root/reject-new"

grep -Fq "New runner failed to start" "$root/runtime/last-maintenance.log"
[[ -n "$(find "$root/runtime/last-maintenance.log" -perm 0600 -print)" ]]
grep -Fq '"step":"start","exitCode":1' "$root/runtime/last-maintenance-failure.json"
: > "$root/legacy-systemctl"
run update v1.0.1 arm64
grep -Fxq 'kill --kill-who=main --signal=SIGKILL dispatch-runner.service' "$root/systemctl"
[[ ! -e "$root/runtime/last-maintenance-failure.json" ]]
grep -q 'release-new arm64' "$root/runtime/dispatch"
[[ ! -e "$root/runtime/previous" ]]
diff -r "$root/original-settings" "$root/settings"

# A recovery record survives an interrupted swap.
cp "$root/original" "$root/runtime/previous"
expect_status 75 recover ""
cp bin/runner-handoff-v1.py "$root/runtime/previous-handoff.py"
run recover ""
cmp "$root/original" "$root/runtime/dispatch"
diff -r "$root/original-settings" "$root/settings"

printf 'tampered\n' >> "$root/releases/v1.0.1/dispatch-server.tar.gz"
expect_status 1 update v1.0.1
cmp "$root/original" "$root/runtime/dispatch"
printf 'Runner installer fixtures passed.\n'
