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

The archive is written to `artifacts/dispatch-browser-feedback.zip`.

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
`chrome://extensions` and the Chrome Web Store. Selection is limited to the
top-level page and reachable open DOM; cross-origin frames and closed shadow
roots are not inspected.

## Release checks

The manifest and package versions must match; an extension test enforces this.
Before packaging a release, run the repository checks and extension tests, then
run the package command above. The ZIP must contain `manifest.json` at its root.
