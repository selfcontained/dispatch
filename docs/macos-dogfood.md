# macOS acp-runtime dogfood

This is an opt-in delivery channel for the real Dispatch app, initially **arm64
only**. It keeps `Dispatch.app`, bundle ID `dev.bradharris.dispatch.preview`, the
existing launch service, and existing Dispatch data paths. Installing this app
uses the same service/data as the preview app; it is not an isolated proof fixture.
No existing installation is enrolled merely by publishing this workflow.

Download the initial signed/notarized ZIP from an immutable `macos-acp-<run-id>-<attempt>`
prerelease in [selfcontained/dispatch](https://github.com/selfcontained/dispatch/releases).
Quit the existing app before replacing `Dispatch.app`. The dogfood build opts into
Sparkle checks, automatic downloads, and automatic installation. Sparkle and the
native app coordinate installation with the managed service. The app's version
UI identifies its version, numeric build, and `acp-runtime` channel.

The permanent arm64 appcast is:

`https://github.com/selfcontained/dispatch/releases/download/macos-acp-runtime/appcast-arm64.xml`

Do not install an x64 build from this workflow: Intel delivery and cross-architecture
validation are not implemented. The workflow builds an arm64 server, Swift app,
and PostgreSQL runtime on the arm64 macOS runner; this is not a universal app and
does not provide a supported Intel/Rosetta runtime path. Separate `appcast-x64.xml` delivery must be added
and tested before enabling it. The ordinary preview workflow remains separate.

## Workflow and credentials

`.github/workflows/macos-dogfood.yml` runs on pushes to `acp-runtime` and manual
dispatch. Manual dispatch may select a feature branch for initial bootstrap;
this publishes to the same dogfood channel, so select only reviewed code. GitHub
may require the workflow to exist on the default branch before manual dispatch
is available. For pre-merge bootstrap, an exact push trigger also allows
`agt_e49fa225fda7/agent-25fda7`. Pushes to this named branch publish real product
builds to the permanent dogfood feed, using the same validation and credentials.
Remove that temporary branch trigger after merge. Other feature branches have no
push trigger. Push triggers are filtered to app/server/web/shared source,
plugins, runtime assets, migrations, dependencies, packaging, and workflow files;
Markdown and documentation-only commits do not trigger builds. Two successive successful source pushes (or a new run attempt) produce
increasing builds for real install/update validation; this workflow does not
provision or modify a VM.

The build job uses read-only repository permissions. Only the publish job has
`contents: write`. Repository secrets are the existing preview Apple credentials:

- `APPLE_DEVELOPER_ID_CERT_P12`
- `APPLE_DEVELOPER_ID_CERT_PASSWORD`
- `APPLE_ID`
- `APPLE_NOTARY_PASSWORD`
- `APPLE_TEAM_ID`

Also configure repository variable `MACOS_SPARKLE_PUBLIC_KEY` and persistent secret
`MACOS_SPARKLE_PRIVATE_KEY`. Both are base64: a 32-byte Ed25519 public key and its
32-byte private seed respectively. Keep the seed across builds; do not generate a
new signing identity for every release. The signer derives the public key and
requires an exact match before signing. It writes the seed only into a private
temporary directory and mode-0600 file, removes it in `finally`, suppresses signer
output on errors, and never uploads the key. It verifies Sparkle's signature
against the final archive before producing the feed.

Build controls are `DISPATCH_SPARKLE_SDK`, `DISPATCH_SPARKLE_PUBLIC_KEY`, and
`DISPATCH_SPARKLE_FEED_URL` (HTTPS required). Normal builds do not opt into Sparkle
unless the SDK is supplied. `DISPATCH_SPARKLE_PROBE_SDK` is rejected by production
packaging. The SDK archive is Sparkle **2.10.0**, pinned to SHA-256
`c2bf58aa8387266ac179357b1415d6f2635f044da8be41042af32425dae6da0c`.
CI verifies before extracting; packaging verifies the archive again. Nested
Sparkle XPC services, Autoupdate, Updater.app, and the framework are signed before
the containing app, matching the existing proof's signing order.

Swift tests run with Sparkle enabled and the verified PostgreSQL bundle. CI builds
the server and app, signs nested code, verifies signatures, notarizes, staples,
assesses with Gatekeeper, runs the relocated PostgreSQL smoke test, and signs the
final stapled ZIP before uploading artifacts or publishing. The keychain is
removed even on job failure. Native tests and hosted CI remain required evidence;
local source-only tests do not establish that installation/updating works.

## Publication and recovery

`CFBundleVersion` is `github.run_id.github.run_attempt`, compared as integers rather
than text. A rerun has a new attempt; an older run cannot replace an equal/newer
live appcast even if GitHub schedules it later. The immutable archive's tag is
`macos-acp-<run-id>-<attempt>`; reusing an existing release is rejected. Both version
releases and the mutable `macos-acp-runtime` feed release are prereleases with
`--latest=false`; neither the stable release nor GitHub's latest release is changed.

All refs share one workflow concurrency group with cancellation disabled. The
publisher checks the live feed before publishing, uploads the immutable archive,
downloads and compares its SHA-256, then stages and verifies the new appcast.
Only then does it rename the old feed to `appcast-arm64-before-<build>.xml` and
rename the candidate to `appcast-arm64.xml`. Old feeds are retained for recovery.
Lookup/auth/network errors fail closed; a confirmed 404 supports initial release
creation. Failures before promotion leave the live feed untouched.

GitHub release assets offer **no atomic content replacement**. There is a brief
interval between the two renames when the feed URL can return 404. A failed
promotion attempts to restore the previous canonical name. If GitHub is unavailable
or the process is terminated during these renames, restoration may also fail;
the previous bytes remain in the retained asset. Inspect the assets on
`macos-acp-runtime` and rename the most recently published backup to
`appcast-arm64.xml` before retrying. Do not delete a newer live feed to force an
older build through. A failure after creating an immutable version release should
be retried as a new workflow attempt, never by overwriting its archive.

## Local source tests

Run `python3 scripts/test_macos_dogfood.py` for metadata/schema, integer ordering,
stale-run refusal, initial release, and promotion rollback tests (no external calls).
`node --check scripts/build-macos-app.mjs` and
`node --check scripts/sign-macos-dogfood.mjs` check JavaScript syntax.
