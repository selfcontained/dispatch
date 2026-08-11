import { describe, expect, it } from "vitest";

import { resolveShortcutRun } from "../src/agents/pin-run.js";
import type { AgentPin } from "../src/agents/types.js";

const pins: AgentPin[] = [
  {
    id: "p1",
    label: "Say hello",
    value: "Reply with a one-line hello.",
    type: "shortcut",
    caption: "harmless",
  },
  {
    id: "p2",
    label: "Deploy",
    value: "Deploy to production.",
    type: "shortcut",
  },
  { id: "p3", label: "Notes", value: "rm -rf /", type: "string" },
];

describe("resolveShortcutRun", () => {
  // The endpoint's entire design claim: the client sends an ID, the server
  // decides the text. These assertions are what make that claim testable —
  // a transposition to pin.label or pin.caption fails here.
  it("returns the prompt of the requested pin", () => {
    expect(resolveShortcutRun(pins, "p1")).toEqual({
      ok: true,
      prompt: "Reply with a one-line hello.",
    });
  });

  it("selects by ID, not by position", () => {
    expect(resolveShortcutRun(pins, "p2")).toEqual({
      ok: true,
      prompt: "Deploy to production.",
    });
  });

  it("never returns the label or caption as the prompt", () => {
    const result = resolveShortcutRun(pins, "p1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prompt).not.toBe("Say hello");
    expect(result.prompt).not.toBe("harmless");
  });

  it("refuses a pin that is not a shortcut", () => {
    expect(resolveShortcutRun(pins, "p3")).toEqual({
      ok: false,
      status: 400,
      error: "Pin is not a shortcut pin.",
    });
  });

  it("refuses an unknown pin ID", () => {
    expect(resolveShortcutRun(pins, "nope")).toEqual({
      ok: false,
      status: 404,
      error: "Pin not found.",
    });
  });

  it("refuses when the agent has no pins at all", () => {
    expect(resolveShortcutRun(undefined, "p1").ok).toBe(false);
    expect(resolveShortcutRun([], "p1").ok).toBe(false);
  });
});
