import type { AgentPin } from "./types.js";

export type ShortcutRunTarget =
  | { ok: true; prompt: string }
  | { ok: false; status: 404 | 400; error: string };

/**
 * Decide what a shortcut click is allowed to inject. The prompt is selected
 * here, server-side, from the pin the agent itself stored — the client only
 * ever supplies an ID — so this function is the whole trust boundary for the
 * run endpoint, and the one place worth asserting delivers `value` (the
 * prompt) rather than any other field of the pin.
 */
export function resolveShortcutRun(
  pins: AgentPin[] | undefined,
  pinId: string
): ShortcutRunTarget {
  const pin = (pins ?? []).find((candidate) => candidate.id === pinId);
  if (!pin) {
    return { ok: false, status: 404, error: "Pin not found." };
  }
  if (pin.type !== "shortcut") {
    return { ok: false, status: 400, error: "Pin is not a shortcut pin." };
  }
  return { ok: true, prompt: pin.value };
}
