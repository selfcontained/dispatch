/**
 * Update state the macOS menu app reports to its server, and the commands the
 * web app can send back through it. The menu app owns Sparkle; the server only
 * relays.
 */

export const MAC_APP_UPDATE_PHASES = [
  "idle",
  "checking",
  "downloading",
  "installing",
  "recovery",
  "error",
] as const;
export type MacAppUpdatePhase = (typeof MAC_APP_UPDATE_PHASES)[number];

export const MAC_APP_UPDATE_ACTIONS = ["check", "install"] as const;
export type MacAppUpdateAction = (typeof MAC_APP_UPDATE_ACTIONS)[number];

export type MacAppUpdateState = {
  /** Installed app version (CFBundleShortVersionString). */
  version: string;
  phase: MacAppUpdatePhase;
  /** Newer version found by the last check, if any. */
  availableVersion: string | null;
  /** ISO timestamp of the last completed check. */
  checkedAt: string | null;
  error: string | null;
  /** Install Updates Automatically, as set in the menu. */
  automatic: boolean;
};

/** `connected` is false when no menu app holds a control connection. */
export type MacAppUpdateSnapshot = {
  connected: boolean;
  state: MacAppUpdateState | null;
};
