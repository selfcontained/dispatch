/**
 * Shared response shaping for MCP tools.
 *
 * Every byte a tool returns is held in the calling agent's context for the rest
 * of its session, so responses are shaped for the caller's next decision rather
 * than for completeness.
 *
 * ## The policy
 *
 * 1. JSON is emitted compact. Pretty-printing costs tokens for indentation the
 *    model does not need.
 * 2. A list-shaped tool returns a lean projection, and there is always an
 *    explicit way to read one entry in full. Exactly two shapes are sanctioned:
 *      - a separate single-item tool (`get_template`, `brain_get_object`,
 *        `brain_get_event`, `brain_get_list_item`, `dispatch_review_get_feedback`);
 *      - an **identity selector** on the list tool itself — an input that names
 *        one entry and can mean nothing else (`dispatch_list_pins` with `id`,
 *        `get_feedback_summary` with `group`). This costs no extra tool.
 *    A *cardinality* control must never double as a detail read: `limit: 1`
 *    asks for a small response, not an unbounded one, and overloading it makes
 *    the response budget depend on a pagination knob.
 * 3. A write confirms what changed — ids, revision, timestamp — instead of
 *    echoing back the entity the caller just sent.
 *
 * Trimming a listing means dropping a field outright (preferred when a detail
 * read covers it) or truncating long strings with `truncateLongStrings` at
 * `LIST_STRING_MAX` (preferred when the field's shape is still useful at a
 * glance). Truncation is a primitive, not a policy: use the shared cap so the
 * surface stays predictable rather than picking a new number per tool.
 */

/**
 * Longest string a list-shaped response keeps intact. Enough for a title, a
 * summary line, or a short prompt; short enough that one multi-KB entry cannot
 * crowd out the rest of the page. The matching detail read returns it whole.
 */
export const LIST_STRING_MAX = 400;

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
