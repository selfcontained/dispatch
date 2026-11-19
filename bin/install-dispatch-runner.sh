#!/usr/bin/env bash
# Install and maintain the Linux system service from attested Dispatch releases.
set -euo pipefail

error() { printf 'error: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'USAGE'
Usage:
  install-dispatch-runner.sh install --tag vX.Y.Z
  install-dispatch-runner.sh update --tag vX.Y.Z
  install-dispatch-runner.sh recover

Run as root on Linux with systemd and unified cgroup v2.
Install verifies the release and prepares the runner for the connect command.
Update exits 75 if the runner has workload processes. Retry when idle.
Recover restores the previous binary after an interrupted update.
USAGE
}

release_fetch() {
  local asset="$1" base="https://github.com/selfcontained/dispatch/releases/download/$tag"
  curl -qfsSL --proto '=https' --proto-redir '=https' "$base/$asset" -o "$stage/$asset"
  curl -qfsSL --proto '=https' --proto-redir '=https' "$base/$asset.sigstore.json" -o "$stage/$asset.sigstore.json"
  gh attestation verify "$stage/$asset" --hostname github.com \
    --bundle "$stage/$asset.sigstore.json" --repo selfcontained/dispatch \
    --signer-workflow selfcontained/dispatch/.github/workflows/release.yml
}

stage_release() {
  local archive=dispatch-server.tar.gz member="dist/bun/dispatch-${tag#v}-bun-linux-$arch"
  release_fetch "$archive"
  tar -xOzf "$stage/$archive" "$member" > "$stage/dispatch"
  [[ -s "$stage/dispatch" ]] || error "Missing Linux executable for $tag ($arch)"
}

stable_start() {
  local pid
  systemctl start "$unit" || return 1
  pid=$(systemctl show -p MainPID --value "$unit") || return 1
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
  # Detect startup failure and rapid restart loops. Settings reports connectivity.
  sleep 5
  systemctl is-active --quiet "$unit" &&
    [[ "$pid" == "$(systemctl show -p MainPID --value "$unit")" ]]
}

start_enabled_runner() {
  local enabled
  enabled=$(systemctl is-enabled "$unit") || {
    [[ "$enabled" == disabled ]] && return 0
    return 1
  }
  stable_start
}

# npm's global prefix has a bin/ directory that the workload owns and uses for launch.
engine_commands() {
  local package="$1" command
  printf -v command '{"executable":"npm","args":["install","--global","--prefix","%s","%s@latest"]}' \
    "$state/home/.local" "$package"
  printf '{"install":%s,"update":%s}' "$command" "$command"
}

write_config() {
  local uid gid
  uid=$(id -u "$account")
  gid=$(id -g "$account")
  [[ "$uid" =~ ^[1-9][0-9]*$ && "$gid" =~ ^[1-9][0-9]*$ ]] || error "Invalid workload account"
  cat > "$stage/runner.json" <<CONFIG
{
  "state": "$state/runner",
  "uid": $uid,
  "gid": $gid,
  "home": "$state/home",
  "path": "$state/home/.local/bin:/usr/local/bin:/usr/bin:/bin",
  "bins": {
    "claudeBin": "$state/home/.local/bin/claude",
    "codexBin": "$state/home/.local/bin/codex",
    "opencodeBin": "$state/home/.local/bin/opencode"
  },
  "engines": {
    "claude": $(engine_commands @anthropic-ai/claude-code),
    "codex": $(engine_commands @openai/codex),
    "opencode": $(engine_commands opencode-ai)
  },
  "workspaces": {}
}
CONFIG
  install -m 0600 "$stage/runner.json" "$config"
}

# Replace only the exact prototype unit. Administrator customizations and
# drop-ins keep their usual systemd precedence.
install_service_unit() {
  local replacement
  tar -xOzf "$stage/dispatch-server.tar.gz" bin/dispatch-runner.service > "$stage/$unit"
  [[ -s "$stage/$unit" ]] || error "Missing systemd service template from $tag"
  if [[ -e "$unit_path" ]]; then
    cmp -s "$stage/$unit" "$unit_path" && return 0
    sed 's/^KillMode=process$/KillMode=control-group/' "$stage/$unit" > "$stage/legacy-unit"
    if ! cmp -s "$stage/legacy-unit" "$unit_path"; then
      printf 'Keeping customized %s. Check its KillMode before testing daemon recovery.\n' "$unit_path" >&2
      return 0
    fi
  fi
  replacement=$(mktemp "${unit_path}.XXXXXX")
  if ! install -m 0644 "$stage/$unit" "$replacement" || ! mv -fT "$replacement" "$unit_path"; then
    rm -f -- "$replacement"
    error "Could not install runner unit"
  fi
}

install_runner() {
  local account_entry account_home account_shell
  if [[ -e "$command_path" || -L "$command_path" ]]; then
    [[ -L "$command_path" && "$(readlink "$command_path")" == "$runtime/runner-cli" ]] ||
      error "Another dispatch-runner command already occupies $command_path"
  fi
  if [[ ! -f "$runtime/managed-install" ]]; then
    [[ ! -e "$config" && ! -e "$unit_path" && ! -e "$runtime/dispatch" ]] ||
      error "An unmanaged runner already occupies the install paths"
    ! getent passwd "$account" >/dev/null || error "Workload account $account already exists"
    : > "$runtime/managed-install"
  fi
  if [[ -e "$runtime/dispatch" ]]; then
    cmp -s "$stage/dispatch" "$runtime/dispatch" || error "Use update to change the installed release"
  fi
  if ! getent passwd "$account" >/dev/null; then
    useradd --system --user-group --no-create-home --home-dir "$state/home" \
      --shell /usr/sbin/nologin "$account"
  fi
  account_entry=$(getent passwd "$account")
  IFS=: read -r _ _ _ _ _ account_home account_shell <<< "$account_entry"
  [[ "$account_home" == "$state/home" && "$account_shell" == /usr/sbin/nologin ]] ||
    error "Unexpected workload account configuration"
  install -d -m 0711 "$state"
  if [[ ! -d "$state/home" ]]; then
    install -d -m 0700 -o "$account" -g "$account" "$state/home"
  fi
  if [[ ! -d "$state/runner" ]]; then
    install -d -m 0711 "$state/runner"
  fi
  # The workload needs traversal to ca.pem, while settings and private key stay 0600.
  install -d -m 0711 "$settings"
  if [[ ! -f "$config" ]]; then
    write_config
  fi
  if [[ ! -e "$runtime/dispatch" ]]; then
    install -m 0755 "$stage/dispatch" "$stage/initial"
    mv -fT "$stage/initial" "$runtime/dispatch"
  fi
  install_service_unit
  tar -xOzf "$stage/dispatch-server.tar.gz" bin/install-dispatch-runner.sh > "$stage/updater"
  [[ -s "$stage/updater" ]] || error "Missing updater from $tag"
  chmod 0755 "$stage/updater"
  mv -fT "$stage/updater" "$runtime/install-dispatch-runner.sh"
  tar -xOzf "$stage/dispatch-server.tar.gz" bin/dispatch-runner > "$stage/runner-cli"
  [[ -s "$stage/runner-cli" ]] || error "Missing runner command from $tag"
  chmod 0755 "$stage/runner-cli"
  mv -fT "$stage/runner-cli" "$runtime/runner-cli"
  if [[ ! -L "$command_path" ]]; then
    if [[ ! -d "$(dirname "$command_path")" ]]; then
      install -d -m 0755 "$(dirname "$command_path")"
    fi
    ln -s "$runtime/runner-cli" "$command_path"
  fi
  systemctl daemon-reload
  printf 'Runner installed. Use the connect command from Dispatch Settings to enroll.\n'
}

defer() {
  printf 'Runner update deferred. Retry when the runner has no active sessions.\n' >&2
  exit 75
}

thaw() {
  if [[ "$frozen" == 1 ]]; then
    systemctl thaw "$unit" || return 1
    frozen=0
  fi
}

# Once frozen, the supervisor cannot accept another launch or fork a child
# between the process check and delivery of SIGKILL to its main process.
stop_idle_runner() {
  local cgroup main_pid process_file contents frozen_line
  if ! systemctl is-active --quiet "$unit"; then
    [[ "$(systemctl show -p ActiveState --value "$unit")" =~ ^(inactive|failed)$ ]] || defer
    cgroup=$(systemctl show -p ControlGroup --value "$unit")
    if [[ -n "$cgroup" && -d "$cgroup_root$cgroup" ]]; then
      frozen_line=$(<"$cgroup_root$cgroup/cgroup.events")
      [[ $'\n'"$frozen_line"$'\n' == *$'\npopulated 0\n'* ]] || defer
    fi
    systemctl stop "$unit"
    return
  fi
  frozen=1
  systemctl freeze "$unit" || error "Could not freeze the runner service"
  cgroup=$(systemctl show -p ControlGroup --value "$unit")
  main_pid=$(systemctl show -p MainPID --value "$unit")
  [[ "$cgroup" == /* && "$main_pid" =~ ^[1-9][0-9]*$ ]] || defer
  frozen_line=$(<"$cgroup_root$cgroup/cgroup.events")
  [[ $'\n'"$frozen_line"$'\n' == *$'\nfrozen 1\n'* ]] || defer
  [[ -r "$cgroup_root$cgroup/cgroup.procs" ]] || defer
  find "$cgroup_root$cgroup" -name cgroup.procs -print0 > "$stage/process-files"
  while IFS= read -r -d '' process_file; do
    # cgroup files can report a zero file size despite containing process IDs.
    contents=$(<"$process_file")
    if [[ "$process_file" == "$cgroup_root$cgroup/cgroup.procs" ]]; then
      [[ "$contents" == "$main_pid" ]] || defer
    else
      [[ -z "$contents" ]] || defer
    fi
  done < "$stage/process-files"
  # systemctl stop thaws the unit. Queue the fatal signal before the thaw so
  # that the old supervisor gets no chance to dispatch a launch.
  systemctl kill --kill-whom=main --signal=SIGKILL "$unit"
  systemctl stop "$unit"
  frozen=0
}

recover_runner() {
  # A killed updater may have left its cgroup frozen.
  systemctl thaw "$unit" 2>/dev/null || true
  if [[ -f "$runtime/previous" ]]; then
    stop_idle_runner
    # Keep the recovery record until the restored service passes startup.
    ln "$runtime/previous" "$stage/restore"
    mv -fT "$stage/restore" "$runtime/dispatch"
    sync -f "$runtime"
  fi
  start_enabled_runner || error "Runner recovery could not start. See journalctl -u $unit"
  rm -f -- "$runtime/previous"
  sync -f "$runtime"
}

update_runner() {
  [[ -f "$runtime/managed-install" && -x "$runtime/dispatch" && -f "$config" ]] ||
    error "No managed Dispatch runner is installed"
  if [[ "$action" == recover || -f "$runtime/previous" ]]; then
    recover_runner
    [[ "$action" != recover ]] || return 0
  fi
  stage_release
  if cmp -s "$stage/dispatch" "$runtime/dispatch"; then
    install_service_unit
    systemctl daemon-reload
    printf 'Runner already has the requested release.\n'
    return
  fi
  install -m 0755 "$stage/dispatch" "$stage/next"
  # Record the old inode before any change that could interrupt the service.
  # Create the record only after the idle check, so a deferred update leaves
  # no transaction to recover.
  stop_idle_runner
  ln "$runtime/dispatch" "$runtime/previous"
  sync -f "$runtime"
  mv -fT "$stage/next" "$runtime/dispatch"
  sync -f "$runtime"
  if ! start_enabled_runner; then
    recover_runner
    error "New runner failed to start. Restored the previous release"
  fi
  rm -f -- "$runtime/previous"
  sync -f "$runtime"
  install_service_unit
  systemctl daemon-reload
  printf 'Runner updated to %s.\n' "$tag"
}

cleanup() {
  local status=$?
  thaw || printf 'Could not thaw %s. Run the recovery command.\n' "$unit" >&2
  rm -rf -- "$stage"
  return "$status"
}

main() {
  action=${1:-}
  case "$action" in
    -h|--help) usage; return ;;
    install|update|recover) shift ;;
    *) usage >&2; error "Choose install, update, or recover" ;;
  esac
  if [[ "$action" == recover ]]; then
    [[ $# -eq 0 ]] || error "Recover takes no options"
  else
    [[ $# -eq 2 && "$1" == --tag ]] || error "Supply --tag vX.Y.Z"
    tag=$2
    [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || error "Use an exact release tag (vX.Y.Z)"
  fi
  [[ "$EUID" == 0 && "$(uname -s)" == Linux ]] || error "Run as root on Linux"
  case "$(uname -m)" in
    x86_64) arch=x64 ;;
    aarch64) arch=arm64 ;;
    *) error "Unsupported Linux architecture" ;;
  esac
  cgroup_root=/sys/fs/cgroup
  [[ -r "$cgroup_root/cgroup.controllers" && -d /run/systemd/system ]] ||
    error "The managed runner needs systemd and cgroup v2"
  [[ -x /usr/bin/setpriv ]] || error "Install util-linux with /usr/bin/setpriv"
  if [[ "$action" != recover ]]; then
    for command in curl gh tar ps find git; do
      command -v "$command" >/dev/null || error "Install $command"
    done
  fi
  umask 077
  unit=dispatch-runner.service
  unit_path="/etc/systemd/system/$unit"
  command_path=/usr/local/bin/dispatch-runner
  runtime=/opt/dispatch-runner
  settings=/etc/dispatch-runner
  config="$settings/runner.json"
  state=/var/lib/dispatch-runner
  account=dispatch-runner
  install -d -m 0755 "$runtime"
  exec 9>"$runtime/install.lock"
  flock -n 9 || error "Another runner install or update is running"
  stage=$(mktemp -d "$runtime/.stage.XXXXXX")
  frozen=0
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  if [[ "$action" == install ]]; then
    stage_release
    install_runner
  else
    update_runner
  fi
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
