# macOS Stable and Preview updates

This is how the Dispatch macOS app is delivered, initially **arm64 only**. The app
is `Dispatch.app` with bundle ID `dev.bradharris.dispatch.mac`; see
[macOS app](macos-app.md) for its service, data folder, and processes.
No existing installation is enrolled merely by publishing this workflow.

Download the initial signed/notarized ZIP from an immutable `macos-acp-<run-id>-<attempt>`
prerelease in [selfcontained/dispatch](https://github.com/selfcontained/dispatch/releases).
Quit the existing app before replacing `Dispatch.app`. The dogfood build opts into
Sparkle checks, automatic downloads, and automatic installation. Sparkle and the
native app coordinate installation with the managed service. The app's version
UI identifies its version, numeric build, and `Preview` channel.

The permanent arm64 appcasts are:

- Preview: `https://dispatch.berad.dev/updates/macos/preview/appcast-arm64.xml`
- Stable: `https://dispatch.berad.dev/updates/macos/stable/appcast-arm64.xml`

Preview follows `acp-runtime` during development. Stable is an explicit release,
not a consequence of merging a branch. Both contain the latest build published
**within that channel**; there is no third "latest" channel. The stable feed starts
as a valid empty RSS channel and does not offer a preview as its first release.

The app embeds its channel and corresponding feed at build time. There is no
in-app channel selector yet. Install a build of the desired channel to change
channels; do not downgrade to an older stable build over a newer preview database.
A stable archive is not promoted into Preview because that archive follows the
Stable feed. Preview continues to receive separately built preview releases.

Pre-release installations (bundle ID `dev.bradharris.dispatch.preview`) cannot
update through Sparkle, which refuses a bundle ID change. Install a current build
manually once; its first launch migrates the old service, data folder, and database
([details](macos-app.md#migrating-a-pre-release-install)). The GitHub
`macos-acp-runtime` feed is still published, but only for recovery.

Do not install an x64 build from this workflow: Intel delivery and cross-architecture
validation are not implemented. The workflow builds an arm64 server, Swift app,
and PostgreSQL runtime on the arm64 macOS runner; this is not a universal app and
does not provide a supported Intel/Rosetta runtime path. Separate `appcast-x64.xml` delivery must be added
and tested before enabling it.

## Domain hosting

`apps/update-feeds/wrangler.jsonc` deploys a separate static-assets Worker named
`dispatch-update-feeds` on `dispatch.berad.dev/updates/*`. This narrow route sits
in front of the site's existing custom domain. No website source is deployed by
an app release, and normal site deployments do not overwrite update feeds.
The app ZIPs remain immutable GitHub Release assets.

CI stages **both** channel feeds and deploys them together as one Worker version;
there is no delete/reupload gap on the domain. Cache headers require revalidation.
The publisher verifies the public bytes before changing the old GitHub feed.
The existing `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` secrets are reused
only in the publish job. That token must allow Worker script deployments and
Worker Routes editing on the `berad.dev` zone; successful site deployment alone
does not establish the route permission. Wrangler and the public-URL verification
must succeed before the compatibility bridge advertises the new build.

Recovery feeds remain on GitHub: Preview uses `macos-acp-runtime`; Stable uses
`macos-stable`. A missing stable release bootstraps an empty feed. An existing
release with a missing canonical feed is an error. Every deployment compares
both proposed feeds against the domain and refuses to regress either channel
or change metadata for an equal build. Network/authentication/schema failures
fail closed. All channel publishers share the same workflow concurrency group.

If deployment succeeds but verification or GitHub promotion fails, the domain
may already serve the newer build. Its archive and staged appcast remain on
GitHub. Repair the recovery feed from that retained candidate before publishing
the other channel. Do not roll the domain back. Rerunning the failed channel as
a new attempt can supersede its interrupted publication safely.

## Workflow and credentials

The **macOS Releases** workflow (`.github/workflows/macos-dogfood.yml`) runs on pushes to `acp-runtime` and manual
dispatch. The `channel` input defaults to `preview`. Selecting `stable` requires
an explicit manual dispatch on `main`; both the build job and publisher enforce
this boundary. No stable build is published by source pushes or merges.
Manual Preview dispatch may select a feature branch for initial bootstrap;
this publishes to the same dogfood channel, so select only reviewed code. GitHub
may require the workflow to exist on the default branch before manual dispatch
is available. The temporary feature-branch bootstrap trigger has been removed.
Only `acp-runtime` source pushes automatically publish Preview; merging this work
into `main` will not switch that trigger automatically. Change it to `main` when
that migration is ready. Other branches have no
push trigger. Push triggers are filtered to app/server/web/shared source,
plugins, runtime assets, migrations, dependencies, packaging, and workflow files;
Markdown and documentation-only commits do not trigger builds. Two successive successful source pushes (or a new run attempt) produce
increasing builds for real install/update validation; this workflow does not
provision or modify a VM.

The build job uses read-only repository permissions. Only the publish job has
`contents: write`. Repository secrets are the existing Apple credentials:

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
`DISPATCH_SPARKLE_FEED_URL` (HTTPS required), and `DISPATCH_UPDATE_CHANNEL`
(`preview` or `stable`). Normal builds do not opt into Sparkle
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

Before installation, the app persists the intended running/stopped state and
stops its owned service. If saving or stopping fails, Retry Update Recovery
finishes the same postponed Sparkle installation; it retains the installation
callback and does not start another update cycle. Server and configuration
controls remain locked during this handoff.

After replacement or an aborted installation, restoration requires the exact
service-request acknowledgment and, for a running server, instance-matched
health. Successful restoration clears `app-update-recovery.json` even when the
old app remains installed. `app-update-history.json` retains the attempted target
and prior run state for diagnostics only; later checks and launches never replay
that history. Unresolved restoration retains the pending record for explicit retry.

`CFBundleVersion` is `github.run_id.github.run_attempt`, compared as integers rather
than text. A rerun has a new attempt; an older run cannot replace an equal/newer
live appcast even if GitHub schedules it later. The immutable archive's tag is
`macos-acp-<run-id>-<attempt>`; reusing an existing release is rejected. Preview version releases and the mutable recovery-feed releases are prereleases.
Explicit Stable version releases are not prereleases. All use `--latest=false` so
the existing standalone/Linux "latest release" remains untouched.

All refs share one workflow concurrency group with cancellation disabled. The
publisher checks the live feed before publishing, uploads the immutable archive,
downloads and compares its SHA-256, then stages and verifies the new appcast.
It deploys and verifies both domain feeds first. Only then does it rename the old recovery feed to `appcast-arm64-before-<build>.xml` and
rename the candidate to `appcast-arm64.xml`. Old feeds are retained for recovery.
Lookup/auth/network errors fail closed; a confirmed 404 supports initial release
creation. Failures before promotion leave the live feed untouched.

The compatibility/recovery feed on GitHub still offers **no atomic content replacement**. There is a brief
interval between the two renames when the feed URL can return 404. A failed
promotion attempts to restore the previous canonical name. If GitHub is unavailable
or the process is terminated during these renames, restoration may also fail;
the previous bytes remain in the retained asset. Inspect the assets on
`macos-acp-runtime` and rename the most recently published backup to
`appcast-arm64.xml` before retrying. Do not delete a newer live feed to force an
older build through. A failure after creating an immutable version release should
be retried as a new workflow attempt, never by overwriting its archive.

## Local source tests

Run `python3 scripts/test_macos_feeds.py` for domain/channel separation, preservation,
stale-feed refusal, and bridge failure behavior. Run `python3 scripts/test_macos_dogfood.py` for metadata/schema, integer ordering,
stale-run refusal, initial release, and promotion rollback tests (no external calls).
`node --check scripts/build-macos-app.mjs` and
`node --check scripts/sign-macos-dogfood.mjs` check JavaScript syntax.

## Real product validation — 2026-09-30

The normal app (not `SPARKLE_PROBE`) passed two automatic updates from the public,
persistent-key dogfood feed in a disposable macOS 15.7.7 arm64 VM (2 CPUs, 4 GiB):

| Transition                                        | Result                                                                                                                           |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `36674904540.1` → `36675474533.1`, server running | Automatic download, installation, relaunch, exact-request restoration and same-instance health passed.                           |
| `36675474533.1` → `36675474533.2`, server stopped | Automatic replacement passed; server remained stopped, with no transient PostgreSQL startup. Manual Start afterward was healthy. |

Published builds came from [the initial run](https://github.com/selfcontained/dispatch/actions/runs/36674904540),
[the second build](https://github.com/selfcontained/dispatch/actions/runs/36675474533/attempts/1),
and [its newer attempt](https://github.com/selfcontained/dispatch/actions/runs/36675474533/attempts/2).
All passed Developer ID signing, notarization, stapling, Gatekeeper assessment,
archive signature verification, and publication. Both installed replacements
also passed `codesign --verify --deep --strict` and Gatekeeper inside the VM.

The test used native Save, Start/Stop, startup preference, and menu interactions.
Automatic updates stayed enabled. To avoid waiting for the normal scheduled
interval, it cleared Sparkle's documented `SULastCheckTime` preference before
reopening the GUI. It did not press Check for Updates or Install, change the feed,
inject an updater, or enable proof-only code.

Configuration, database credentials, selected ports/addresses, instance identity,
and the disabled start-at-login preference were preserved. Seeded application
settings, a login-session row, and an agent engine-session record survived both
updates. Pending recovery records cleared only after acknowledgment. JSON object
key ordering can change when Swift rewrites settings; preservation checks compare
values without exporting plaintext credentials. Live in-flight ACP continuity
and interruption/failure scenarios remain covered by the separate notarized proof
in `macos-sparkle-service-proof.md`.

Evidence and native screenshots were exported before cleanup. The guest server
and PostgreSQL were stopped, VNC closed, and the disposable VM deleted. The source
VM remained stopped; the host's installed app and databases were untouched.

Validation also passed 29 Sparkle-enabled native tests with real PostgreSQL,
8 publisher tests, type checks, web finalization, unit suites, and 169 E2E tests
with one worker (8 skipped). PR CI passed on `ae77ab83`.

## Domain feed validation — 2026-09-30

[Build 36772644428.1](https://github.com/selfcontained/dispatch/actions/runs/36772644428)
passed the signing/notarization/stapling pipeline and deployed both domain feeds
using the existing Cloudflare credentials. Preview serves that build; Stable
serves a valid empty feed. Both return XML with cache revalidation headers. A
headless browser loaded each feed and navigated back successfully; screenshots
and HTTP evidence were exported, and the browser was closed.

The public legacy GitHub feed exactly matches Preview. The downloaded ZIP's
Ed25519 signature verifies against the existing public key. Its embedded
`SUFeedURL` points to the domain Preview feed, its channel is `preview`, and its
bundle identity is unchanged. The website homepage bytes are unchanged by feed
deployment. This establishes publication and bridge metadata; no additional VM
or installed-app update was run for this hosting-only change. Earlier native
running/stopped update validation is recorded above.

The hosting change passed 20 focused publisher/domain tests, type checks,
formatting, 169 E2E tests (8 skipped, one worker), and two source reviews.
