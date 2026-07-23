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
can inspect an unrelated site after the user explicitly invokes the picker
there. On first use, Chrome prompts the user to grant the extension access to
all sites (`<all_urls>`). This broad grant is required because the element
screenshot uses `chrome.tabs.captureVisibleTab`, which only accepts all-URLs (or
`activeTab`) access rather than per-host patterns; it also makes the picker
reliable as the side panel follows the user between projects. It can be revoked
at any time from Chrome's extension settings. The inspected page never needs to
share an origin with Dispatch. Access to the configured Dispatch origin is
requested separately at pairing time.

Before showing or sending the context preview, the extension removes form
values, editable content, scripts, inline event handlers, `srcdoc`, and likely
secret URL parameters.

## Screenshot of the selected element

When the **Include screenshot of selected element** toggle is on (the default,
remembered per browser profile), selecting an element also captures a cropped
PNG of it using Chrome's `captureVisibleTab` and the element's bounding box. The
image is shown in the side panel preview and sent with the submission, where
Dispatch stores it as an agent media entry and points the agent at its path.

The screenshot is a pixel capture of the rendered viewport, so — unlike the DOM
context — it is not sanitized and shows whatever is on screen. Use the **Remove
screenshot** button to drop the image from a single submission, or turn the
toggle off to stop capturing. Capture is best-effort: it only covers the visible
top-level document, so elements inside nested frames or scrolled out of view are
skipped rather than sent partially.

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

## Release checks

The manifest and package versions must match; an extension test enforces this.
Before packaging a release, run the repository checks and extension tests, then
run the package command above. The ZIP must contain `manifest.json` at its root.
