# Native macOS update recovery

The native Sparkle handoff now requires a verified recovery point before invoking
Sparkle's postponed install continuation. Remote check/install control continues
to use the existing Mac bridge. The packaged default scheduled check interval is
four hours (`SUScheduledCheckInterval = 14400`); explicit Sparkle user preferences
still take precedence.

## Ownership and files

`DispatchRecovery` is a separate Swift executable, without AppKit or Sparkle
linkage. Packaging signs it as nested code. Enrollment copies that signed helper
to the private sibling of the instance directory, normally
`~/.dispatch-mac-recovery/DispatchRecovery`, and creates a per-instance user
LaunchAgent in `~/Library/LaunchAgents`. The helper is launched and acknowledged
before the server is stopped. RunAtLoad and a thirty-second launch interval
re-enter unfinished recovery after the menu, server, helper, or login session
ends. No system/root service is installed.

The recovery directory contains the atomic fsynced `journal.json`, transaction
snapshots (`previous.app`, `state`, `manifest.json`), process-identity receipts,
and quarantine evidence. Failed app bundles remain next to the installed app,
with a transaction-specific suffix; failed state remains in the recovery
directory. Snapshots are not pruned automatically. Insufficient capacity blocks
installation rather than deleting recovery evidence.

The helper owns probation, commit, and restoration. Native service and worker
entry points consult the external journal before opening PostgreSQL. Only the
helper's nonce-bearing temporary worker can start while recovery is unfinished.
The helper validates the target's declared recovery protocol before launching
it. Both preparation and probation retain instance-scoped OS leases. An orphaned
worker/menu is stopped only when its saved kernel process start time, executable
path, and transaction identity still match; process-name scans are not used.

## Boundary and server protocol

The common server protocol is authenticated with the existing private Mac app
control token (`Authorization: Dispatch-Recovery <token>`). Native clients
verify the challenge-bound HMAC response. Fence/readiness must report the exact
instance, build, stopped-host capability, and complete Dispatch-owned inventory;
paths outside the private Mac instance root fail closed. External database
configuration also fails closed with an operator-recovery explanation.

A running server passes the authoritative idle fence before any service is
stopped. A previously stopped instance starts a temporary worker in server
probation, which cannot run normal work; its readiness proof establishes the
boundary. The original running/stopped intent is retained. After clean shutdown,
backup takes the full signed app and instance state, including the managed PG17
cluster and credentials. Native UserDefaults are retained as a private preferences
snapshot and reapplied once on rollback, before disabling automatic installation. Special state files and state symlinks are rejected.

Restore verification copies the stopped PG17 cluster, uses the retained app's
PostgreSQL tools, checks clean shutdown with `pg_controldata`, and starts the copy
on a fresh loopback port with private minimal configuration. It checks the actual
`data_directory`, migration history, and a disposable transactional SQL write.
The retained snapshot never runs in place. Tablespace links, standby/recovery
signals, and unexpected externally stored state are outside supported scope.

The worker translates its private native launch capability into the common
`DISPATCH_RECOVERY_PROBATION`, `DISPATCH_RECOVERY_TRANSACTION_ID`,
`DISPATCH_RECOVERY_NONCE`, `DISPATCH_RECOVERY_INSTANCE_ID`, and
`DISPATCH_RECOVERY_EXPECTED_VERSION` environment. Server readiness must complete
migration and disposable database probes while withholding normal reconciliation,
jobs, delivery, and mutating requests.

## Pre-stage protection

Sparkle submits its installer job only after two synchronous delegate calls:
`updater:shouldProceedWithUpdate:updateCheck:error:` (throwing, before download;
`SPUBasicUpdateDriver.m:154`) and `updater:willExtractUpdate:` (void, immediately
before `extractDownloadedUpdate` launches the installer;
`SPUCoreBasedUpdateDriver.m` `extractUpdate:`). The installer's termination
listener starts later still, after extraction and validation.

- After launch the menu keeps one verified snapshot of the running signed app
  for its build in `<recovery>/app-snapshot/` (ditto, digest equal to the live app,
  codesign, durable manifest). This runs off the main thread and never while a
  handoff is active. It costs one app copy on disk and is refused unless free
  space covers two app copies plus a margin.
- In `shouldProceedWithUpdate` (not for information-only checks) the menu runs
  every refusal check and requires the target to be strictly newer than this
  protocol 1 build. It then synchronously moves the snapshot into a new
  transaction, enrolls the helper, fsyncs a `staged` journal (target build,
  Ed25519 identity, snapshot digest, `stagedAt`), and waits up to ten seconds for
  the helper's acknowledgment of that transaction. It holds `transaction.lock` for
  the staged lifetime. Any failure throws, vetoing the update before download.
  Without a ready snapshot it vetoes, builds one, and re-runs a silent check.
  Snapshots are cached per build and digest and survive deferrals.
- `willExtractUpdate` cannot veto. It only checks that a matching `staged` journal
  exists (resumed downloads skip `shouldProceedWithUpdate`). Otherwise it latches
  the extraction as unprotected, and the install hook withdraws the installer.
  Preparation never runs without a matching staged journal.
- **Target capability.** Public Sparkle API exposes no path to the extracted target
  before installation, so the signed release feed declares it. Every protocol 1
  item carries `<dispatch:recoveryProtocol>1</dispatch:recoveryProtocol>`, with
  `xmlns:dispatch="https://dispatch.berad.dev/xml-namespaces/update"`. Sparkle 2.10
  stores unknown item elements under their literal qualified name, as string
  value only (`SUAppcast.m`), so the publisher always uses the `dispatch` prefix.
  The client requires `item.propertiesDictionary["dispatch:recoveryProtocol"] == "1"`.
  It trusts that claim only when its own bundle sets `SURequireSignedFeed`
  (alongside `SUVerifyUpdateBeforeExtraction` and a zero signed-feed failure
  expiration), so that Sparkle rejects unsigned or altered feeds.
  `scripts/macos_appcast.py` emits the element only after verifying the built
  app's `DispatchRecoveryProtocol` = 1 and `CFBundleVersion`. Older entries never
  get it and are refused before download. The baseline is also pinned: the
  running build declares protocol 1, Sparkle refuses downgrades, and staging
  requires a strictly newer target. Every later release
  must keep the protocol 1 startup gate. After an unprotected install, the helper
  still verifies the installed target's signature and protocol and the
  database-open evidence. An unknown or noncompliant target is never assumed to
  have left state untouched: it stays `recoveryRequired`.
- **Startup gate (protocol 1).** In `staged`, only the old build starts ordinarily;
  every other build is fenced. For the old build a staged journal is invisible to
  the menu: SMAppService registration, controls, update checks, and the web
  update state stay normal, and the menu writes no probation acknowledgment. Only
  after the gate admits a start does it durably write
  `<recovery>/database-opened.json` (build, pid, time), before PostgreSQL opens.
  Once its managed cluster runs, it adds the postmaster's identity (pid, kernel
  start time, executable).
  `DispatchRecoveryProtocol = 1` means this gate plus open evidence; protocol 1 is
  first released with this feature, and any change to the gate must bump it.
- A cycle that ends with no installer (skipped, dismissed before install, failed
  download, aborted) proves the installer absent, aborts the staged journal,
  marks the handoff handled, and returns the snapshot to the pool. Normal startup
  and registration are unaffected.
- Preparation continues the staged journal (`staged` → `preparing`) and reuses the
  snapshot after checking it still matches the live app. A deferral, refusal, or
  failure returns the journal to `staged`. Neither the menu nor the helper makes a
  `staged`, `preparing`, or `backedUp` journal terminal while an installer may
  exist: the installer is withdrawn and proven absent first. Deadlines never
  release staged protection. Any such failure returns the journal to `staged` (partial state copies are kept as
  `state-incomplete-*`; a fenced service is restored). Staging is released only
  once Sparkle's installer is proven absent (cycle ended with no installer, a
  proven withdrawal, or relaunch with nothing staged); the snapshot returns to the
  pool. Quit with a staged installer (for example "install on quit") runs the
  protected handoff from the staged journal.
- **Helper, when the menu's lease is free.** `preparing`/`backedUp` without
  activation evidence returns to `staged`. In `staged`: with the old build
  installed, it waits while an installer may exist and releases protection once
  none does. With the target installed (Sparkle installed after the menu died) it
  requires all of the following:
  - a validly signed protocol 1 target;
  - no target open record after `stagedAt`;
  - any live postmaster exactly matching the old build's recorded identity (kernel
    start time and executable, not PID alone);
  - after stopping a fenced target menu, no recorded menu or worker of the
    transaction still alive.

  It then swaps the app back from the verified snapshot through the journaled
  rename (retry-safe, failed target kept once). This is an **interrupted install**,
  not a failed trial: the journal ends `aborted` with `interruptedInstall`. There is
  no quarantine, no preference replay, and automatic updates are unchanged, so the
  same artifact is offered again. State is not modified, because the target never opened it. Any
  missing proof, a damaged snapshot, or an unexpected build leaves
  `recoveryRequired` with everything retained.

## Busy servers, refusals, and Sparkle's staged installer

Sparkle 2.10.0 (verified against the official source at tag `2.10.0`) stages a
user launchd job, `<bundle id>-sparkle-updater`, before it calls
`updater:willInstallUpdateOnQuit:immediateInstallationBlock:` or
`updater:shouldPostponeRelaunchForUpdate:untilInvokingBlock:`. The header states
"Sparkle will always attempt to install the update when the app terminates", and
the source confirms it: `AppInstaller.startInstallation` sets
`_willCompleteInstallation` (so losing the updater connection no longer exits the
installer) and its termination listener runs `finishInstallationAfterHostTermination`
whether or not stage 2 was requested. `SPUCoreBasedUpdateDriver` aborts only
invalidate the connection; the only cancel message (`SPUCancelInstallation`) is
reachable through a user-driver "skip" reply, never from the silent path's
install-only block. Postponing therefore does not prevent an install on Quit,
logout, restart, or crash.

So an update that cannot be protected is **withdrawn**, not held: the menu boots
out `<bundle id>-sparkle-updater` and `-sparkle-progress` (the same labels
Sparkle's own launcher removes before staging) and proves both are absent from
the user and system domains (`launchctl print` exit 113) before releasing the
handoff. Quit, logout, and restart then proceed normally with nothing staged.
If removal cannot be proven (for example a root-domain installer, or an unknown
launchctl failure), termination stays held with the exact `launchctl bootout`
command; Quit remains enabled and retries the handoff each time.

- **Busy deferral.** Only a proof-verified 409 with `BUSY`, `DRAIN_TIMEOUT`,
  `BUSY_AFTER_FENCE`, `HOSTS_NOT_QUIESCED`, or `HOSTS_RUNNING` is a deferral.
  Nothing has been stopped, no turn is interrupted, and it is not a recovery.
  The menu shows "Update waits for agents to finish" and re-runs a silent check
  every five minutes, at most twelve times, then asks for a manual check.
- **Refusals** (external database, missing signed artifact identity, incompatible
  app, quarantined artifact, failed permission preflight, launcher not started)
  withdraw the installation, clear the preactivation handoff, and leave Quit
  usable. Permanent refusals turn automatic downloads off so the update is not
  re-staged; automatic checks stay on, so new releases are still announced.
- **Permission preflight.** Before any lease, fence, or stop, the menu requires
  the app to be user-owned and writable, not translocated, and proves it can
  create, rename, and remove an entry in the app's parent, the data folder's
  parent, and the recovery folder, which must share the data folder's volume.

### Manual operator update (external database)

Automatic protection covers only the managed PostgreSQL 17 cluster. With an
external database, Dispatch refuses automatic installation and turns automatic
installs off. To update:

1. Wait for agents to finish, then choose **Stop Server** from the menu.
2. Back up the external database with your provider's snapshot or
   `pg_dump --format=custom --file=dispatch-<date>.dump "$DATABASE_URL"`, and
   confirm it with `pg_restore --list`.
3. Quit Dispatch. Copy the app and data folder:
   `ditto /Applications/Dispatch.app ~/Dispatch-backup/Dispatch.app` and
   `ditto ~/.dispatch-mac ~/Dispatch-backup/dispatch-mac`.
4. Download the release archive from the Dispatch release page, then verify it:
   `codesign --verify --deep --strict Dispatch.app` and `spctl -a -vv Dispatch.app`.
5. Replace `/Applications/Dispatch.app`, open it, start the server, and check health.
6. To roll back, quit, restore the copied app and data folder, and restore the
   database backup (`pg_restore --clean --if-exists --dbname "$DATABASE_URL" <dump>`).

## Commit and rollback

Activation has a bounded five-minute deadline. Target startup and stable readiness
share a three-minute window, including sixty seconds of continuous authenticated
readiness and a matching live menu acknowledgment. The helper stops its probation
worker before durably committing.

### Service handoff after a terminal decision

Ownership is split by phase. The menu writes `preparing`, `backedUp`, and
`activating`, and can abort only from the first two (`abortPreparation`); the
helper writes every later phase. The legacy `app-update-recovery.json` intent
file still carries the running/stopped intent for the menu's restore; native
completion is recorded only in `service-handoff.json` through `beginHandoff`,
`markHandoffOpened`, and `markHandoffHandled`. There is no separate receipt file.

The helper never writes a service request. On the first tick after `committed`,
`rolledBack`, or `aborted` it durably creates `service-handoff.json` with one
pinned request ID and the original running intent, opens the menu, and only then
records `opened`. A crash between those steps repeats the open, never loses it;
later launchd ticks do nothing, so a user Quit or Stop is never overridden. The
menu restores the SMAppService intent using the pinned ID (a redelivery after a
crash is the same request) and marks the record `handled`; the helper then
removes its LaunchAgent plist and boots itself out. When the menu aborts its own
preparation it records the handoff itself: `handled` if nothing was stopped, or
`opened` (menu-owned delivery) if the service was fenced and must be restored.

If the preparing menu dies, the helper notices promptly: after a fifteen-second
enrollment grace it probes the transaction lease on every tick (the menu holds it
from before enrollment until activation). With the lease free, a `preparing`
journal aborts at once. A `backedUp` journal re-verifies its snapshot digests and
signature; only then, and only with evidence that Sparkle is installing (the
installed build is the target, or the `-sparkle-updater` job is proven present),
it moves to `activating` with a fresh five-minute deadline and the normal
probation/rollback path. Otherwise a staged transaction returns to `staged`
(app-only protection, below), and an unstaged one aborts.

If the menu starts while a journal is unfinished, it waits only until the
journal deadline plus two minutes. It checks the helper's OS lease, kickstarts a
missing helper at most three times ten seconds apart, and then shows an
actionable error (Login Items approval, or the offline `watch` command) with
Retry Update Recovery. Ordinary server starts stay fenced by the journal.

A failed target is stopped, its failed copies are preserved once, and the matching
old app/state are restored through staged, verified, journaled rename operations.
The previous app then passes the same fenced probation. Interrupted rename steps
resume from the journal and filesystem; a contradictory state or failed old-version
readiness leaves `recoveryRequired` and retains every copy. The failed artifact
is quarantined by its Sparkle Ed25519 signature, and automatic updates are disabled on rollback. No automatic
restore is permitted after a committed journal.

Offline inspection is available even if the app cannot launch:

```sh
~/.dispatch-mac-recovery/DispatchRecovery inspect ~/.dispatch-mac
```

`watch` re-enters an unfinished journal; it does not override `recoveryRequired`,
remove quarantine, or authorize post-commit data loss. Operator repair must retain
all copies before modifying an unresolved journal. Exporting the recovery folder
exports credentials and database contents; it is not a public diagnostic bundle.

## Validation and remaining release evidence

Swift tests (including staged gate, veto/proceed, old-app release, app-only restore and re-entry, unproven-target retention, and revert-to-staged fixtures) use temporary directories and ad-hoc signed fixture apps. They cover
snapshot verification, failed-copy preservation, resume across rename gaps,
corrupt backups, writer locks, symlinks, failed restore tests, process identity,
private journals, HMAC interoperability, rejection of post-commit rewind, the
one-shot pinned handoff (crash before `opened`, no tick replay, menu-owned
aborts, retirement), authenticated busy deferral versus forged or unrelated
409s, bounded retries, staged-installer withdrawal and its fail-closed cases
(unremovable, system domain, unknown launchctl failure), the bounded helper wait
and lease probe, and the rollback permission preflight.
An optional PG17 fixture creates and stops a fresh cluster and exercises the real
copy/start/authenticate/SQL/stop restore verifier. It never accesses installed
Dispatch state or a production database.

A successful compile/fixture run does **not** establish macOS signed lifecycle
support. Developer ID/notarization, LaunchAgent background-item approval,
SMAppService unregister/re-register, Sparkle replacement with a dead target menu,
reboot/power loss, and old/new signed release artifacts still require an explicitly
authorized disposable-host or VM lifecycle run. In particular, a first update
from an app that predates this helper/gate cannot retroactively become protected:
that installation needs enrollment into a recovery-capable baseline first.

Remaining failure windows, stated plainly:

- **Resume without staging.** Sparkle resumes a staged installer as soon as it
  starts. Before `startUpdater`, the menu requires this build's staged journal for
  an authenticated protocol 1 target (`declaredProtocol`, created in the veto).
  Otherwise, including when the journal is damaged or belongs to another build,
  it withdraws the installer and proves it absent first. If that cannot be proven,
  the updater stays stopped with the exact `launchctl bootout` command and Retry.
  A dismissed downloaded update, which Sparkle resumes in-process without the
  veto, keeps its staged journal for that resume. What remains: an in-session
  resume whose journal is missing or unreadable at `willExtractUpdate`. That
  extraction is latched as unprotected and withdrawn at the install hook, and
  existing protection is never dropped, but a crash before the withdrawal can
  still install it.
- **Unknown targets.** A target that does not honor protocol 1 cannot be proven
  fenced. The helper refuses app-only rollback (`recoveryRequired`), but such a
  target may already have opened the database.
- **Old processes after a crash install.** The old supervisor and worker keep
  running from the replaced bundle until the helper restores the app (its next
  tick, within about thirty seconds). New worker launches during that time are
  fenced. If preparation had already stopped the service, it stays stopped until
  the menu next runs and restores the intent.
- **Sparkle specifics.** Withdrawal uses Sparkle's staged-job label and the
  hook order verified for Sparkle 2.10.0; a Sparkle upgrade must re-verify both.
- **Snapshot trust.** Staging checks the snapshot's manifest and presence only.
  Its digest and signature are verified before any restore uses it, and a
  damaged snapshot leaves the installed target fenced and requires an operator.

The current native adapter deliberately refuses externally configured state or
databases and does not provide a destructive offline override. It leaves
`recoveryRequired` if it cannot prove all writers stopped. These capability
failures must remain visible as blocked installation, never be bypassed as a
successful backup or silently downgraded to app-only rollback.
