# Sparkle feasibility result

## Recommendation

**Proceed with integration into acp-runtime, behind an unconfigured/disabled
production update feed until the remaining release gates pass.** Sparkle's
signed archive installation and relaunch work with Dispatch's real native
supervisor and bundled PostgreSQL. This result supports the architectural
choice; it does not establish production auto-update readiness.

No installed Dispatch app, service registration, or user database was changed
by the probe. Experiments ran sequentially in private temporary directories,
with unique app identities and loopback feed/API/database ports. No VM was used.

## Evidence

Sparkle 2.10.0; Developer ID signed host, framework/helpers, and update archive
contents; temporary Ed25519 key for each experiment. The SDK archive was checked
against its GitHub release SHA256. Signing secrets were not printed or added to
the repository; temporary update signing keys were deleted after each case.

| Scenario                          | Observed result                                                                                                                                                                                                              |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Running server, build 1 → 2       | Sparkle downloaded and verified the archive; the native delegate stopped/reaped the real supervisor and database; Sparkle replaced the bundle and relaunched build 2; matching-instance API health returned.                 |
| Existing database, server stopped | Build 2 relaunched with the server still stopped. Starting it afterward recovered the stored session records. The startup preference stayed unchanged.                                                                       |
| Invalid EdDSA signature           | Sparkle rejected the archive before extraction with error 4005. Build 1 and its server remained running; shutdown was not invoked.                                                                                           |
| Data/settings preservation        | Agent `cli_session_id`, login session row, instance identity, database URL/password, selected network settings, and startup preferences survived. Configuration JSON was compared by decoded value, not serialization order. |
| Cleanup                           | Each successful probe shut down its own supervisor/database. No test service was registered with launchd.                                                                                                                    |

The builds intentionally use the same backend/schema and different native bundle
versions. This demonstrates a compatible application upgrade, not schema or
PostgreSQL major-version migration. Stored agent sessions were checked; no live
provider/ACP host was launched in these experiments.

A first iteration exposed an AppKit quit trap: calling `terminate` from a main
queue signal handler and then scheduling asynchronous work while returning
`terminateLater` stalled cleanup. The harness now cancels that termination
attempt, finishes bounded cleanup, and then requests termination again. For the
actual Sparkle installation callback, cleanup completes before invoking its
installation handler. The completed three-case run uses this corrected path.

## What remains before enabling real automatic updates

1. **Real service registration — high complexity.** This probe runs the actual
   coordinator/worker as owned subprocesses. Prove the same transition with
   SMAppService/launchd, preserving background-item approval and login behavior.
   Avoid leaving an old supervisor alive while the app bundle is replaced.
2. **Notarized distribution — medium complexity.** These local fixtures are
   Developer ID signed, but not notarized. Exercise two notarized/stapled builds
   and an HTTPS feed with the final bundle identity, install location, and CI.
3. **Interrupted/failing upgrade recovery — high complexity.** Exercise failed
   shutdown, termination/download interruption, restart failure, and recovery
   without a working server. Sparkle rollback must not be assumed to roll back
   Dispatch database migrations.
4. **Compatibility decisions — high complexity.** Gate incompatible schema or
   PostgreSQL major upgrades and verify live detached agent-host compatibility.
   Preserve normal user Quit behavior (which intentionally leaves the server
   running); only installation should trigger coordinated shutdown.
5. **Product integration — low/medium complexity.** Add native Check for Updates,
   automatic-update preferences, release channels/feed publishing, increasing
   build numbers, and coherent browser status while keeping one update owner.

Linux can reuse compatibility metadata, migration eligibility, session/health
checks, and recovery requirements. Sparkle-specific replacement and AppKit hooks
are Mac-only.

## Reproducing the isolated experiment

Normal builds have **no Sparkle dependency**. The prototype is enabled only by
`DISPATCH_SPARKLE_PROBE_SDK` at build time and a specially identified probe bundle
with a validated temporary data root. It does not configure the production feed.

Prerequisites: an existing signed `dist/macos/arm64/Dispatch.app`, Python 3,
Swift/CryptoKit, and the local Developer ID signing identity. Obtain the official
Sparkle 2.10.0 release archive, retain it as `sdk.tar.xz` alongside its extracted
contents, and verify:

```text
c2bf58aa8387266ac179357b1415d6f2635f044da8be41042af32425dae6da0c
```

Run each operation sequentially:

```sh
DISPATCH_SPARKLE_PROBE_SDK=/tmp/dispatch-sparkle-sdk \
  swift build --package-path apps/macos --configuration release --jobs 1

python3 scripts/probe-macos-sparkle.py --case running \
  --sdk /tmp/dispatch-sparkle-sdk --identity 'YOUR DEVELOPER ID IDENTITY'
python3 scripts/probe-macos-sparkle.py --case stopped \
  --sdk /tmp/dispatch-sparkle-sdk --identity 'YOUR DEVELOPER ID IDENTITY'
python3 scripts/probe-macos-sparkle.py --case bad-signature \
  --sdk /tmp/dispatch-sparkle-sdk --identity 'YOUR DEVELOPER ID IDENTITY'
```

Each run reports its private test root and writes `result.json`,
`sparkle-events.jsonl`, and HTTP/signing logs. The loopback HTTP exception is
strictly a harness setting; production feeds must use HTTPS. The harness does
not install anything into Applications or register a login/background item.

References: [Sparkle integration](https://sparkle-project.org/documentation/),
[updater lifecycle delegate](https://sparkle-project.org/documentation/api-reference/Protocols/SPUUpdaterDelegate.html),
[automatic update behavior](https://sparkle-project.org/documentation/customization/).

## Repository validation

- Normal (non-Sparkle) native build: 19 tests passed, including real bundled
  PostgreSQL lifecycle checks. Its executable does not link Sparkle.
- `pnpm run check`: passed.
- `pnpm run test:e2e --workers=1`: 167 passed, 6 skipped.
- No web source or backend logic changed for the Sparkle experiment.
- Existing installed app configuration checksum remained unchanged.
