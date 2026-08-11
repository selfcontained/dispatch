import type { AgentPin } from "./types.js";

/** Decorations that an agent clears by sending an empty string. */
const CLEARABLE_FIELDS = ["caption", "group", "icon"] as const;

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
  return clearBlankPinFields({
    ...existing,
    ...incoming,
    id: existing.id ?? incoming.id,
  });
}
