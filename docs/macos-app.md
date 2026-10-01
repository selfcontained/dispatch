# macOS app

Dispatch for macOS 13+ is a menu bar app. It bundles the same Bun server used by
the binary release, a private PostgreSQL 17 cluster, and Sparkle for updates, and
opens the web app in the default browser. There is no embedded webview. Linux
installation and release artifacts are unchanged. Release channels, feeds, and
publishing are described in [macOS Releases](macos-dogfood.md).

## What ships

- **Open Dispatch** uses the system default browser. The menu and Settings
  provide a copy action for the server address.
- **Settings → General** shows status and Start/Stop controls below Startup. Select one or more
  local IP addresses in **Network** and choose a web port (6768 by default).
  Settings remain editable while running; **Save** does not start or restart
  the server. Saved changes apply on the next start, while the displayed address
  continues to describe the running instance.
- **Settings → Database** defaults to a private PostgreSQL database managed by
  Dispatch. An external database can be configured there. Passwords are not
  displayed; **Copy Connection URL** includes credentials. Port 6767 and database
  names `dispatch` and `postgres` are reserved for a standalone installation.
- **Settings → General** has independent preferences for showing the menu bar app and
  starting the server at login. Changing either does not start/stop the server.
- An app-bundled per-user LaunchAgent accepts explicit Start/Stop commands and
  reads the server startup preference at login. When stopped, it remains idle.
  macOS may require approval in Login Items & Extensions.
- **Stop Server** stops the owned API and managed database, without changing
  login preferences. Agent hosts remain detached; external databases are never
  stopped. **Quit Dispatch** leaves the server running.
- **Check for Updates…** and **Install Updates Automatically** drive Sparkle. After
  an update relaunches the app, a notification confirms the new version and that
  the server restarted.
- **Settings → Support** shows the version and a single **Dispatch Data** entry
  with **Show in Finder** and **Copy Path**, covering data, configuration and logs.

### Identity and processes

|                                | Value                                |
| ------------------------------ | ------------------------------------ |
| Bundle ID                      | `dev.bradharris.dispatch.mac`        |
| LaunchAgent                    | `dev.bradharris.dispatch.mac.server` |
| Data folder                    | `~/.dispatch-mac/`                   |
| Managed database role and name | `dispatch_mac`                       |

The same native binary ships under one name per role, so Activity Monitor shows
**Dispatch** (menu bar app), **Dispatch Service** (the LaunchAgent supervisor), and
**Dispatch Worker** (starts the database and API). The API itself appears as
`dispatch` and the database as `postgres`.

### Data

State lives under `~/.dispatch-mac/`, including `configuration.json`,
`server.log`, files, agents, and release stores. Configuration is written
atomically with mode 0600; its directory is created with mode 0700. The database
URL is not put in launchd's plist or command-line arguments. Keep that directory
private and do not attach the configuration file to bug reports.

The app neither adopts nor stops a standalone `com.dispatch.server` service. A
health response must identify this instance before **Open Dispatch** is enabled.
An occupied port does not cause it to attach to a different installation.
PostgreSQL runs only on a private loopback port with password authentication;
data lives in `~/.dispatch-mac/postgres`. Database credentials are saved
separately in `local-database.json` with mode 0600, so setup can retry and
switching to an external database does not erase local credentials. Database
logs are `database-setup.log` and `postgres.log` in the same folder. Updates and
quitting the menu retain your data. Major PostgreSQL upgrades require an explicit
migration; startup refuses incompatible data rather than recreating it. Engine
CLIs/authentication remain prerequisites. Engine hosts use Dispatch's existing
login-shell launch path.

### Migrating a pre-release install

Pre-release builds used bundle ID `dev.bradharris.dispatch.preview`,
`~/.dispatch-mac-preview/`, and the `dispatch_preview` role. Sparkle cannot update
across a bundle ID change, so moving to a release build is a one-time manual
install: choose **Quit Dispatch** in the old menu (the server keeps running),
replace `Dispatch.app` in Applications with a release build, and open it. If the old
menu app is still running, macOS re-activates it instead of launching the new copy.
On first launch the app:

1. Quits the old menu app and boots out its LaunchAgent, which stops the old API
   and database. Running agent hosts are detached and keep running.
2. Renames `~/.dispatch-mac-preview` to `~/.dispatch-mac` and leaves a symlink at
   the old path. Running agents and stored file paths (`agents.files_dir`) still
   reference it; do not delete it while pre-migration agents exist.
3. Renames the managed role and database to `dispatch_mac`, keeping all data.
4. Registers the new LaunchAgent and restarts the server if it was running, so
   agents reattach.

Each step is safe to repeat; if one fails, the app reports it and blocks setup so
it cannot create a second database. Quit and reopen Dispatch to retry. The old
app's entries in Login Items & Extensions are stale afterwards and can be
removed, and macOS asks again for any folder access the bundled server needs.

## Build and install locally

From the repository root on a Mac with Xcode/Swift and the usual JS build tools:

```sh
pnpm install --frozen-lockfile
swift test --package-path apps/macos
DISPATCH_BUN_TARGETS=bun-darwin-arm64 pnpm run build:bun
pnpm run build:macos
```

The app and ZIP are in `dist/macos/arm64/`. Move **Dispatch.app** to
`/Applications` or `~/Applications` before starting the service. Open Settings,
choose **Save** to keep the initial configuration, then **Start Server**. If macOS
requests background approval, use **Allow in System Settings**. Once healthy,
choose **Open Dispatch**.

For Intel, build `bun-darwin-x64` and set `DISPATCH_MAC_ARCH=x64` when packaging.
`DISPATCH_MAC_SERVER_BINARY` can select an already-built executable; its
architecture is checked before packaging. `DISPATCH_MAC_BUILD` supplies a
numeric bundle build version (defaults to 1). Local builds do not include Sparkle
unless `DISPATCH_SPARKLE_SDK` is set; see [macOS Releases](macos-dogfood.md).

## Signing for distribution

The packaging script signs the nested Bun binary with its required JIT
entitlements, signs the role executables and the native app, and verifies the
bundle seal. For a distributable build, use the Developer ID signing identity and
a configured notarytool keychain profile:

```sh
DISPATCH_CODESIGN_IDENTITY='Developer ID Application: …' \
DISPATCH_NOTARY_KEYCHAIN_PROFILE=dispatch-release-notary \
DISPATCH_NOTARIZE_MACOS_APP=1 \
DISPATCH_MAC_BUILD=2 \
pnpm run build:macos
```

The script submits the ZIP, staples and validates the ticket on the app, runs
Gatekeeper assessment, and creates a fresh ZIP containing the stapled app. A
failure leaves the previous packaged artifact in place. No signing credentials
are stored in the repository. For local notarization with a non-default keychain,
set `DISPATCH_NOTARY_KEYCHAIN` to its path alongside the profile name.

## Updates and removal

Sparkle owns app updates. The server sets `DISPATCH_UPDATE_OWNER=macos-app`; web
tarball updates and assisted-update launch/phase routes reject requests, including
forced updates. Before Sparkle replaces the bundle, the app records whether the
server was running and stops the service; after relaunch it re-registers the
service, restores that state, and confirms health before clearing the recovery
record. If that fails, **Retry Update Recovery** appears in the menu.

To remove the app, stop its server, disable its login preference and macOS
background item, quit, and delete the app. State and the database are intentionally
retained; remove `~/.dispatch-mac` separately only if it is no longer needed.

## Validation without registering a service

Use `repo_dev_up` for an isolated stack. Launch the packaged menu executable
with its printed **web** URL:

```sh
DISPATCH_MENU_VALIDATION_URL=http://127.0.0.1:PORT \
  'dist/macos/arm64/Dispatch.app/Contents/MacOS/Dispatch'
```

This explicit mode connects only to an HTTP loopback URL with a non-production
port. It disables configuration and lifecycle actions, and does not register login items.
Use it to exercise status, exact address copying, and default-browser handoff
without touching an installed service. Browser validation alone does not prove
LaunchAgent registration, notarization, or agent survival across app upgrades.

## Isolated onboarding validation

The native executable accepts `--isolated-test /tmp/dispatch-macos-test-<id>`.
Only a directory directly under `/tmp` with this prefix is accepted. It uses
that directory instead of user state and starts the service as a child
process instead of registering a LaunchAgent; login registration is disabled.
Quit the test menu to stop that child. This validates onboarding without
installing a service or touching existing Dispatch data. It is not an install
or service-registration test.

`DISPATCH_TEST_POSTGRES_BUNDLE=<bundle>/Contents/Helpers/Postgres swift test
--package-path apps/macos` runs real cluster creation, authenticated connection,
persistence, shutdown, restart, and pre-release role migration tests in a
temporary directory. CI runs these with its downloaded bundle. No production
database is contacted.

The notarized SMAppService proof is documented in
[macos-sparkle-service-proof.md](macos-sparkle-service-proof.md); its scripts and
results remain for regression investigations.
