import type { AgentPin } from "./types.js";

/** Decorations that an agent clears by sending an empty string. */
const CLEARABLE_FIELDS = ["caption", "group", "icon"] as const;

/** Decorations that only mean anything on a shortcut pin. */
const SHORTCUT_ONLY_FIELDS = ["icon", "variant", "confirm"] as const;

/**
 * Optional pin decorations are cleared by passing an empty string — there is
 * no other way to remove one, since an omitted field means "leave as-is".
 */
export function clearBlankPinFields(pin: AgentPin): AgentPin {
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
export function mergePin(existing: AgentPin, incoming: AgentPin): AgentPin {
  const merged = clearBlankPinFields({
    ...existing,
    ...incoming,
    id: existing.id ?? incoming.id,
  });

  // Omitting a field means "keep it", which would otherwise let a shortcut's
  // icon/variant/confirm ride along when the pin is re-typed as something
  // else — stale state an agent could see in dispatch_list_pins and have no
  // way to clear.
  if (merged.type !== "shortcut") {
    for (const field of SHORTCUT_ONLY_FIELDS) delete merged[field];
  }

  return merged;
}
