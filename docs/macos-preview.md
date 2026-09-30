# macOS menu bar preview

Dispatch is an optional macOS 13+ menu bar app. It bundles the same Bun
server used by the binary release and opens its local web app in a browser.
There is no embedded webview. Linux installation and release artifacts are
unchanged.

This first increment is for trying ACP alongside an existing installation.
It is not yet a replacement for the stable installer.

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
  displayed; **Copy Connection URL** includes credentials. Production port 6767
  and database names `dispatch` and `postgres` remain reserved.
- **Settings → General** has independent preferences for showing the menu bar app and
  starting the server at login. Changing either does not start/stop the server.
- An app-bundled per-user LaunchAgent accepts explicit Start/Stop commands and
  reads the server startup preference at login. When stopped, it remains idle.
  macOS may require approval in Login Items & Extensions.
- **Stop Server** stops the owned API and managed database, without changing
  login preferences. Agent hosts remain detached; external databases are never
  stopped. **Quit Dispatch** leaves the server running.
- **Settings → Support** shows the version and a single **Dispatch Data** entry
  with **Show in Finder** and **Copy Path**, covering data, configuration and logs.

State lives under `~/.dispatch-mac-preview/`, including `configuration.json`,
`server.log`, files, agents, and release stores. Configuration is written
atomically with mode 0600; its directory is created with mode 0700. The database
URL is not put in launchd's plist or command-line arguments. Keep that directory
private and do not attach the configuration file to bug reports.

The preview neither adopts nor stops the existing `com.dispatch.server`
service. A health response must identify this preview instance before **Open
Dispatch** is enabled. An occupied port does not cause it to attach to a different
installation. PostgreSQL 17 is bundled and runs only on a private loopback
port with password authentication; data lives in `~/.dispatch-mac-preview/postgres`.
Database credentials are saved separately in `local-database.json` with mode 0600,
so setup can retry and switching to an external database does not erase local
credentials. Database logs are `database-setup.log` and `postgres.log` in the
same private directory. Updates and quitting the menu retain your data. Major
PostgreSQL upgrades require an explicit migration; startup refuses incompatible
data rather than recreating it. Engine CLIs/authentication remain prerequisites.
Engine hosts use Dispatch's existing login-shell launch path.

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
numeric bundle build version (defaults to 1).

The old artifact-only **macOS Menu Preview** workflow has been retired. Use
[macOS Releases](macos-dogfood.md) for signed, notarized downloads with Sparkle
updates. That release workflow supports arm64 only; the local Intel build option
above does not establish supported Intel release delivery.

## Signing for distribution

The packaging script signs the nested Bun binary with its required JIT
entitlements, signs the native app separately, and verifies the bundle seal.
For a distributable preview, use the existing Developer ID signing identity and
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
are stored in the repository. Public distribution should require this path.

## Updating and removing a preview

Automatic app updates are deliberately absent in this increment. The server
sets `DISPATCH_UPDATE_OWNER=macos-app`; web tarball updates and assisted-update
launch/phase routes reject requests, including forced updates. The runtime also
rejects tarball installation as a second guard. Linux and standalone macOS
servers retain their existing update behavior.

For a manual update, finish active agents, choose **Stop Server**, disable
**Launch Dispatch at login** if enabled, and quit the app. Disable its background
item in macOS Login Items & Extensions before replacing the bundle, so the idle
coordinator is also unloaded. Replace the app at the same
location, reopen it, re-enable its background item, and choose **Start Server**. Keep a backup of the preview
database before changing versions: replacing an app cannot undo schema changes.
Do not move/replace the app while its server or agents are using it.

To remove it, stop its server, disable its app login preference and macOS
background item, quit, and delete the app. State and the database are intentionally retained; remove them separately
only if they are no longer needed.

## Validation without registering a service

Use `repo_dev_up` for an isolated stack. Launch the packaged menu executable
with its printed **web** URL:

```sh
DISPATCH_MENU_VALIDATION_URL=http://127.0.0.1:PORT \
  'dist/macos/arm64/Dispatch.app/Contents/MacOS/DispatchMenu'
```

This explicit mode connects only to an HTTP loopback URL with a non-production
port. It disables configuration and lifecycle actions, and does not register login items.
Use it to exercise status, exact address copying, and default-browser handoff
without touching an installed service. Browser validation alone does not prove
LaunchAgent registration, notarization, or agent survival across app upgrades.

## Before a public app release

1. Exercise signed/notarized installation, background approval, login, crash
   recovery, unregister/re-register, and uninstall on a test Mac. VM use requires
   user approval under the repository's validation rules.
2. Implement a coordinated Sparkle update path: signed appcast, monotonically
   increasing build versions, preview/stable channels, Dispatch migration gates,
   agent-host compatibility, service re-registration, and post-update health.
   Keep the web updater excluded from app-owned installations.
3. Add an explicit migration path from the existing service with backup and
   recovery with the managed local PostgreSQL cluster.
4. Validate first-run onboarding and branding on an installed signed build.
   App artwork and managed database setup are implemented.

### Signed CI previews

The **macOS Releases** workflow imports the existing signing and notarization
secrets into a temporary runner keychain, verifies the app, and publishes the
selected update channel. The old preview artifact workflow and one-off Sparkle
proof workflow have been removed; see [the current release guide](macos-dogfood.md).

For local notarization with a non-default keychain, set
`DISPATCH_NOTARY_KEYCHAIN` to its path alongside the profile name. Credentials
must already be stored in that keychain; CI secret values are not downloaded.

## Isolated onboarding validation

The native executable accepts `--isolated-test /tmp/dispatch-macos-test-<id>`.
Only a directory directly under `/tmp` with this prefix is accepted. It uses
that directory instead of user preview state and starts the service as a child
process instead of registering a LaunchAgent; login registration is disabled.
Quit the test menu to stop that child. This validates onboarding without
installing a service or touching existing Dispatch data. It is not an install
or service-registration test.

`DISPATCH_TEST_POSTGRES_BUNDLE=<bundle>/Contents/Helpers/Postgres swift test
--package-path apps/macos` runs real cluster creation, authenticated connection,
persistence, shutdown, and restart tests in a temporary directory. CI runs these
with its downloaded bundle. No production database is contacted.

## Display-name change and automatic updates

The visible app name is **Dispatch**. This is not a database migration: retain
`dev.bradharris.dispatch.preview`, its LaunchAgent identifier,
`~/.dispatch-mac-preview`, and the managed `dispatch_preview` role/database.
Existing configuration, credentials, instance identity, sessions, and startup
preferences must be reused. Do not adopt the standalone `dispatch` database or
rename/copy its data. An existing installed bundle should be stopped and moved
with service re-registration as part of a controlled installer/update, not
renamed underneath a running coordinator.

Sparkle is not integrated yet. Remaining work:

- Embed/sign Sparkle 2 and add Check for Updates plus automatic-check preferences.
- Provision a separate Sparkle EdDSA signing key (Apple signing remains in use),
  embed its public key, and configure an HTTPS appcast URL.
- Extend CI to publish notarized/stapled archives and a signed appcast, with
  increasing build numbers and explicit release-channel policy.
- Coordinate installation with the app-owned service: preserve whether the server
  was running, stop/reap owned processes, replace the app, repair registration,
  and restore prior running state. Preserve detached agent hosts only when the
  new runtime remains compatible.
- Gate incompatible database/runtime migrations, provide backup/recovery, and
  verify post-update health before declaring success. PostgreSQL major-version
  upgrades need a separate data-migration path; never replace the engine blindly.
- Validate two real signed versions: running/stopped server, retained sessions and
  preferences, existing standalone installation, interrupted update, and failed
  restart. Linux keeps its existing standalone delivery/update path.

See [Sparkle documentation](https://sparkle-project.org/documentation/).

### Recommended Linux counterpart (not implemented)

Retain the standalone installer and binary updater for the first release. Share
release/compatibility metadata, migration eligibility, agent-survival rules,
health confirmation and recovery requirements with the Mac path. Sparkle and the
Linux installer remain separate artifact installers with one update owner per
installation.

The current automatic-update modes are `off` and `check`; unattended installation
is additional work. Before enabling it, add authenticated release verification
(the current archive checksum is not a publisher signature), a compatible-update
policy, and recovery controlled outside the server being replaced. Keep the
previous executable, but allow automatic binary rollback only when the database
schema remains compatible; otherwise use an explicit backup/recovery procedure.
A future package-managed installation must delegate file replacement to its
package manager rather than also running the self-updater.

The completed gate is documented in [the notarized SMAppService proof](macos-sparkle-service-proof.md). Its one-off workflow is retired; the proof scripts and results remain for future regression investigations.
