import type { AgentPin } from "./types.js";

/**
 * A pin whose type has been resolved to a concrete string but not yet checked
 * against the allowed set. Merging happens before validation — the effective
 * type can come from the stored pin — so these helpers work at this width and
 * the caller narrows to `AgentPin` afterwards.
 */
export type DraftPin = Omit<AgentPin, "type"> & { type: string };

/** Decorations that an agent clears by sending an empty string. */
const CLEARABLE_FIELDS = ["caption", "group", "icon"] as const;

/** Decorations that only mean anything on a shortcut pin. */
const SHORTCUT_ONLY_FIELDS = [
  "icon",
  "variant",
  "confirm",
  "disabled",
] as const;

/**
 * Optional pin decorations are cleared by passing an empty string — there is
 * no other way to remove one, since an omitted field means "leave as-is".
 */
export function clearBlankPinFields<T extends DraftPin>(pin: T): T {
  const cleared = { ...pin };
  for (const field of CLEARABLE_FIELDS) {
    if (cleared[field] !== undefined && cleared[field]!.trim() === "") {
      delete cleared[field];
    }
  }
  return cleared;
}

/**
 * Drop decorations the resolved type has no meaning for, and clear the ones
 * the agent blanked.
 *
 * Every write ends here, create and update alike: "the resolved type governs
 * which decorations survive" is one rule, and stating it per-branch is how a
 * plain pin ends up stored carrying `confirm` that nothing can then remove
 * (`variant`/`confirm`/`disabled` aren't clearable by empty string).
 */
export function finalizePin<T extends DraftPin>(pin: T): T {
  const finalized = clearBlankPinFields(pin);
  if (finalized.type !== "shortcut") {
    for (const field of SHORTCUT_ONLY_FIELDS) delete finalized[field];
  }
  return finalized;
}

/**
 * Merge an incoming pin onto the one already stored.
 *
 * Merge rather than replace: an agent re-pinning to change one thing (add a
 * group, refresh a value) shouldn't have to restate every decoration or
 * silently lose it. Fields the agent omits keep their stored value; fields it
 * sends as an empty string are removed. Callers run `finalizePin` on the
 * result — including to strip shortcut-only fields when a pin is re-typed.
 */
export function mergePin(existing: AgentPin, incoming: DraftPin): DraftPin {
  return {
    ...existing,
    ...incoming,
    id: existing.id ?? incoming.id,
  };
}
