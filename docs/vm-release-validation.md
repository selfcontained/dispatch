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

| Scenario                   | Purpose                         | Minimum evidence                                                                                                       |
| -------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Fresh Linux install        | Installer and user systemd unit | Healthy `dispatch-server.service`, fixed `ExecStart`, recovery startup gate, channel in `.env`, dedicated new database |
| Fresh macOS install        | Native app and owned service    | Signed arm64 app, healthy owned service/private database, separate state, intended channel                             |
| In-app update on a channel | Published artifact update       | Correct eligible release, verified artifact identity, verified recovery point, successful probation and helper commit  |
| Update with an agent       | Safe activity boundary          | Active work defers installation; idle host quiescence and post-update session behavior match the recovery contract     |
| Failed trial               | Coordinated recovery            | Prior executable/app and database/state restored together, or unresolved recovery fenced with evidence retained        |

Run only the rows relevant to the change. Unit tests do not replace a
service-manager restart. Dispatch 1.x is a fresh install with a new database;
0.x-to-1.x migration is not a supported validation scenario.

## Linux update procedure

1. Start from a disposable Ubuntu VM with a user systemd session. Install a
   published 1.x Preview source release into its own new database. Verify
   recovery enrollment before attempting an update. Record the service unit,
   running version, instance identity and release record.
2. Launch a harmless agent through the service. While it has active work,
   request the newer published Preview release from **Settings → Updates**.
   Verify installation is deferred and the active turn is not interrupted.
3. Once work is idle, retry through the supported flow. Verify the authenticated
   maintenance fence, quiescence and verified recovery point precede activation.
4. After helper probation and commit, confirm:
   - `dispatch-server.service` is active, the instance-matched health endpoint
     reports `ok`, and the running binary is the exact target version;
   - the service keeps its fixed runtime path, recovery startup gate and
     `KillMode=process`;
   - the durable transaction records successful commit and the release record
     reflects the target only after successful readiness;
   - agent session state and stream history are retained and sessions can resume.
     Idle hosts may be quiesced and reconstructed; an unchanged host PID is not
     the protected-update success criterion;
   - the verified recovery material remains available under the supported
     retention policy. An executable `.previous` alone is not a database rollback.
5. Exercise a controlled failed trial on a separate disposable fixture. Verify
   coordinated restoration or a fenced recovery-required state, not a healthy
   binary paired with the wrong database. Retain private evidence without
   exporting credentials.
6. Stop/archive the harmless test agent and verify one final healthy boot.

## Release decision

For installer or updater releases, retain the result matrix with the PR or
release notes. Before stable promotion, run the relevant VM rows and use at
least one real host as a canary when the release changes an existing-install
transition. Separate pre-existing findings from release regressions, but make
an explicit decision about each one rather than silently treating a green
health check as complete evidence.
