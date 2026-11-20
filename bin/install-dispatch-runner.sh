#!/usr/bin/env bash
# Install and maintain the Linux system service from attested Dispatch releases.
set -euo pipefail

error() { printf 'error: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'USAGE'
Usage:
  install-dispatch-runner.sh install --tag vX.Y.Z [--user USER | --dedicated-user]
  install-dispatch-runner.sh update --tag vX.Y.Z
  install-dispatch-runner.sh recover

Run as root on Linux with systemd and unified cgroup v2.
Install verifies the release and prepares the runner for the connect command.
The workload uses SUDO_USER by default. Use --user for another existing
non-root account, or --dedicated-user to create the dispatch-runner account.
Update preserves idle sessions on compatible runners. Exit 75 means retry after the reported activity finishes.
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
  if [[ -f "$runtime/previous" && -f "$runtime/previous-active" ]]; then
    stable_start
    return
  fi
  enabled=$(systemctl is-enabled "$unit") || {
    [[ "$enabled" == disabled ]] && return 0
    return 1
  }
  stable_start
}

# HOME comes from passwd and is inserted into JSON strings.
json_path() {
  local value=$1
  [[ "$value" != *[[:cntrl:]]* ]] || error "Invalid workload home"
  value=${value//\\/\\\\}
  printf '%s' "${value//\"/\\\"}"
}

# The standalone runner doubles as Bun's package installer under the workload UID.
engine_commands() {
  local package="$1" command
  printf -v command '{"executable":"%s/dispatch","args":["add","--global","--trust","%s@latest"],"env":{"BUN_BE_BUN":"1","BUN_INSTALL":"%s/.local"}}' \
    "$runtime" "$package" "$home_json"
  printf '{"install":%s,"update":%s}' "$command" "$command"
}

write_config() {
  local uid=$1 gid=$2 home_json
  home_json=$(json_path "$3")
  cat > "$stage/runner.json" <<CONFIG
{
  "state": "$state/runner",
  "uid": $uid,
  "gid": $gid,
  "home": "$home_json",
  "path": "$home_json/.local/bin:/usr/local/bin:/usr/bin:/bin",
  "bins": {
    "claudeBin": "$home_json/.local/bin/claude",
    "codexBin": "$home_json/.local/bin/codex",
    "opencodeBin": "$home_json/.local/bin/opencode"
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
  local account account_entry uid gid account_home account_shell
  if [[ -e "$command_path" || -L "$command_path" ]]; then
    [[ -L "$command_path" && "$(readlink "$command_path")" == "$runtime/runner-cli" ]] ||
      error "Another dispatch-runner command already occupies $command_path"
  fi
  if [[ ! -f "$runtime/managed-install" ]]; then
    [[ ! -e "$config" && ! -e "$unit_path" && ! -e "$runtime/dispatch" ]] ||
      error "An unmanaged runner already occupies the install paths"
    if [[ "$dedicated" == 1 ]] && getent passwd dispatch-runner >/dev/null; then
      error "Workload account dispatch-runner already exists. Use --user dispatch-runner to select it."
    fi
  fi
  if [[ -e "$runtime/dispatch" ]]; then
    cmp -s "$stage/dispatch" "$runtime/dispatch" || error "Use update to change the installed release"
  fi
  if [[ ! -f "$config" ]]; then
    if [[ "$dedicated" == 1 ]]; then
      account=dispatch-runner
      : > "$runtime/managed-install"
      if ! getent passwd "$account" >/dev/null; then
        useradd --system --user-group --no-create-home --home-dir "$state/home" \
          --shell /usr/sbin/nologin "$account"
      fi
    else
      account=${requested_user:-${SUDO_USER:-}}
      [[ -n "$account" ]] || error "Use sudo as the installing user, or supply --user or --dedicated-user"
    fi
    account_entry=$(getent -- passwd "$account") || error "Workload account $account does not exist"
    IFS=: read -r _ _ uid gid _ account_home account_shell <<< "$account_entry"
    [[ "$uid" =~ ^[1-9][0-9]*$ && "$gid" =~ ^[1-9][0-9]*$ && "$account_home" == /* ]] ||
      error "Invalid workload account or home"
    : > "$runtime/managed-install"
    install -d -m 0711 "$state"
    if [[ "$dedicated" == 1 ]]; then
      [[ "$account_home" == "$state/home" && "$account_shell" == /usr/sbin/nologin ]] ||
        error "Unexpected dedicated workload account configuration"
      if [[ ! -d "$account_home" ]]; then
        install -d -m 0700 -o "$uid" -g "$gid" "$account_home"
      fi
    fi
    if [[ ! -d "$state/runner" ]]; then
      install -d -m 0711 "$state/runner"
    fi
    # The workload needs traversal to ca.pem. Settings and private key stay 0600.
    install -d -m 0711 "$settings"
    write_config "$uid" "$gid" "$account_home"
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
  printf 'Runner update deferred: %s.\n' "${1:-could not verify the service is ready for an update}" >&2
  exit 75
}

thaw() {
  if [[ "$frozen" == 1 ]]; then
    systemctl thaw "$unit" || return 1
    frozen=0
  fi
}

# A verified target opts into the v1 host-binding format by shipping the
# checker. Keep a copy with the rollback record for interrupted maintenance.
preserves_session_processes() {
  local mode stop post
  mode=$(systemctl show -p KillMode --value "$unit") &&
    stop=$(systemctl show -p ExecStop --value "$unit") &&
    post=$(systemctl show -p ExecStopPost --value "$unit") &&
    [[ "$mode" == process && -z "$stop" && -z "$post" ]]
}

check_session_handoff() {
  local pids=$1 main_pid=$2
  [[ -s "$stage/handoff.py" ]] || defer "target release cannot reattach open sessions"
  preserves_session_processes ||
    defer "the service stop policy cannot preserve open sessions"
  command -v python3 >/dev/null || defer "python3 is needed to verify open sessions"
  python3 -I "$stage/handoff.py" "$config" "$pids" "$main_pid" ||
    defer "retry after the reported activity finishes"
}

record_previous() {
  install -m 0600 "$stage/handoff.py" "$runtime/previous-handoff.py"
  ln "$runtime/dispatch" "$runtime/previous"
  sync -f "$runtime"
}

# Once frozen, the supervisor cannot accept another launch or fork a child
# between the process check and delivery of SIGKILL to its main process.
stop_runner_for_update() {
  local before_stop=${1:-:} cgroup main_pid process_file frozen_line
  if ! systemctl is-active --quiet "$unit"; then
    if [[ -f "$runtime/previous" && -s "$runtime/previous-handoff.py" &&
          "$(systemctl show -p SubState --value "$unit")" == auto-restart* ]] &&
       preserves_session_processes; then
      systemctl stop "$unit"
    fi
    [[ "$(systemctl show -p ActiveState --value "$unit")" =~ ^(inactive|failed)$ ]] || defer
    cgroup=$(systemctl show -p ControlGroup --value "$unit")
    if [[ -n "$cgroup" && -d "$cgroup_root$cgroup" ]]; then
      frozen_line=$(<"$cgroup_root$cgroup/cgroup.events")
      if [[ $'\n'"$frozen_line"$'\n' != *$'\npopulated 0\n'* ]]; then
        # KillMode=process leaves the original hosts here when a trial fails.
        [[ -f "$runtime/previous" && -s "$stage/handoff.py" ]] || defer
        # Already inactive. Leave the processes in place for the restored daemon.
        return
      fi
    fi
    "$before_stop"
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
  : > "$stage/service-pids"
  while IFS= read -r -d '' process_file; do
    cat "$process_file" >> "$stage/service-pids"
  done < "$stage/process-files"
  grep -Fxq "$main_pid" "$stage/service-pids" || defer
  if [[ "$(<"$stage/service-pids")" != "$main_pid" ]]; then
    check_session_handoff "$stage/service-pids" "$main_pid"
  fi
  # Keep the daemon stopped across the thaw. Some systemd releases refuse
  # both stop and thaw after a frozen unit's main process has already exited.
  # Probe the option parser without signaling a unit. Older systemctl uses
  # --kill-who, and an actual signal failure must abort the update.
  local target=--kill-whom=main
  if ! systemctl "$target" --version >/dev/null 2>&1; then
    target=--kill-who=main
  fi
  if [[ "$before_stop" == record_previous ]]; then
    touch "$runtime/previous-active"
  fi
  "$before_stop"
  maintenance_step=signal
  paused_target=$target
  systemctl kill "$target" --signal=SIGSTOP "$unit"
  thaw
  systemctl kill "$target" --signal=SIGKILL "$unit"
  paused_target=
  maintenance_step=stop
  systemctl stop "$unit"
  frozen=0
}

recover_runner() {
  # A killed updater may have left its cgroup frozen.
  systemctl thaw "$unit" 2>/dev/null || true
  if [[ -f "$runtime/previous" ]]; then
    if [[ -s "$runtime/previous-handoff.py" ]]; then
      cp "$runtime/previous-handoff.py" "$stage/handoff.py"
    fi
    stop_runner_for_update
    # Keep the recovery record until the restored service passes startup.
    if [[ ! "$runtime/previous" -ef "$runtime/dispatch" ]]; then
      ln "$runtime/previous" "$stage/restore"
      mv -fT "$stage/restore" "$runtime/dispatch"
    fi
    sync -f "$runtime"
  fi
  start_enabled_runner || error "Runner recovery could not start. See journalctl -u $unit"
  rm -f -- "$runtime/previous" "$runtime/previous-handoff.py" "$runtime/previous-active"
  sync -f "$runtime"
}

update_runner() {
  maintenance_step=prepare
  # Keep the original tool error on the runner. Only the bounded status record
  # goes to Dispatch. The lock serializes writers, and tee must not inherit it.
  install -m 0600 /dev/null "$runtime/last-maintenance.log"
  exec 2> >(exec 9>&-; tee "$runtime/last-maintenance.log" >&2)
  [[ -f "$runtime/managed-install" && -x "$runtime/dispatch" && -f "$config" ]] ||
    error "No managed Dispatch runner is installed"
  if [[ "$action" == recover || -f "$runtime/previous" ]]; then
    maintenance_step=restore
    recover_runner
    [[ "$action" != recover ]] || return 0
  fi
  maintenance_step=stage
  stage_release
  if ! tar -xOzf "$stage/dispatch-server.tar.gz" bin/runner-handoff-v1.py > "$stage/handoff.py" 2>/dev/null; then
    : > "$stage/handoff.py"
  fi
  if cmp -s "$stage/dispatch" "$runtime/dispatch"; then
    maintenance_step=unit
    install_service_unit
    systemctl daemon-reload
    printf 'Runner already has the requested release.\n'
    return
  fi
  install -m 0755 "$stage/dispatch" "$stage/next"
  # Record the old inode before any change that could interrupt the service.
  # Create the record only after the idle check, so a deferred update leaves
  # no transaction to recover.
  maintenance_step=stop
  rm -f -- "$runtime/previous-active"
  stop_runner_for_update record_previous
  maintenance_step=replace
  mv -fT "$stage/next" "$runtime/dispatch"
  sync -f "$runtime"
  maintenance_step=start
  if ! start_enabled_runner; then
    maintenance_step=restore
    recover_runner
    maintenance_step=start
    error "New runner failed to start. Restored the previous release"
  fi
  rm -f -- "$runtime/previous" "$runtime/previous-handoff.py" "$runtime/previous-active"
  sync -f "$runtime"
  maintenance_step=unit
  install_service_unit
  systemctl daemon-reload
  printf 'Runner updated to %s.\n' "$tag"
}

cleanup() {
  local status=$?
  thaw || printf 'Could not thaw %s. Run the recovery command.\n' "$unit" >&2
  if [[ -n "${paused_target:-}" ]]; then
    systemctl kill "$paused_target" --signal=SIGCONT "$unit" || :
  fi
  if [[ "${action:-}" == update || "${action:-}" == recover ]]; then
    if [[ "$status" == 0 ]]; then
      rm -f -- "$runtime/last-maintenance-failure.json" || :
    else
      # Persist only the failed step and exit status. Command output can contain
      # credentials. The lock is held until after this atomic replacement.
      if printf '{"step":"%s","exitCode":%d,"at":"%s"}\n' "${maintenance_step:-prepare}" "$status" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$stage/failure.json"; then
        mv -fT "$stage/failure.json" "$runtime/last-maintenance-failure.json" || :
      fi
      printf 'Runner maintenance stopped at step %s (exit %d).\n' "${maintenance_step:-prepare}" "$status" >&2
    fi
  fi
  rm -rf -- "$stage"
  return "$status"
}

parse_install_options() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --user)
        [[ "$dedicated" == 0 && -z "$requested_user" && -n "${2:-}" && "$2" != -* ]] ||
          error "Supply one workload account with --user or --dedicated-user"
        requested_user=$2
        shift 2
        ;;
      --dedicated-user)
        [[ "$dedicated" == 0 && -z "$requested_user" ]] ||
          error "Supply one workload account with --user or --dedicated-user"
        dedicated=1
        shift
        ;;
      *) error "Unknown install option: $1" ;;
    esac
  done
}

main() {
  dedicated=0
  requested_user=
  action=${1:-}
  case "$action" in
    -h|--help) usage; return ;;
    install|update|recover) shift ;;
    *) usage >&2; error "Choose install, update, or recover" ;;
  esac
  if [[ "$action" == recover ]]; then
    [[ $# -eq 0 ]] || error "Recover takes no options"
  else
    [[ $# -ge 2 && "$1" == --tag ]] || error "Supply --tag vX.Y.Z"
    tag=$2
    shift 2
    if [[ "$action" == install ]]; then
      parse_install_options "$@"
    else
      [[ $# -eq 0 ]] || error "Update takes only --tag vX.Y.Z"
    fi
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
