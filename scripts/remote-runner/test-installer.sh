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
source_url=
source_ca=
dev_sha256=
allow_dev=0
allow_downgrade=0
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
  printf '%s\n' "$*" >> "$root/curl"
  case "$url" in
    https://github.com/selfcontained/dispatch/releases/download/*)
      cp "$root/releases/${url#https://github.com/selfcontained/dispatch/releases/download/}" "$destination"
      ;;
    http://controller.test:8080/api/v1/runner-artifacts/abc1234/* | https://controller.test:7443/api/v1/runner-artifacts/abc1234/*)
      # A served file must come over the source's own scheme, pinned for https.
      [[ "$*" == *"--proto =${url%%://*} --proto-redir =${url%%://*} "* ]] || return 1
      if [[ "$url" == https://* && -n "$source_ca" ]]; then
        [[ "$*" == *"--cacert $stage/ca.pem "* ]] && cmp -s "$stage/ca.pem" "$source_ca" || return 60
      fi
      [[ -f "$root/served/${url##*/}" ]] || return 22
      cp "$root/served/${url##*/}" "$destination"
      ;;
    *) return 6 ;;
  esac
}
gh() {
  [[ "$1 $2" == 'attestation verify' && "$*" == *'--repo selfcontained/dispatch'* &&
     "$*" == *'--signer-workflow selfcontained/dispatch/.github/workflows/release.yml'* ]] || return 1
  openssl dgst -sha256 -verify "$root/public.pem" -signature "$3.sigstore.json" "$3"
}
stat() {
  if [[ "$(uname -s)" == Darwin && "$1" == -c && "$2" == '%d:%i' ]]; then
    command stat -f '%d:%i' "$3"
  else
    command stat "$@"
  fi
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
  apply)
    # The copied command's entry point: install, or update a managed runner.
    action=install
    parse_install_options "${@:5}"
    validate_source
    if [[ "$allow_dev" == 0 && -n "${SUDO_USER:-}" ]]; then
      resolve_release_gh
      [[ -n "$gh_bin" ]] || exit 1
    fi
    run_action
    ;;
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
  *)
    parse_install_options "${@:5}"
    if [[ "$action" != recover && "$allow_dev" == 0 && -n "${SUDO_USER:-}" ]]; then
      resolve_release_gh
      [[ -n "$gh_bin" ]] || exit 1
    fi
    update_runner
    ;;
esac
HARNESS

openssl genrsa -out "$root/private.pem" 2048 2>/dev/null
openssl rsa -in "$root/private.pem" -pubout -out "$root/public.pem" 2>/dev/null
mkdir -p "$root/archive/dist/bun" "$root/archive/bin"
cp bin/{dispatch-runner,dispatch-runner.service,install-dispatch-runner.sh,runner-handoff-v1.py,pack-release} "$root/archive/bin/"
touch "$root/archive/README.md" "$root/archive/.env.example"
if "$root/archive/bin/pack-release" --runner-arch riscv64 > "$root/pack-error" 2>&1; then exit 1; fi
grep -Fq 'expects x64 or arm64' "$root/pack-error"
if "$root/archive/bin/pack-release" --runner-arch x64 > "$root/pack-error" 2>&1; then exit 1; fi
grep -Fq 'expected one Linux x64 runner and a build identity' "$root/pack-error"
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
  printf '{"version":"%s","revision":"abc1234"}\n' "$version" > "$root/archive/dist/bun/BUILD_IDENTITY.json"
  for arch in x64 arm64; do
    asset="$release/dispatch-runner-linux-$arch.tar.gz"
    "$root/archive/bin/pack-release" --runner-arch "$arch" --output "$asset" > /dev/null
    tar -xOzf "$asset" bin/install-dispatch-runner.sh > "$release/bootstrap"
    cmp bin/install-dispatch-runner.sh "$release/bootstrap"
    openssl dgst -sha256 -sign "$root/private.pem" -out "$asset.sigstore.json" "$asset"
    rm "$root/archive/dist/bun/dispatch-$version-bun-linux-$arch"
  done
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
grep -Fxq "Found gh: $deps/installer home/tools/bin/gh" "$deps/out"
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

# A deferred update leaves the on-host maintenance tools as they were.
printf '# stale updater\n' > "$root/runtime/install-dispatch-runner.sh"
printf '# stale cli\n' > "$root/runtime/runner-cli"
: > "$root/busy"
expect_status 75 update v1.0.1
cmp "$root/original" "$root/runtime/dispatch"
grep -Fxq '# stale updater' "$root/runtime/install-dispatch-runner.sh"
grep -Fxq '# stale cli' "$root/runtime/runner-cli"
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
# A successful update refreshes them from the verified archive.
cmp bin/install-dispatch-runner.sh "$root/runtime/install-dispatch-runner.sh"
cmp bin/dispatch-runner "$root/runtime/runner-cli"
[[ -x "$root/runtime/install-dispatch-runner.sh" && -x "$root/runtime/runner-cli" ]]
diff -r "$root/original-settings" "$root/settings"

# A recovery record survives an interrupted swap.
cp "$root/original" "$root/runtime/previous"
expect_status 75 recover ""
cp bin/runner-handoff-v1.py "$root/runtime/previous-handoff.py"
run recover ""
cmp "$root/original" "$root/runtime/dispatch"
diff -r "$root/original-settings" "$root/settings"

# A controller serves its own build. The same command installs a clean host
# and later updates it in place; the release is verified as from GitHub.
hosted="$root/hosted"
mkdir -p "$hosted/served" "$hosted/installer home/.local/bin"
printf 'PATH="$HOME/.local/bin:$PATH"\n' > "$hosted/installer home/.bash_profile"
cat > "$hosted/installer home/.local/bin/gh" <<'GH'
#!/bin/sh
set -eu
[ "${USER:-}" = installer ] && [ -f "$HOME/../public.pem" ] || {
  echo "Fixture gh did not inherit the invoking account" >&2
  exit 1
}
stage=$(dirname "$3")
echo "$USER" >> "$HOME/../gh-users"
[ -n "$(find "$stage" -maxdepth 0 -perm 0711 -print)" ]
[ -n "$(find "$3" -perm 0644 -print)" ]
[ -n "$(find "$7" -perm 0644 -print)" ]
openssl dgst -sha256 -verify "$HOME/../public.pem" -signature "$7" "$3"
GH
chmod 0755 "$hosted/installer home/.local/bin/gh"
ln -s "$root/public.pem" "$hosted/public.pem"
printf 'fixture-ca\n' > "$hosted/ca.pem"
serve() {
  rm -f "$hosted/served/"*
  cp "$root/releases/$1/dispatch-runner-linux-"*.tar.gz "$hosted/served/"
  if [[ "${2:-}" != dev ]]; then
    cp "$root/releases/$1/dispatch-runner-linux-"*.sigstore.json "$hosted/served/"
  fi
}
https_source=https://controller.test:7443/api/v1/runner-artifacts/abc1234
http_source=http://controller.test:8080/api/v1/runner-artifacts/abc1234
fixture_root=$hosted
serve v1.0.0
SUDO_USER=installer run apply v1.0.0 x64 --source "$https_source" --cacert "$hosted/ca.pem"
grep -q 'release-new' "$hosted/runtime/dispatch" && exit 1
grep -Fq '"uid": 1000' "$hosted/settings/runner.json"
! grep -q github.com "$hosted/curl"
grep -Fq "$https_source/dispatch-runner-linux-x64.tar.gz.sigstore.json" "$hosted/curl"
grep -Fxq installer "$hosted/gh-users"
if grep -Fq dispatch-runner-linux-arm64 "$hosted/curl"; then exit 1; fi
# An old controller with only an aggregate must fail without requesting it.
mv "$hosted/served/dispatch-runner-linux-x64.tar.gz" "$hosted/served/dispatch-server.tar.gz"
SUDO_USER=installer expect_status 1 apply v1.0.0 x64 --source "$http_source" 2> "$hosted/err"
grep -Fq 'Releases without native runner payloads are unsupported' "$hosted/err"
if grep -Fq dispatch-server.tar.gz "$hosted/curl"; then exit 1; fi
# An enrolled runner keeps its credentials and account across the update.
printf 'enrolled\n' > "$hosted/settings/cert.pem"
serve v1.0.1
SUDO_USER=installer run apply v1.0.1 x64 --source "$https_source" --cacert "$hosted/ca.pem" --user alternate 2> "$hosted/err"
grep -Fq 'Keeping the configured workload account.' "$hosted/err"
grep -q 'release-new x64' "$hosted/runtime/dispatch"
grep -Fq '"uid": 1000' "$hosted/settings/runner.json"
grep -Fxq enrolled "$hosted/settings/cert.pem"
[[ ! -e "$hosted/runtime/previous" ]]
cp "$hosted/runtime/dispatch" "$hosted/current"
# The same build still brings stale maintenance tools up to date.
printf '# stale updater\n' > "$hosted/runtime/install-dispatch-runner.sh"
printf '# stale cli\n' > "$hosted/runtime/runner-cli"
SUDO_USER=installer run apply v1.0.1 x64 --source "$http_source" > "$hosted/out"
grep -Fxq 'Runner already has the requested release.' "$hosted/out"
cmp bin/install-dispatch-runner.sh "$hosted/runtime/install-dispatch-runner.sh"
cmp bin/dispatch-runner "$hosted/runtime/runner-cli"
# Bytes the controller serves still need the release signature.
printf 'tampered\n' >> "$hosted/served/dispatch-runner-linux-x64.tar.gz"
SUDO_USER=installer expect_status 1 apply v1.0.1 x64 --source "$http_source"
cmp "$hosted/current" "$hosted/runtime/dispatch"
# Refuse a downgrade through both entry points, before fetching or stopping.
serve v1.0.0
for action in update apply; do
  SUDO_USER=installer expect_status 1 "$action" v1.0.0 x64 --source "$http_source" 2> "$hosted/err"
  grep -Fq 'Refusing to downgrade Dispatch runner from v1.0.1 to v1.0.0' "$hosted/err"
  cmp "$hosted/current" "$hosted/runtime/dispatch"
done
# A different build at the same version is allowed.
serve v1.0.1
SUDO_USER=installer run apply v1.0.1 arm64 --source "$http_source"
grep -q 'release-new arm64' "$hosted/runtime/dispatch"
cp "$hosted/runtime/dispatch" "$hosted/current"
# A runner installed before version records predates the guard, so it updates
# without the flag and gains a record.
rm "$hosted/runtime/installed-release"
SUDO_USER=installer run apply v1.0.1 x64 --source "$http_source" > "$hosted/out"
grep -Fxq 'Installed runner version is unknown. Replacing it with v1.0.1.' "$hosted/out"
grep -q 'release-new x64' "$hosted/runtime/dispatch"
grep -Fq ' v1.0.1' "$hosted/runtime/installed-release"
cp "$hosted/runtime/dispatch" "$hosted/current"
# A record that cannot be read still needs the flag, until a byte-identical
# verified release identifies the runner.
printf 'unreadable\n' > "$hosted/runtime/installed-release"
SUDO_USER=installer expect_status 1 apply v1.0.1 arm64 --source "$http_source" 2> "$hosted/err"
grep -Fq 'Cannot determine the installed Dispatch runner version' "$hosted/err"
cmp "$hosted/current" "$hosted/runtime/dispatch"
SUDO_USER=installer run apply v1.0.1 x64 --source "$http_source" > "$hosted/out"
grep -Fxq 'Runner already has the requested release.' "$hosted/out"
grep -Fq ' v1.0.1' "$hosted/runtime/installed-release"
# A dev build has no signature. It is refused unless the operator accepts it,
# and then only bytes that match the copied digest are used.
serve v1.0.0 dev
SUDO_USER=installer expect_status 1 apply v1.0.0 x64 --source "$http_source" --allow-downgrade
cmp "$hosted/current" "$hosted/runtime/dispatch"
SUDO_USER=installer expect_status 1 apply v1.0.0 x64 --source "$http_source" --sha256 "$(printf '0%.0s' {1..64})"
digest=$(sha256sum "$hosted/served/dispatch-runner-linux-x64.tar.gz")
digest=${digest%% *}
SUDO_USER=installer expect_status 1 apply v1.0.0 x64 --allow-unverified-dev-build --sha256 "$digest"
SUDO_USER=installer expect_status 1 apply v1.0.0 x64 --source "$http_source" --allow-unverified-dev-build \
  --allow-downgrade --sha256 "$(printf '0%.0s' {1..64})" 2> "$hosted/err"
grep -Fq 'does not match the copied digest' "$hosted/err"
cmp "$hosted/current" "$hosted/runtime/dispatch"
SUDO_USER=installer run apply v1.0.0 x64 --source "$http_source" --allow-unverified-dev-build --allow-downgrade --sha256 "$digest" 2> "$hosted/err"
grep -Fq 'WARNING: This is an unverified dev build of Dispatch' "$hosted/err"
! grep -q 'release-new' "$hosted/runtime/dispatch"
for bad in ftp://controller.test/api/v1/runner-artifacts/abc1234 "$http_source/../x" https://controller.test/other; do
  SUDO_USER=installer expect_status 1 apply v1.0.0 x64 --source "$bad"
done
SUDO_USER=installer expect_status 1 apply v1.0.0 x64 --source "$http_source" --cacert "$hosted/ca.pem"
unset fixture_root

printf 'tampered\n' >> "$root/releases/v1.0.1/dispatch-runner-linux-x64.tar.gz"
expect_status 1 update v1.0.1
cmp "$root/original" "$root/runtime/dispatch"
printf 'Runner installer fixtures passed.\n'
