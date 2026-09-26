# macOS menu bar preview

Dispatch Preview is an optional macOS 13+ menu bar app. It bundles the same Bun
server used by the binary release and opens its local web app in a browser.
There is no embedded webview. Linux installation and release artifacts are
unchanged.

This first increment is for trying ACP alongside an existing installation.
It is not yet a replacement for the stable installer.

## What ships

- **Open Dispatch** opens the running server in the system browser or the
  installed browser selected under **Open in Browser**. The preference survives
  quitting and relaunching the menu. An unavailable selected browser produces an
  error rather than silently switching browsers.
- **Configure Preview** saves a PostgreSQL connection URL and port. The default
  port is 6768. Use an existing, dedicated database: migrations run at startup.
  The preview refuses port 6767 and databases named `dispatch` or `postgres`.
- **Start Server** registers an app-bundled, per-user LaunchAgent through
  `SMAppService`. macOS may require approval in Login Items & Extensions. The
  menu shows that state and links to System Settings. Registration also enables
  starting the server at login; it does not run before the user logs in.
- **Stop Server** unregisters that service. Agent hosts remain detached, but
  server-dependent tools are unavailable while it is stopped.
- **Open Menu at Login** independently controls the menu application's login
  item. **Quit Menu (Keep Server Running)** leaves the service running.
- **Show Server Log** reveals the preview log in Finder.

State lives under `~/.dispatch-mac-preview/`, including `configuration.json`,
`server.log`, files, agents, and release stores. Configuration is written
atomically with mode 0600; its directory is created with mode 0700. The database
URL is not put in launchd's plist or command-line arguments. Keep that directory
private and do not attach the configuration file to bug reports.

The preview neither adopts nor stops the existing `com.dispatch.server`
service. A health response must identify this preview instance before **Open
Dispatch** is enabled. A occupied port does not cause it to attach to a different
installation. PostgreSQL and engine CLIs/authentication remain prerequisites;
the app does not install them. Engine hosts use Dispatch's existing login-shell
launch path.

## Build and install locally

From the repository root on a Mac with Xcode/Swift and the usual JS build tools:

```sh
pnpm install --frozen-lockfile
swift test --package-path apps/macos
DISPATCH_BUN_TARGETS=bun-darwin-arm64 pnpm run build:bun
pnpm run build:macos
```

The app and ZIP are in `dist/macos/arm64/`. Move **Dispatch Preview.app** to
`/Applications` or `~/Applications` before starting the service. Open it, choose
**Configure Preview**, supply a dedicated database connection, then choose
**Start Server**. If macOS requests background approval, use **Allow Background
Service** in the menu. Once healthy, choose **Open Dispatch**.

For Intel, build `bun-darwin-x64` and set `DISPATCH_MAC_ARCH=x64` when packaging.
`DISPATCH_MAC_SERVER_BINARY` can select an already-built executable; its
architecture is checked before packaging. `DISPATCH_MAC_BUILD` supplies a
numeric bundle build version (defaults to 1).

The manual **macOS Menu Preview** GitHub Actions workflow builds the selected
branch and architecture and uploads a ZIP as a workflow artifact. It does not
publish a GitHub release. Its artifacts are ad-hoc signed development builds,
not notarized public downloads. Do not distribute them as trusted releases or
instruct testers to disable Gatekeeper.

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
**Open Menu at Login** if enabled, and quit the menu. Replace the app at the same
location, reopen it, and choose **Start Server**. Keep a backup of the preview
database before changing versions: replacing an app cannot undo schema changes.
Do not move/replace the app while its server or agents are using it.

To remove it, stop its server, disable its menu login item, quit, and delete the
app. State and the database are intentionally retained; remove them separately
only if they are no longer needed.

## Validation without registering a service

Use `repo_dev_up` for an isolated stack. Launch the packaged menu executable
with its printed **web** URL:

```sh
DISPATCH_MENU_VALIDATION_URL=http://127.0.0.1:PORT \
  'dist/macos/arm64/Dispatch Preview.app/Contents/MacOS/DispatchMenu'
```

This explicit mode connects only to an HTTP loopback URL with a non-production
port. It omits server configuration, lifecycle controls, and login registration.
Use it to exercise status, browser selection, persistence, and browser handoff
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
   recovery, plus a decision about managed PostgreSQL onboarding.
4. Add app branding/artwork and a first-run onboarding experience for managed
   PostgreSQL and engine prerequisites.
