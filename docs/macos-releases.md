# macOS releases and updates

The Mac app ships from the same release as Linux: every `vX.Y.Z` GitHub
release carries `dispatch-server.tar.gz` (Linux and standalone binaries) and
the signed, notarized `dispatch-macos-<build>-arm64.zip`. Builds are **arm64
only**; Intel delivery is not implemented. The app is `Dispatch.app` with bundle
ID `dev.bradharris.dispatch.mac`; see [macOS app](macos-app.md) for its service,
data folder, and processes.

## Channels

One Sparkle appcast lists recent builds:

- `https://dispatch.berad.dev/updates/macos/appcast-arm64.xml`

A new release enters tagged `<sparkle:channel>preview</sparkle:channel>`.
Promoting it removes the tag. The app tells Sparkle which channels it accepts
through `allowedChannels(for:)`: Stable accepts none beyond the untagged
default, Preview accepts `preview`. Sparkle offers the highest eligible build,
so Preview installs also receive promoted releases and nobody is offered a
downgrade. One archive serves both channels; promotion never rebuilds.

The channel is a per-install setting (Settings → Support → Updates, stored as
the `DispatchUpdateChannel` user default). Until someone picks one, the app
follows the build's `DispatchDefaultUpdateChannel` Info.plist value, set from
the repository variable `MACOS_DEFAULT_UPDATE_CHANNEL` (default `stable`). Before the first Stable
promotion, the Stable channel offers no update. Test hosts must explicitly
choose Preview to receive candidate builds; publishing a Preview build does
not make it eligible for Stable.

The retired `/updates/macos/preview/appcast-arm64.xml` compatibility feed is
no longer published. Older builds using it need a manual installation of the
current app. The GitHub `macos-acp-runtime` feed is also retired.

Pre-release installs with bundle ID `dev.bradharris.dispatch.preview` require
manual installation too, since Sparkle refuses a bundle ID change. The current
app's first launch migrates the old service, data folder and database
([details](macos-app.md#migrating-a-pre-release-install)).

Linux uses the same two channels: preview follows every GitHub release,
stable only promoted ones (see the installer's `--channel`).

## Workflows

**Release** (`.github/workflows/release.yml`) runs on a manual dispatch
(bump `patch`/`minor`/`major`, commit, tag `main`) or on a pushed
`vX.Y.Z` tag that points at `main` and matches `package.json`. Manual dispatch
is allowed only from `main`.
It verifies, builds the Bun binaries and the Mac app, smoke-tests both, creates one GitHub **prerelease**
with both assets, and only then adds the Mac build to the appcast on the
preview channel. The Mac build number is `github.run_id.github.run_attempt`;
a rerun of the same release replaces that release's older build.

**Promote Release** (`.github/workflows/promote-release.yml`, main only)
takes a tag, removes its appcast entry's channel tag, then marks the GitHub
release non-prerelease and latest. Settings → Releases → Promote dispatches
it. Rerunning is safe.

Both share the `dispatch-release` concurrency group and never cancel each
other. The appcast is read back from the domain before every change; a
network, auth, or schema failure stops publication, and only a confirmed 404
starts an empty appcast. The publisher refuses a build that is not newer than
everything live, writes the current appcast as one Worker deployment, and verifies
the public bytes afterwards.

## Hosting and credentials

`apps/update-feeds/wrangler.jsonc` deploys a static-assets Worker,
`dispatch-update-feeds`, on `dispatch.berad.dev/updates/*`. Site deployments
never touch it. `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` must allow
Worker deployments and Worker Routes on the `berad.dev` zone.

Signing uses the Apple secrets `APPLE_DEVELOPER_ID_CERT_P12`,
`APPLE_DEVELOPER_ID_CERT_PASSWORD`, `APPLE_ID`, `APPLE_NOTARY_PASSWORD`, and
`APPLE_TEAM_ID`. Sparkle uses repository variable `MACOS_SPARKLE_PUBLIC_KEY`
and secret `MACOS_SPARKLE_PRIVATE_KEY` (base64 Ed25519 public key and 32-byte
seed). Keep the seed across releases. `scripts/sign-macos-archive.mjs` checks
the seed against the public key, signs from a private temporary file, and
verifies the signature before the appcast entry is written.

The Sparkle SDK is **2.10.0**, pinned to SHA-256
`c2bf58aa8387266ac179357b1415d6f2635f044da8be41042af32425dae6da0c` and
verified both in CI and by `scripts/build-macos-app.mjs`.

## Installing an update

Before installation, the app persists the intended running/stopped state and
stops its owned service. If saving or stopping fails, Retry Update Recovery
finishes the same postponed Sparkle installation. After replacement or an
aborted installation, restoration requires the exact service-request
acknowledgment and, for a running server, instance-matched health. Unresolved
restoration retains `app-update-recovery.json` for explicit retry.

## Local tests

- `python3 scripts/test_macos_appcast.py` — appcast schema, channel tagging,
  promotion, removal of retired assets, and publication safety.
- `swift test --package-path apps/macos` — app and core tests; set
  `DISPATCH_SPARKLE_SDK` to compile the Sparkle updater too.

## History

Validation of the pre-1.0 per-channel feeds. The update handoff it exercised is
unchanged; the feed layout it describes has been replaced by the channels above.

### Native update validation — 2026-09-30

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

### Domain feed validation — 2026-09-30

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
