/**
 * Icon names an agent may put on a shortcut pin. Kept in lockstep with the web
 * icon map (apps/web/src/lib/pin-shortcut-icons.ts) — the tool schema enumerates
 * these so the agent can only pick one the sidebar can actually render.
 */
export const PIN_SHORTCUT_ICON_NAMES = [
  "zap",
  "play",
  "rocket",
  "refresh",
  "check",
  "x",
  "pause",
  "trash",
  "bug",
  "search",
  "database",
  "terminal",
  "file",
  "branch",
  "pull-request",
  "message",
  "flag",
  "clock",
  "checklist",
  "sparkles",
  "wrench",
  "shield",
  "upload",
  "download",
  "arrow",
] as const;

export type PinShortcutIconName = (typeof PIN_SHORTCUT_ICON_NAMES)[number];
