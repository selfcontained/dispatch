# Automatic updates and backup recovery spec

Status: Recovery implementation under review. Linux unattended update scheduling remains a later phase. This document separates the implemented recovery path from the broader automatic-update proposal below.

## Recovery implementation

The storage foundation in `apps/server/src/update-recovery/store.ts` retains private, checksummed recovery points and durable phase journals. It copies regular files without hardlinks, verifies database restoration before sealing, and preserves incomplete evidence. Only the independent helper can reconcile an abandoned storage lock, after proving its instance-wide OS lease.

The Linux driver in `apps/server/src/update-recovery/linux.ts` stages a verified release away from the live executable. Protected targets must declare recovery protocol v1 keyed by their executable SHA256. The package must match the separately fetched GitHub release asset digest before its capability manifest is trusted ([GitHub release API](https://docs.github.com/en/rest/releases/releases)). Missing capability or identity fails before a transaction is created; activation rechecks the pinned executable capability. Candidate promotion metadata is written only after stable readiness. A retained compiled helper runs as a separate systemd transient service under an OS `flock` lease. The permanent user service keeps a direct runtime `ExecStart` and `KillMode=process`, with an independent `ExecStartPre` recovery gate. Interrupted activation queues independent recovery before normal startup; damaged or failed recovery stays fenced. The gate generates a private probation EnvironmentFile before the server starts. Systemd supports generating an EnvironmentFile in a preceding unit state ([systemd execution documentation](https://github.com/systemd/systemd/blob/main/man/systemd.exec.xml)).

Linux admission observes the durable transaction so a busy/aborted helper makes its release job terminal and permits retry. A signed abort clears an in-flight fence when preparation fails; the fence HTTP budget exceeds the bounded server work. Request serialization uses an OS lease tied to the requesting process lifetime, so a crash cannot strand a directory lock. Every probation process exits after five minutes, forcing a lost-helper transaction back through the startup gate.

The PostgreSQL adapter backs up an explicitly enrolled, local, dedicated database with a matching-version custom-format dump and proves a disposable restore. Recovery creates and verifies a new database, persists its pointer, and retains the failed database. Installer-created Linux roles receive CREATEDB capability; supplied databases are not automatically treated as owned. Configurations and durable path overrides outside the inventoried state directory require another adapter. Existing services without the recovery startup gate are rejected before activation; upgrading their service enrollment is a separate operator step.

The server maintenance protocol fences new work, drains admitted mutations, checks authoritative activity owners, stops autonomous writers, and quiesces idle hosts while preserving their database running intent. Busy or unattached hosts defer the update. Trial startup suppresses reconciliation, schedulers, normal writes, and early candidate promotion. Local authenticated readiness responses bind a fresh HMAC challenge to the expected instance, transaction, version, nonce, and database probe.

`coordinator.ts` owns the phase sequence. Both the target and restored previous runtime must pass fenced readiness before normal writes resume. Commit is permanent: a normal-start failure after commit never automatically rewinds data. An automatic restore failure stays recovery-required rather than repeatedly attempting recovery on each service restart. Failed artifact identities are quarantined outside the restored snapshot.

`files.ts` inventories explicitly owned state and reconstructs it in separate staging trees, preserving the first failed tree. Atomic renames and completion markers allow retry after interruption. It rejects linked/special files and overlapping roots. Recovery does not copy or restore unrelated repositories.

Native macOS integration retains the full signed app and the app-owned PostgreSQL cluster, with a separately installed recovery launcher outside the replaceable bundle. Before Sparkle stages an installer, it retains a verified app snapshot and a durable staged journal. The old build can continue running during staging; a replaced target cannot open the database before the full recovery boundary exists. An interrupted staged install can restore only the app when signed target capability and database-open evidence prove state was untouched; otherwise it preserves evidence and requires recovery. Full recovery uses the stopped cluster and durable state snapshot.

Mac target capability is declared in an Ed25519-signed appcast and checked against the released archive's Info.plist. Protocol-aware apps require signed feeds without an unsigned fallback. Legacy entries remain without capabilities during migration, and signed-feed fixtures cover the Sparkle version shipped in existing apps. The publisher's unsigned legacy migration allowance must be disabled after the first signed publication. The web update controls introduced by PR #1184 remain part of the native flow. Sparkle's packaged check cadence defaults to one hour. Signed launch/service lifecycle evidence and remaining limits are recorded in `docs/macos-native-recovery.md`.

Retention currently preserves recovery evidence rather than pruning it automatically. Export, off-host disaster backup, encryption, a general recovery UI, PostgreSQL major upgrades, external/shared database recovery, custom supervisors, and Linux automatic-install scheduling remain outside this implementation. The broader requirements below continue to describe the intended next phases.

## Decision

Keep the existing release formats and service architecture. Linux continues to install the compiled executable from GitHub release tarballs and use its user systemd service. macOS continues to use Sparkle, the signed app bundle, and SMAppService.

Add a durable update transaction, a verified recovery point, and an independent recovery helper. Automatic installation becomes available only when the installation can satisfy the recovery contract. Manual updates use the same protection; a failed unattended update and a failed button-triggered update should be recoverable in the same way.

The user should see either a healthy new version or a healthy previous version, with a clear explanation of what happened. If neither can start safely, keep all recovery material and provide a recovery interface that does not require the Dispatch API to be running.

## Current behavior and gaps

These findings are from the current checkout, rather than assumptions about update libraries.

| Area                   | Existing behavior                                                                                                                                  | Missing recovery guarantee                                                                                                                                                                        |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linux discovery        | Startup check after 45 seconds and recurring checks every six hours; saved Stable/Preview selection                                                | Automatic mode supports only `off` and `check`                                                                                                                                                    |
| Linux installation     | Downloads release artifact, validates its executable checksum, atomically replaces the fixed path, retains `.previous`, restarts systemd           | No independent observer restores the previous executable if the new process fails                                                                                                                 |
| Linux service safety   | Refuses activation unless loaded systemd `KillMode=process` preserves agent hosts                                                                  | This protects hosts; it does not prove that database or host state can be rolled back                                                                                                             |
| Release confirmation   | The newly started server promotes the candidate release record after initialization and listening                                                  | No sustained probation period or write gate; startup already migrates and reconciles state                                                                                                        |
| macOS installation     | Sparkle owns archive verification and bundle replacement; Dispatch saves running intent and stops the service/private database before installation | Dispatch does not retain a coordinated app/database recovery point                                                                                                                                |
| macOS handoff recovery | Replays saved running intent, checks matching service readiness, restores after an installation abort                                              | An updated server that fails readiness leaves recovery pending, stops the service, and asks for Retry Update Recovery; it does not automatically reinstall the old bundle or restore the database |
| Database               | Embedded SQL migrations run during server initialization                                                                                           | No pre-update backup/restore workflow was found in the inspected update paths                                                                                                                     |

Relevant implementation: `apps/server/src/release-auto-check.ts`, `apps/server/src/server/release-runtime.ts`, `apps/server/src/server/release-artifact.ts`, `apps/server/src/release-candidate-store.ts`, `apps/server/src/server.ts`, `apps/server/src/db/migrate.ts`, `apps/macos/Sources/DispatchMenu/AppUpdater.swift`, and `apps/macos/Sources/DispatchCore/UpdateRecovery.swift`.

Sparkle installation abort recovery must not be described as application or database rollback. Dispatch needs to own the application readiness and data recovery contract around Sparkle.

The existing [macOS release documentation](macos-releases.md#installing-an-update) describes pending recovery and explicit retry. The [service proof](macos-sparkle-service-proof.md) also explicitly records that failed new-version startup does not implement rollback.

## User behavior

Linux Updates settings offer Off, Check for updates, and Install automatically. Existing installations remain on Check for updates. Automatic installation respects the selected release channel and never downgrades merely because the channel changes.

Pending updates show why they are waiting: active work, incomplete recovery setup, missing backup capacity, or a release requiring operator action. Install automatically means download in the background and install at the next safe idle point; it never interrupts an active turn to meet a deadline.

Manual Install runs the same backup and recovery transaction. If work is active, offer to install when idle. A failed backup blocks installation, with a concrete reason and retry action. There is no default bypass of recovery protection.

After automatic rollback, show the failed version, restored version, failure reason, recovery-point time, and whether any data was restored. Disable automatic installation pending acknowledgement and quarantine the failed artifact identity. A later release can be selected after acknowledgement; retrying the same artifact requires an explicit action.

Provide recovery history, Open recovery files, Retry recovery, and Export diagnostics. Database/configuration backups are private and excluded from diagnostic exports by default. For Linux these actions also have an offline CLI equivalent. For macOS provide a signed recovery launcher outside the replaceable app bundle.

## Scope and safe installation prerequisites

First release supports the standard Linux user systemd installation and the macOS app with its private managed PostgreSQL cluster. Custom supervisors and externally managed databases can check/download updates, but automatic installation remains unavailable until a tested recovery adapter supports them.

The transaction must acquire an instance-scoped OS lock and enter maintenance mode before the final idle check. Reject new mutating API requests, queue delivery, agent launches, job execution, and background maintenance writes. Wait for in-flight requests and database transactions to settle. Check active turns, queued deliveries, scheduled work, and host activity from their authoritative owners; a stale UI status is insufficient. Never stop a busy agent automatically.

Host journals and database replay cursors must share a documented boundary. The helper records host/journal identities and cursors after flush acknowledgement. An idle host may remain alive only if it can acknowledge a write fence and remain compatible with both versions. Otherwise stop and later reconstruct the idle host through the existing supported lifecycle. If neither is supported, defer the update. `KillMode=process` alone is insufficient to establish this boundary.

The recovery inventory includes resolved configured paths, including files or host state outside the default state directory. It is limited to Dispatch-owned data. User repositories, worktrees, other applications, CLI installations, and unrelated databases are never rolled back.

## Durable transaction and independent helper

Use one private recovery directory per instance, outside the replaceable executable/app and outside the state restored during rollback. Store an atomic journal, transaction ID, old and target artifact identities, instance/database identity, running intent, phase, backup manifest, readiness nonce, deadlines, and errors. Persist phase transitions before the irreversible operation; use flush/fsync and same-filesystem rename where required. Never store credentials in a public journal or log.

Proposed phases: discovered → downloaded → preparing → backed up → activating → probation → committed. Failure transitions to restoring → rolled back, or recovery required. A timeout is a failure, not permission to skip a phase.

The helper is launched and acknowledged before stopping Dispatch. It survives server restart and Sparkle relaunch, and the service manager starts it again after reboot when an unfinished transaction exists. It runs under the installation's user, never requires root by default, and uses fixed argument arrays rather than shell command strings.

The helper must not depend on the target binary, target app, Dispatch routes, or its migrated database. Pin a compatible helper and required backup tools for the transaction. Do not replace the active helper during that transaction. Normal startup checks the transaction journal before opening the production database, applying migrations, reconciling agents, or starting schedulers.

Only one component owns commit/restore decisions. Existing release candidate promotion and macOS handoff recovery become participants in this transaction; they must not independently mark an update successful.

The service startup gate must work even when the previous binary lacks transaction support. Place that gate in the independent service/helper entry point, and verify it before enrolling an existing installation. A prerequisite enrollment step installs the helper and service integration and establishes a baseline recovery point without changing the running app. Never claim that the first protected update can recover solely through code shipped in its target version.

## Recovery point contents

Before activation, retain:

1. The exact running Linux executable, or complete previous signed macOS app bundle, with identity and checksum verification. Preserve permission and signing requirements.
2. A PostgreSQL backup including schema, rows, sequences, large objects, and migration history; record server/tool versions and necessary extensions/role prerequisites.
3. Dispatch-owned durable settings, credentials, release/migration records, uploaded/shared files, host journals and replay metadata, and any other mutable store discovered by the inventory.
4. A private manifest connecting all of these to the same write-fenced recovery boundary, with paths, sizes, hashes, identities, and verification results.

Backups live outside paths that installation or restoration can overwrite. Use private directories/files, reject unexpected symlinks, and ensure disk capacity before starting. A partially written backup never counts as a recovery point.

For Linux, use a complete custom-format `pg_dump` of the dedicated Dispatch database while Dispatch writers are fenced. Use matching supported `pg_dump`/`pg_restore` tools. Before activation, restore the dump into a disposable validation database and verify migration history and representative integrity checks; merely listing an archive or hashing it does not establish restorability. Lack of privileges/capacity for this test blocks unattended installation.

For the macOS private cluster, use a complete physical copy after verified clean shutdown, paired with the previous bundle's PostgreSQL binaries. This covers cluster-level objects without requiring a remote database administrator. Restore-test a copy on an isolated loopback port/data path before activation. Never copy a live data directory as an ordinary filesystem backup. PostgreSQL documents the constraints for [filesystem backups](https://www.postgresql.org/docs/current/backup-file.html); logical backup tooling is described in [pg_dump](https://www.postgresql.org/docs/current/app-pgdump.html) and [pg_restore](https://www.postgresql.org/docs/current/app-pgrestore.html).

Validate the complete recovery point before activation. If backup, verification, tool compatibility, permission, or capacity checks fail, return to the old healthy installation without replacing it.

## Activation and health confirmation

Verify the target before changing the live installation. Linux currently uses checksums shipped inside the same tarball, which detect corruption but are not independent publisher authentication. Add signed Linux artifact metadata with a pinned verification key before enabling unattended installation; retain Sparkle's existing signature verification on macOS.

Use the existing Linux atomic replacement and Sparkle installation paths. Persist the recovery journal before either handoff. The new version starts in maintenance/probation mode. It may apply migrations and perform explicitly checked startup reconciliation, but must not admit user writes, dispatch prompts, run jobs, or resume autonomous work before commit.

The independent helper verifies expected instance, artifact version/build, transaction nonce, authenticated database connectivity, completed migrations, essential read/write operations using disposable records, file access, and host compatibility. A listener or HTTP 200 from another process is insufficient. Probe operations must be bounded and must not trigger real agents or user-visible events.

Proposed defaults: up to 120 seconds for ordinary startup/migrations, followed by 60 seconds of stable readiness. Releases requiring longer migrations declare a bounded timeout and measured justification. Backup/restore timeouts are separate and size-aware. Do not silently extend failed health checks indefinitely.

Persist the committed state before releasing maintenance mode. Then promote version records, enable ordinary writes/schedulers, and notify the user. Preserve the previous running/stopped intent on macOS; if it was stopped, temporary private readiness testing must finish with it stopped again. Offline recovery remains available even if the menu app itself never launches.

## Failure and restoration rules

| Failure                                                         | Required result                                                                                                                      |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Download, signature, preflight, or backup fails                 | Keep old installation running; remove only owned staging material                                                                    |
| Activation aborts with old version intact                       | Restore prior running intent, verify old readiness, close transaction as aborted                                                     |
| New version crashes, hangs, fails migration, or fails probation | Stop/fence target and its writers; preserve failed state; restore the matching recovery point and previous version; verify readiness |
| Helper or machine crashes mid-transaction                       | Resume from journal and actual identities; repeat only idempotent operations; never infer success from a stale candidate record      |
| Recovery backup is invalid or restoration fails                 | Keep maintenance gate closed, retain all copies, expose offline recovery instructions; no restart loop                               |
| Regression after commit                                         | Preserve current data and offer guided recovery; do not silently rewind accepted work                                                |

Before restoring, prove that no target process, host writer, scheduler, or unrelated client can mutate the recovery target. If this cannot be established, stop and require operator recovery.

For Linux logical restoration, restore into a new dedicated database, verify it, then switch private configuration to that database and restore the old runtime/state while the startup/write gate remains closed. Each file switch uses atomic replacement; the journal coordinates the multi-step operation, rather than assuming a single atomic operation across databases and files. Preserve the failed database; do not drop it or overwrite shared databases. The installer needs to provision and verify the necessary narrowly scoped recovery capability. If it cannot, installation cannot claim automatic data rollback support.

For the macOS owned cluster, retain the failed cluster separately, restore into a staging directory, verify it with old PostgreSQL binaries, then switch while all database/service writers are stopped. Never allow both clusters to run with the same instance identity.

Restore Dispatch state files and replay cursors to the matching boundary. Preserve failed journals separately; do not merge or replay post-boundary data automatically. Never restore unrelated repositories. Do not run down migrations as a substitute for restoring the proven backup.

Verify the previous version with the same instance/readiness checks. Attempt automatic rollback once per transaction; if it fails, retain recovery required. Quarantine the target using artifact identity, not only a version string, and persist that quarantine outside the restored snapshot.

Automatic data restoration is allowed only before commit, while normal writes have remained fenced. After commit, recovery may discard newer accepted work: show the recovery point time and consequences and require explicit user approval. Always preserve the current data first. Binary-only recovery after commit is allowed only when compatibility with the current schema, files, and host protocol has been explicitly established.

## Retention and limitations

Retain at least the most recent committed recovery point and every unresolved transaction. Proposed default: the last three successful recovery points, with a configurable storage budget. Never prune the last usable point or unresolved evidence to make a new update fit; pause installation instead. Provide inspection and explicit deletion controls.

These are local update recovery points, not disaster recovery backups. They do not protect against loss of the disk or host. Export/off-host backup can build on the same manifest later. Encryption using a recoverable OS-backed key is a follow-up; restrictive permissions and exclusion from telemetry are required initially.

PostgreSQL major upgrades, custom supervisors, shared/external databases, irreversible external effects, and agent-host protocol transitions without rollback compatibility are outside unattended scope. Missing compatibility metadata means manual/operator-required, not implicitly safe. External database recovery needs its own adapter and explicit ownership/restore policy; the presence of a database URL does not authorize replacing that database.

## Delivery order

1. Build the journal, independent helper, backup inventory, restore verification, and offline recovery interface. Exercise them with manual Linux updates first. Add the startup write gate and replace early candidate promotion with helper-owned commit.
2. Integrate the same recovery contract around Sparkle and SMAppService, including a retained signed app and a recovery launcher independent of the target app. Existing handoff intent becomes part of the durable journal.
3. Add signed Linux metadata, capability detection, release recovery eligibility, and opt-in automatic installation. Reuse the existing scheduler, channels, job progress, and Updates UI.
4. Add external/custom adapters only after their recovery paths pass the same failure tests.

Do not enable unattended installation before recovery is proven. Improving manual-update recovery is independently useful and is the first deliverable.

## Acceptance and failure injection

Test Linux x64/arm64 and macOS Apple Silicon/Intel where supported. Use isolated databases and state; never run destructive recovery tests against a live installation.

- Manual and automatic updates pass through the same transaction; both preserve representative agents, sessions, settings, files, migration history, and credentials.
- An active turn or queued delivery defers installation; new work racing the idle check is rejected or safely deferred after maintenance admission closes.
- A missing tool, insufficient disk, failed backup restore test, or invalid signature prevents activation and leaves the old instance usable.
- Crash/power-loss injection at each persisted phase resumes safely after helper/machine restart, including the gap between rename and journal persistence.
- Inject startup crash, hang, incorrect instance identity, migration failure after schema changes, and probation failure. Verify previous version and data recovery, with no lost pre-boundary records or duplicate journal replay.
- Simulate death of the new menu app and API. Independent recovery still runs; do not rely on clicking a recovery button in the broken app.
- Verify Sparkle abort before/after service stop, stopped-server intent, service-registration approval requirements, and recovery of an app that never relaunches.
- Verify rollback interruption, damaged backups, and failure of old-version readiness produce recoverable evidence and no repeated automatic attempts.
- Verify a post-commit restore requires approval, preserves current data, and states potential loss of newer work.
- Prove backup restoration in release CI with seeded databases/files and old/new artifacts. Schema/file/host compatibility metadata is a release gate, with missing metadata excluded from automatic installation.
- Validate Updates and recovery UI through Playwright interactions and attached screenshots; close the browser afterward. Run repository type/build/E2E checks and backend unit tests as required during implementation.
- OS service-manager and signed-bundle recovery need explicitly approved VM/disposable-host validation under the repository's VM rules. Ordinary code changes do not authorize provisioning or using a VM.

## Decisions to confirm before implementation

Recommended defaults in this draft are opt-in Linux automatic installation; idle-only updates; full pre-update recovery points; one automatic rollback attempt; write-fenced probation; and no silent database rewind after commit.

The implementation spike must prove Linux database restore privileges, host write fencing/reconstruction, macOS signed recovery-helper placement and service approval behavior, and realistic backup/probation timing. Failure to prove one capability disables automatic installation for that setup. These are bounded feasibility gates within the current architecture, not a request to replace the application architecture.
