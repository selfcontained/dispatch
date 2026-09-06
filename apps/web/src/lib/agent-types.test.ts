import { describe, expect, it } from "vitest";

import {
  AGENT_TYPES,
  CLI_AGENT_TYPES,
  defaultReviewAgentType,
  isAgentType,
  isCliAgentType,
  sanitizeEnabledAgentTypes,
  sortAgentTypes,
  type AgentType,
} from "./agent-types";

describe("isAgentType", () => {
  it.each([...AGENT_TYPES])("returns true for %s", (type) => {
    expect(isAgentType(type)).toBe(true);
  });

  it("returns false for unknown string", () => {
    expect(isAgentType("vim")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isAgentType("")).toBe(false);
  });
});

describe("isCliAgentType", () => {
  it.each([...CLI_AGENT_TYPES])("returns true for %s", (type) => {
    expect(isCliAgentType(type)).toBe(true);
  });

  it("returns false for terminal", () => {
    expect(isCliAgentType("terminal")).toBe(false);
  });

  it("returns false for unknown string", () => {
    expect(isCliAgentType("vim")).toBe(false);
  });
});

describe("sortAgentTypes", () => {
  it("sorts alphabetically by label with terminal last", () => {
    const input: AgentType[] = [
      "terminal",
      "opencode",
      "claude",
      "codex",
      "cursor",
    ];
    const sorted = sortAgentTypes(input);
    expect(sorted).toEqual([
      "claude",
      "codex",
      "cursor",
      "opencode",
      "terminal",
    ]);
  });

  it("keeps terminal last even when it is the only element", () => {
    expect(sortAgentTypes(["terminal"])).toEqual(["terminal"]);
  });

  it("does not mutate the input array", () => {
    const input: AgentType[] = ["cursor", "claude"];
    const copy = [...input];
    sortAgentTypes(input);
    expect(input).toEqual(copy);
  });

  it("handles an empty array", () => {
    expect(sortAgentTypes([])).toEqual([]);
  });

  it("handles two-element array with terminal first", () => {
    expect(sortAgentTypes(["terminal", "claude"])).toEqual([
      "claude",
      "terminal",
    ]);
  });
});

describe("sanitizeEnabledAgentTypes", () => {
  // dsh is opt-in: it needs the harness binary and a provider key on the
  // server, so it stays out of the fallback list.
  const defaults = AGENT_TYPES.filter((type) => type !== "dsh");

  it("returns the default types for non-array input", () => {
    expect(sanitizeEnabledAgentTypes(null)).toEqual(defaults);
    expect(sanitizeEnabledAgentTypes(undefined)).toEqual(defaults);
    expect(sanitizeEnabledAgentTypes("claude")).toEqual(defaults);
    expect(sanitizeEnabledAgentTypes(42)).toEqual(defaults);
  });

  it("filters valid agent types from mixed input", () => {
    expect(sanitizeEnabledAgentTypes(["claude", "invalid", "cursor"])).toEqual([
      "claude",
      "cursor",
    ]);
  });

  it("deduplicates entries", () => {
    expect(
      sanitizeEnabledAgentTypes(["claude", "claude", "codex", "codex"])
    ).toEqual(["claude", "codex"]);
  });

  it("returns the default types when array is empty", () => {
    expect(sanitizeEnabledAgentTypes([])).toEqual(defaults);
  });

  it("returns the default types when array has only invalid entries", () => {
    expect(sanitizeEnabledAgentTypes(["vim", 123, null])).toEqual(defaults);
  });

  it("keeps dsh when it was chosen explicitly", () => {
    expect(sanitizeEnabledAgentTypes(["dsh"])).toEqual(["dsh"]);
  });

  it("filters out non-string entries", () => {
    expect(sanitizeEnabledAgentTypes([42, true, "claude"])).toEqual(["claude"]);
  });

  it("preserves a single valid type", () => {
    expect(sanitizeEnabledAgentTypes(["terminal"])).toEqual(["terminal"]);
  });
});

describe("defaultReviewAgentType", () => {
  it("runs the reviewer as the agent's own kind, dsh included", () => {
    expect(defaultReviewAgentType({ type: "dsh" })).toBe("dsh");
    expect(defaultReviewAgentType({ type: "cursor" })).toBe("cursor");
    expect(defaultReviewAgentType({ type: "claude" })).toBe("claude");
  });

  it("prefers a saved choice, and falls back to codex for a terminal", () => {
    expect(
      defaultReviewAgentType({ type: "dsh", reviewAgentType: "claude" })
    ).toBe("claude");
    expect(defaultReviewAgentType({ type: "terminal" })).toBe("codex");
    expect(defaultReviewAgentType({})).toBe("codex");
  });
});
