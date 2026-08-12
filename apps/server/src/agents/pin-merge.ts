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
 * Merge an incoming pin onto the one already stored under the same label.
 *
 * Merge rather than replace: an agent re-pinning to change one thing (add a
 * group, refresh a value) shouldn't have to restate every decoration or
 * silently lose it. Fields the agent omits keep their stored value; fields it
 * sends as an empty string are removed.
 */
export function mergePin(existing: AgentPin, incoming: DraftPin): DraftPin {
  const merged = clearBlankPinFields({
    ...existing,
    ...incoming,
    id: existing.id ?? incoming.id,
  });

  // Omitting a field means "keep it", which would otherwise let a shortcut's
  // icon/variant/confirm/disabled ride along when the pin is re-typed as
  // something else — stale state an agent could see in dispatch_list_pins
  // and have no way to clear.
  if (merged.type !== "shortcut") {
    for (const field of SHORTCUT_ONLY_FIELDS) delete merged[field];
  }

  return merged;
}
