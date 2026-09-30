# Notarized Sparkle + SMAppService proof

The running/stopped release gate passed on macOS 15.7.7 with build b724e87c
(CI run 36660502739). This harness creates
**test-only CI artifacts**, not a Dispatch release, and does not enable updates
in the installed product.

## What is built

The `macOS Sparkle Service Proof` workflow produces:

- `initial.zip`: Developer ID signed, notarized, stapled build 1.
- `update.zip`: the same isolated app identity, build 2, also notarized/stapled.
- `appcast.xml`: HTTPS loopback feed, with the update's Ed25519 signature.
- `proof.json`: exact bundle/service identity, data root, ports, and checksums.
- `validate.py` and `sparkle_proof_cleanup.py`: a driver and cleanup helper for an explicitly approved disposable Mac.

The workflow reuses the repository's existing Apple signing/notarization secrets.
It generates a temporary Sparkle key for the pair and destroys the private key;
only the public key and archive signature leave the runner. Nothing is published
to a public release feed. Normal app builds remain independent of Sparkle.

Only the proof workflow auto-runs on this feature branch's proof changes. The
older menu preview workflow is manual, avoiding duplicate signing jobs.

## Isolation and lifecycle

The app uses a unique `dev.bradharris.dispatch.sparkleprobe.service…` bundle ID
and matching `.server` LaunchAgent. It cannot register the background item until
the test driver creates an explicit approval marker matching that identity. Its
installation name begins `Dispatch Sparkle Proof`, and its state lives in a
uniquely named private directory under `/tmp`. It never targets the real Dispatch
bundle, service label, API port 6767, or user database.

This time the real coordinator is launched by **SMAppService/launchd**. Before
Sparkle installs, the delegate durably records whether the server was running,
unregisters the test service, and waits for shutdown. The new app registers its
service again and restores the recorded state independently of login preference.
It requires the replacement coordinator to acknowledge the exact restore request
and expected phase, plus matching-instance API health when running, before recording
upgrade confirmation. The driver verifies this acknowledgment before issuing another request. An installation abort after shutdown attempts to restore
the old service. Failed new-version startup does not yet implement rollback.

## Running on an approved disposable Mac

The Mac needs a logged-in GUI user, Python 3, and Apple command-line tools. Do not
run this on a working installation as an ad-hoc test. Repository instructions
require user approval before using a VM.

Download the CI artifact, extract it, and run one case at a time from Terminal
in the logged-in desktop session. An SSH-only launch cannot authorize user trust
changes. Approve the temporary certificate trust prompts during setup and cleanup:

```sh
python3 validate.py --case running --allow-machine-changes
python3 validate.py --case stopped --allow-machine-changes
```

The driver explicitly changes this test environment:

1. Installs only the uniquely named proof app in Applications.
2. Adds a temporary **user-trusted** localhost TLS certificate and hosts the feed
   on HTTPS port 58443; the proof API uses 56789 and its private DB a free port.
3. Opens the app. If macOS asks for background permission, approve only the
   uniquely named Dispatch Sparkle Proof item in System Settings.
4. Seeds login/agent-session records and exercises the actual Sparkle upgrade.
5. Verifies the old launchd PID is gone, a new launchd PID runs the installed
   bundle, build 2 passes signature/staple/Gatekeeper checks, approval was not
   requested again, and state/data survived. The stopped case starts/stops the
   service afterward to verify its existing database remained usable.
6. Unregisters the test service, stops the private database/feed, removes the
   app and temporary certificate trust, and preserves evidence. Failed cleanup
   is a failure, not a successful result.

Evidence is written beside the artifacts under `evidence/`. Review `result.json`,
`lifecycle.json`, `sparkle-events.jsonl`, and `commands.log`. The lifecycle result
is provisional; the overall verdict is finalized only after service, database,
and certificate/trust cleanup have been checked. Cleanup failures retain recovery
material and produce a failed overall verdict. Data/configuration with passwords is
not copied into the evidence folder. Failed tests may retain their private data
root for diagnosis; do not retry over it without explicit cleanup.

## Proposed VM exercise

After the two notarized artifacts exist, request approval to clone an existing
macOS VM into a disposable test VM, run only that VM with 2 CPUs and 4 GiB memory,
and execute the running/stopped cases. The VM will receive a test app,
background-item approval, private database, and temporary localhost certificate.
Export the evidence, then stop/delete only the disposable clone. Preserve the
source VM. If no usable base image exists, report that before downloading one.

The first disposable-VM attempt used the notarized artifacts from CI run 36648062365. The initial app passed staple validation and Gatekeeper. Fresh
service status returned `notFound` (BTM had no registration record), exposing a
probe startup condition that waited instead of registering. No update completed.
The startup condition now treats both `notFound` and `notRegistered` as requiring
registration, including the normal menu app's first launch. A regression covers
all four documented statuses.

The failed run's diagnostics were exported, and the disposable clone was stopped
and deleted. The source VM remains stopped and unchanged. Certificate cleanup
required a desktop authorization prompt; teardown ultimately removed the entire
clone, so this attempt does not establish successful in-guest cleanup. The next
artifact pair still needs the full running/stopped update and cleanup proof.

## Second VM run: notarized build 7544f9c7

CI run 36657837007 produced the next signed/notarized pair. On macOS 15.7.7:

- **Running update passed**, including replacement launchd PID, exact restore
  acknowledgment, health, unchanged settings/credentials, preserved login and
  agent-session records, and verified service/database/certificate cleanup.
- **Stopped update did not pass the complete gate.** It installed build 2,
  acknowledged stopped state, and preserved the database records. The exact
  settings check caught a changed private DB port. Logs also exposed a brief
  database start before the stopped request reached the replacement coordinator.
- Both cases verified signatures, staples, and Gatekeeper on both versions and
  required no renewed background-item approval. Certificate trust prompts belong
  to this localhost test feed, not the product update experience.

The fixes now queue restore intent before registration, refresh it while awaiting
approval, and match PostgreSQL's SO_REUSEADDR behavior when checking a saved port.
Restore refreshes retain one logical request ID: a coordinator that reads the old
file before removing its replacement can still acknowledge that same intent.
A deterministic read/write/remove interleaving regression covers both states.
A real TCP TIME_WAIT regression failed before the socket fix and passes afterward;
the occupied-listener recovery test still passes. The driver now also rejects any
transient PostgreSQL start during a stopped upgrade. The exact settings assertion
is retained. These changes need another notarized VM run.

The second clone was stopped/deleted after exporting evidence. No VM is left
running; the original source VM remains preserved.

## Third VM run: notarized build b724e87c

CI run [36660502739](https://github.com/selfcontained/dispatch/actions/runs/36660502739)
produced the reviewed fixes. Both full cases passed on a fresh macOS 15.7.7 clone
limited to 2 CPUs and 4 GiB RAM:

| Assertion                                                                             | Running | Stopped |
| ------------------------------------------------------------------------------------- | ------- | ------- |
| Sparkle installs notarized build 2                                                    | Passed  | Passed  |
| Replacement launchd coordinator acknowledges restore                                  | Passed  | Passed  |
| Settings, database credentials/port, login and stored agent-session records preserved | Passed  | Passed  |
| No renewed background-item approval                                                   | Passed  | Passed  |
| Server remains stopped without transient PostgreSQL startup                           | N/A     | Passed  |
| Service, database, feed and temporary certificate cleanup                             | Passed  | Passed  |

The old/new coordinator PIDs were 984/1046 (running) and 1294/1348 (stopped).
Both versions passed staple validation and Gatekeeper. Both final result files
report `result: passed` and empty `cleanupErrors`; evidence was exported before
stopping and deleting the clone. The source VM was preserved and no VM remains
running. The localhost certificate setup/removal prompts are test infrastructure;
no production certificate trust or Dispatch installation was modified.

This establishes the normal signed update/service handoff, not unattended
production rollout, live ACP-host continuity, or schema rollback. The normal
Dispatch app still has no enabled Sparkle feed. Local validation also passed
23 native tests, the probe build, type checks, 168 E2E tests (5 skipped, one worker),
and the cleanup helper's five test methods.

## Subsequent gates

Next, use the same fixtures for controlled shutdown/relaunch failure
and interrupted-update testing. Then add a fake ACP engine/live host to verify
host survival and reattachment, followed by compatible/incompatible schema
fixtures. PostgreSQL major-version migration and automatic rollback after a
schema change require explicit designs; restoring only an old app is insufficient.

## Interrupted installation recovery

The driver accepts `--case interrupted-running` and `--case interrupted-stopped`.
These pause the isolated probe after durable intent is saved and its service
and database have stopped, before invoking Sparkle's immediate-install handler.
The driver verifies the owned GUI executable before killing that one process.
It waits for Sparkle to finish installing build 2, verifies the bundle, then opens
the app (reusing any existing instance). The replacement must acknowledge its
exact restore request and preserve the original running/stopped intent, settings,
and database records. The stopped case rejects even transient database starts.

The first interruption attempt (CI 36661962465, build 297be3bf) exposed an invalid
test assumption: the old app need not remain installed after a crash. Sparkle
installed build 2 while the driver immediately relaunched build 1. The test was
interrupted, evidence exported, and the clone deleted. It did not pass the
recovery gate or complete verified in-guest certificate cleanup; deleting the
clone removed all temporary trust and processes.

[The Sparkle delegate contract](https://sparkle-project.org/documentation/api-reference/Protocols/SPUUpdaterDelegate.html)
explicitly allows installation on application termination even if the immediate
handler has not been invoked. The corrected driver waits for that installation
instead of racing it. This also means the immediate handler is not an exclusive
installation gate; durable recovery state must already exist before app exit.

This tests only the selected crash boundary. It does
not establish power-loss recovery during bundle replacement, automatic relaunch,
old-version retry, new-version health rollback, or live agent continuity. The
pause marker is compiled only into the isolated proof, never normal Dispatch.

### Corrected interruption results: build 765444af

Both interrupted cases passed using the notarized pair from
[CI 36663232141](https://github.com/selfcontained/dispatch/actions/runs/36663232141)
on macOS 15.7.7 in one 2-CPU/4-GiB clone:

- Running: killed GUI 1175, recovered build-2 GUI 1245; coordinator 1176 → 1246.
- Stopped: killed GUI 1524, recovered build-2 GUI 1581; coordinator 1525 → 1582.
- Both installed after forced exit without the explicit install handler, restored
  the exact requested phase, cleared pending intent only after readiness, and
  preserved settings/credentials/port/login/stored agent-session records.
- The stopped case had no transient PostgreSQL start. Neither case needed renewed
  background-item approval. Both passed signatures, staples and Gatekeeper.
- Both final results report `passed` with no cleanup errors. Evidence was exported,
  the clone stopped/deleted, and the original VM preserved. No VM remains running.

Remaining work includes live ACP-host survival/reattachment, earlier-crash and
power-loss boundaries, failed-target startup/migration policy, and product feed,
key custody and update UI integration. These results do not enable product updates.

## Live ACP continuity (pending notarized proof)

`--case live-agent` starts one agent using a stdlib-only fake ACP engine. The
engine holds its turn until the driver releases a marker after the Sparkle
upgrade. The test requires identical host/engine PIDs and process start identities,
a preserved engine session, the original turn's successful result in the new
server's stream, and a successful follow-up through that same host/engine.

The native override is guarded by `SPARKLE_PROBE`, the unique proof bundle/root,
and a live-case marker. No production adapter configuration changes. The helper
and fake engine are test artifacts copied to the isolated root; no model, real
agent CLI, or paid provider is used. The final cleanup archives the test agent and
checks owned process exit before removing the service/database; when the API is
unavailable, only verified owned host/engine PIDs are signaled, never a process group.
This case retains the standard settings, signature, session and cleanup gates.
