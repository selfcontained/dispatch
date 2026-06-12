import os from "node:os";

/**
 * Whether the host can place an image onto a clipboard the agent CLI can read
 * back via Ctrl+V: the macOS pasteboard, or a Linux Xvfb display advertised
 * through `DISPATCH_COPY_DISPLAY`.
 *
 * Used by the media upload inject flow to decide between native clipboard paste
 * and path-based injection into tmux.
 */
export function hostClipboardImageCapable(): boolean {
  const platform = os.platform();
  if (platform === "darwin") return true;
  return platform === "linux" && !!process.env.DISPATCH_COPY_DISPLAY;
}
