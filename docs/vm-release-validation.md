# Optional VM Release Validation

Use this playbook to validate changes that cross the boundary between a
published Dispatch artifact and a host's service manager. It is intentionally
not part of normal development, CI, or every pull request.

## When to use it

Ask the user before using or provisioning a VM. Propose VM validation when a
change affects one or more of:

- the installer, generated systemd unit, LaunchAgent, or service wrapper;
- release artifacts, checksums, binary activation, or rollback files;
- release channels or release state promotion;
- a release that will be promoted stable after an installation/update change.

Do not use a VM by default for application, API, UI, or ordinary unit-test
changes. If the user approves, state the target platform, scenario, whether an
existing VM will be modified, and cleanup intent before proceeding.

## Test principles

- Validate a **published** release artifact, not a locally built binary.
- Verify the target platform binary against `dist/bun/SHA256SUMS.txt` before
  activation. The checksum detects corruption; GitHub/repository access is
  the trust boundary.
- Exercise the service manager that will own the process. A process started
  from an interactive shell is not equivalent to a systemd or launchd child.
- Record the actual service entrypoint, the process that is running after a
  restart, the release record, health, and rollback asset separately. Do not
  use `release.json` alone as proof of version convergence.
- Keep host-specific paths, credentials, and production services out of the
  fixture. Use a disposable VM and an isolated database/configuration.

## Recommended matrix

| Scenario                   | Purpose                         | Minimum evidence                                                                                 |
| -------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------ |
| Fresh Linux install        | Installer and user systemd unit | Healthy service, fixed `ExecStart`, `KillMode=process`, channel in `.env`, release promoted      |
| Fresh macOS install        | Installer and LaunchAgent       | Healthy service, fixed `ProgramArguments`, log file, initialized state                           |
| In-app update on a channel | Normal artifact update          | Picks the channel's newest release, checksum, atomic replacement, `.previous`, health, promotion |
| Linux update with an agent | Agent survival                  | An agent host inside `dispatch.service` survives the update's restart and the server reattaches  |

Run only the rows relevant to the change. Unit tests do not replace a
service-manager restart.

## Linux update procedure

1. Start from a disposable Ubuntu VM with a user systemd session. Install a
   preview release with `bin/install-dispatch.sh --channel preview --tag
<older tag>` and record the unit file, `MainPID`, `release.json`, and
   health.
2. Launch a harmless agent through the running service (the API or the UI)
   and record its host pid from `~/.dispatch/agents/<agentId>/host.pid`.
   Confirm that pid's cgroup is `dispatch.service`; a host started from a
   shell is not a valid substitute.
3. From **Settings → Updates**, check for updates and apply the newer
   preview release.
4. Confirm all of the following after the restart:
   - the agent host pid is unchanged and alive, the server reattached to it,
     and the agent is `running` with its stream intact;
   - systemd is active and the health endpoint reports `ok`;
   - `ExecStart` invokes the fixed runtime path and the running process
     reports the target version (`X-Dispatch-Version`);
   - `release.json` was promoted by the healthy target binary;
   - `dispatch.previous` exists and is a usable rollback asset.
5. Stop and archive the test agent and verify one final healthy boot.

## Release decision

For installer or updater releases, retain the result matrix with the PR or
release notes. Before stable promotion, run the relevant VM rows and use at
least one real host as a canary when the release changes an existing-install
transition. Separate pre-existing findings from release regressions, but make
an explicit decision about each one rather than silently treating a green
health check as complete evidence.
