/**
 * Shared response shaping for MCP tools.
 *
 * Every byte a tool returns is held in the calling agent's context for the rest
 * of its session, so responses are shaped for the caller's next decision rather
 * than for completeness. Two rules keep that consistent across the tool surface:
 *
 * 1. JSON is emitted compact. Pretty-printing costs tokens for indentation the
 *    model does not need.
 * 2. List-shaped tools return a lean projection; the matching single-item tool
 *    (get_template, get_job, brain_get_object) is the way to get everything.
 */

/** Serialize a tool payload as compact JSON — never pretty-printed. */
export function jsonText(value: unknown): string {
  return JSON.stringify(value);
}

/**
 * Deep-copy `value`, replacing any string longer than `maxChars` with its first
 * `maxChars` characters plus a marker naming how much was dropped. Used by list
 * tools so a long field (an idea write-up, a shortcut pin's prompt) does not
 * force every other item in the list out of a caller's budget. The marker keeps
 * the truncation visible: a caller that needs the whole string can tell it was
 * cut and go fetch the single object.
 */
export function truncateLongStrings<T>(value: T, maxChars: number): T {
  return truncate(value, maxChars) as T;
}

function truncate(value: unknown, maxChars: number): unknown {
  if (typeof value === "string") {
    if (value.length <= maxChars) return value;
    return `${value.slice(0, maxChars)}…[+${value.length - maxChars} chars]`;
  }
  if (Array.isArray(value)) {
    return value.map((item) => truncate(item, maxChars));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = truncate(item, maxChars);
    }
    return out;
  }
  return value;
}
