# Notarized Sparkle + SMAppService proof

This is the next release gate after the signed subprocess spike. It creates
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

## Subsequent gates

Once this passes, use the same fixtures for controlled shutdown/relaunch failure
and interrupted-update testing. Then add a fake ACP engine/live host to verify
host survival and reattachment, followed by compatible/incompatible schema
fixtures. PostgreSQL major-version migration and automatic rollback after a
schema change require explicit designs; restoring only an old app is insufficient.
