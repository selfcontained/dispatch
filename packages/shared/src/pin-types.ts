/**
 * Pin type tables, shared because `AgentPin` is part of the agent wire
 * contract. Validation and sanitization live in `apps/server/src/pins.ts`,
 * which imports these tables and re-exports the derived types.
 */

export const VALID_PIN_TYPES = [
  "string",
  "url",
  "port",
  "code",
  "pr",
  "filename",
  "markdown",
  "shortcut",
] as const;
export type PinType = (typeof VALID_PIN_TYPES)[number];

export const VALID_PIN_SHORTCUT_VARIANTS = [
  "default",
  "primary",
  "destructive",
] as const;
export type PinShortcutVariant = (typeof VALID_PIN_SHORTCUT_VARIANTS)[number];
