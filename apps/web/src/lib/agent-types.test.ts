import { describe, expect, it } from "vitest";

import {
  AGENT_TYPES,
  CLI_AGENT_TYPES,
  isAgentType,
  isCliAgentType,
  isNestedReviewAgent,
  sanitizeEnabledAgentTypes,
  sortAgentTypes,
  type AgentType,
} from "./agent-types";

describe("isNestedReviewAgent", () => {
  it("nests only review-role agents that have a parent", () => {
    expect(
      isNestedReviewAgent({ parentAgentId: "parent", role: "review" })
    ).toBe(true);
    expect(
      isNestedReviewAgent({ parentAgentId: "parent", role: "standard" })
    ).toBe(false);
    expect(isNestedReviewAgent({ parentAgentId: null, role: "review" })).toBe(
      false
    );
  });
});

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
  it("returns all types for non-array input", () => {
    expect(sanitizeEnabledAgentTypes(null)).toEqual([...AGENT_TYPES]);
    expect(sanitizeEnabledAgentTypes(undefined)).toEqual([...AGENT_TYPES]);
    expect(sanitizeEnabledAgentTypes("claude")).toEqual([...AGENT_TYPES]);
    expect(sanitizeEnabledAgentTypes(42)).toEqual([...AGENT_TYPES]);
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

  it("returns all types when array is empty", () => {
    expect(sanitizeEnabledAgentTypes([])).toEqual([...AGENT_TYPES]);
  });

  it("returns all types when array has only invalid entries", () => {
    expect(sanitizeEnabledAgentTypes(["vim", 123, null])).toEqual([
      ...AGENT_TYPES,
    ]);
  });

  it("filters out non-string entries", () => {
    expect(sanitizeEnabledAgentTypes([42, true, "claude"])).toEqual(["claude"]);
  });

  it("preserves a single valid type", () => {
    expect(sanitizeEnabledAgentTypes(["terminal"])).toEqual(["terminal"]);
  });
});
