import os from "node:os";

/**
 * Whether the host can place a browser-pasted image onto a clipboard the agent
 * CLI can read back via Ctrl+V: the macOS pasteboard, or a Linux Xvfb display
 * advertised through `DISPATCH_COPY_DISPLAY`.
 *
 * Single source of truth for two call sites that must stay in lockstep:
 *  - `GET /api/v1/system/defaults` reports it to the web client as
 *    `clipboardImagePaste` (the client uses it to choose native paste vs.
 *    path-based upload).
 *  - `POST /api/v1/clipboard/image` gates its platform branches on it.
 *
 * Note this is a capability *predicate*, not a probe: on Linux it confirms a
 * display is configured but does not verify `xclip` is installed or the
 * display is reachable. A false positive degrades gracefully — the native
 * paste fails and the client falls back to a path-based media upload.
 */
export function hostClipboardImageCapable(): boolean {
  const platform = os.platform();
  if (platform === "darwin") return true;
  return platform === "linux" && !!process.env.DISPATCH_COPY_DISPLAY;
}
