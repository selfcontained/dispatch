# Optional VM Release Validation

Use this playbook to validate changes that cross the boundary between a
published Dispatch artifact and a host's service manager. It is intentionally
not part of normal development, CI, or every pull request.

## When to use it

Ask the user before using or provisioning a VM. Propose VM validation when a
change affects one or more of:

- the installer, generated systemd unit, LaunchAgent, or service wrapper;
- release artifacts, checksums, binary activation, or rollback files;
- assisted updates, update migrations, or release state promotion;
- a transition from an old service layout to the fixed runtime path;
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

| Scenario                      | Purpose                         | Minimum evidence                                                                                        |
| ----------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Fresh Linux install           | Installer and user systemd unit | Healthy service, fixed `ExecStart`, initialized release/migration stores                                |
| Fresh macOS install           | Installer and LaunchAgent       | Healthy service, fixed `ProgramArguments`, log file, initialized state                                  |
| Existing fixed-path install   | Normal artifact update          | Checksum, atomic replacement, `.previous`, health, release promotion                                    |
| Existing legacy Linux service | Last-hop migration safety       | Version-pinned symlink/wrapper fixture, fixed-path cutover before restart, actual target binary running |
| Existing legacy macOS service | Bridge behavior                 | Exact target selection; no mtime-based binary choice; launchd recovery path if needed                   |
| Assisted update on Linux      | Agent survival                  | A tmux-backed child inside `dispatch.service` survives the restart after `KillMode=process` is loaded   |

Run only the rows relevant to the change. Fresh installer tests do not replace
legacy-upgrade tests, and unit tests do not replace a service-manager restart.

## Linux assisted-update procedure

This procedure models the failure mode where an assisted-update agent is a
tmux child of the Dispatch user service.

1. Start from a disposable Ubuntu VM with a healthy, supported user unit and
   record its unit file, `MainPID`, current release record, and health result.
2. For a legacy fixture, make `ExecStart` resolve a version-pinned binary or
   symlink. Keep a backup of the fixture unit inside the VM.
3. Download the published target tarball, select the exact platform/arch
   member, reject unexpected archive members, and compare its SHA-256 to the
   tarball manifest.
4. Launch a harmless tmux heartbeat process from within the service cgroup.
   Confirm its cgroup is `dispatch.service`; a shell-launched tmux session is
   not a valid substitute.
5. Apply the migration's pre-restart service changes. For supported systemd
   units this includes `KillMode=process` and `systemctl --user daemon-reload`.
   Confirm the loaded value with:

   ```sh
   systemctl --user show dispatch.service -p KillMode
   ```

6. For a legacy Linux entrypoint, stage the verified target binary on the
   install filesystem, preserve the last healthy executable as
   `dispatch.previous`, create/refresh the fixed runtime path, and repoint
   `ExecStart` **before** the first restart. Do not trust a release record to
   prove the service changed binaries.
7. Perform the update/restart. Confirm all of the following after it returns:
   - the tmux heartbeat advanced and the same session remains available;
   - systemd is active and the health endpoint reports `ok`;
   - `ExecStart` invokes the fixed runtime path;
   - the running process resolves to the expected target binary/version;
   - `release.json` was promoted by the healthy target binary;
   - `dispatch.previous` exists and is a usable rollback asset.

8. Restore a normal fixed-path service definition, remove only temporary test
   wrappers/heartbeat sessions/artifacts, and verify one final healthy boot.

## Release decision

For installer or updater releases, retain the result matrix with the PR or
release notes. Before stable promotion, run the relevant VM rows and use at
least one real host as a canary when the release changes an existing-install
transition. Separate pre-existing findings from release regressions, but make
an explicit decision about each one rather than silently treating a green
health check as complete evidence.
