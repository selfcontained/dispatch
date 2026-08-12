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

type CopySlot = { target: Record<PropertyKey, unknown>; key: PropertyKey };

/**
 * Iterative rather than recursive: the values passed here are agent-supplied
 * (a stored brain object, a pin) and their nesting depth is not bounded by
 * anything this server enforces, so a recursive walk would let one deeply
 * nested object blow the call stack and fail the whole list request. An
 * explicit work stack has no such ceiling.
 *
 * Every input reaches this function via JSON.parse (jsonb columns, request
 * bodies), so the graph is a tree — no cycle guard is needed, and a shared
 * reference cannot make the loop revisit a node.
 */
function truncate(root: unknown, maxChars: number): unknown {
  const holder: Record<PropertyKey, unknown> = {};
  const stack: Array<CopySlot & { source: unknown }> = [
    { target: holder, key: "root", source: root },
  ];

  while (stack.length > 0) {
    const { target, key, source } = stack.pop()!;

    if (typeof source === "string") {
      target[key] =
        source.length <= maxChars
          ? source
          : `${source.slice(0, maxChars)}…[+${source.length - maxChars} chars]`;
      continue;
    }

    if (Array.isArray(source)) {
      const copy = new Array(source.length);
      target[key] = copy;
      // Push in reverse so popping visits entries in their original order,
      // which keeps the serialized copy's key order matching the input's.
      for (let i = source.length - 1; i >= 0; i--) {
        stack.push({
          target: copy as unknown as CopySlot["target"],
          key: i,
          source: source[i],
        });
      }
      continue;
    }

    if (source && typeof source === "object") {
      const copy: Record<string, unknown> = {};
      target[key] = copy;
      const entries = Object.entries(source);
      for (let i = entries.length - 1; i >= 0; i--) {
        stack.push({
          target: copy,
          key: entries[i]![0],
          source: entries[i]![1],
        });
      }
      continue;
    }

    target[key] = source;
  }

  return holder.root;
}
