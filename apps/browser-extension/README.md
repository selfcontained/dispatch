# Dispatch Browser Feedback

Select an element on a live web page, add a comment, and send the bounded DOM
context to a running Dispatch agent.

## Build and load

From the Dispatch repository root:

```sh
pnpm --filter @dispatch/browser-extension build
```

Then open `chrome://extensions`, enable Developer mode, choose **Load
unpacked**, and select `apps/browser-extension/dist`.

To create a zip that can be distributed or uploaded for review, run:

```sh
pnpm --filter @dispatch/browser-extension package
```

The archive is written to `apps/browser-extension/dist/dispatch-browser-feedback.zip`.

Click the extension toolbar icon to open its side panel. Enter the URL of your
Dispatch instance, approve the pairing request in Dispatch, return to the page
you want to inspect, and select a running agent.

## Permissions and privacy

The configured Dispatch origin is only the feedback destination. The extension
can inspect an unrelated HTTP or HTTPS site after the user explicitly invokes
the picker there. On first use, Chrome prompts the user to grant the extension
access to HTTP and HTTPS pages. This optional grant makes the picker reliable as
the side panel follows the user between projects and can be revoked at any time
from Chrome's extension settings. The inspected page never needs to share an
origin with Dispatch. Access to the configured Dispatch origin is requested
separately at pairing time.

Before showing or sending the context preview, the extension removes form
values, editable content, scripts, inline event handlers, `srcdoc`, and likely
secret URL parameters.

Each Chrome profile receives a separate 90-day, revocable token. The token is
stored only in extension-local storage and is restricted to trusted extension
contexts. Disconnecting removes the local token and the optional Dispatch host
permission. If the server cannot be reached to revoke the remote token, the
extension reports that explicitly; active connections can always be revoked
independently in Dispatch settings.

HTTP Dispatch URLs are supported for self-hosted environments. Before pairing,
the extension requires an explicit acknowledgement that HTTP sends credentials
and feedback without transport encryption. HTTPS should be preferred on
untrusted networks.

Chrome blocks script injection on browser-owned pages such as
`chrome://extensions` and the Chrome Web Store. After the user grants access to
HTTP and HTTPS sites, selection can inspect reachable open DOM in the top-level
page and in HTTP/HTTPS frames, including cross-origin frames where Chrome
permits extension injection. Frames Chrome refuses to inject into and closed
shadow roots are not inspected.

## Safari (iPad / iPhone / Mac)

The Safari version reuses the same Dispatch pairing, agents, and submission
system with a mobile-first flow: the extension popup handles connect and
"Select element"; picking (tap + parent/child refine), the comment, and Send
all happen in a transient in-page overlay that removes itself when done. The
page only ignores taps while you are aiming — scrolling always works, and the
comment card releases the page entirely.

Build the web extension bundle:

```sh
pnpm --filter @dispatch/browser-extension build:safari
```

The output lands in `apps/browser-extension/dist/safari/unpacked`, which the
checked-in Xcode project references directly — rebuilding the bundle is enough
for the next Xcode build to pick it up.

### Run on the iPad simulator

Open `apps/browser-extension/safari/Dispatch Feedback/Dispatch Feedback.xcodeproj`,
select an iPad simulator, and Run. In the simulator: Settings → Apps →
Safari → Extensions → Dispatch Browser Feedback → enable. Then open Safari,
tap the extension (puzzle) button in the address bar, and open Dispatch
feedback.

### Distribute through TestFlight

The project is preconfigured with automatic signing for team `ML8BQ6D727`
(the same team the Mac release binaries sign with) and bundle IDs
`com.dispatch.feedback` / `com.dispatch.feedback.extension`.

One-time setup: create the app record in App Store Connect (My Apps → New
App → iOS, bundle ID `com.dispatch.feedback`). If this Mac has no Apple
Distribution certificate yet, Xcode offers to create one during the first
Distribute App.

Per release:

1. `pnpm --filter @dispatch/browser-extension build:safari`
2. Verify `MARKETING_VERSION` matches `package.json` (a vitest check enforces
   this) and bump `CURRENT_PROJECT_VERSION` (build number) for each upload.
3. Select "Any iOS Device (arm64)" → Product → Archive → Distribute App →
   TestFlight & App Store Connect. (CLI equivalent: `xcodebuild archive` +
   `xcodebuild -exportArchive` with an App Store Connect API key via
   `-authenticationKeyPath/-authenticationKeyID/-authenticationKeyIssuerID`;
   headless export cannot mint distribution profiles without one.)
4. In App Store Connect, add yourself as an internal tester and install the
   build via TestFlight on the iPad.
5. On the iPad: Settings → Apps → Safari → Extensions → enable Dispatch
   Browser Feedback, then allow it on the sites you want to inspect (or
   "Other Websites" for everything). Site access can also be granted in-page
   from the aA / puzzle menu the first time you use the picker.

Pairing works the same as Chrome: open the extension popup, enter your
Dispatch URL, approve the code in Dispatch settings. The popup may close while
the approval tab is open — pairing continues in the background; reopen the
popup to see the connected state.

## Release checks

The manifest and package versions must match; an extension test enforces this.
Before packaging a release, run the repository checks and extension tests, then
run the package command above. The ZIP must contain `manifest.json` at its root.
