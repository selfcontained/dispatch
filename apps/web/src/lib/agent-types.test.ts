import { describe, expect, it } from "vitest";

import {
  AGENT_TYPES,
  CLI_AGENT_TYPES,
  isAgentType,
  isCliAgentType,
  sanitizeEnabledAgentTypes,
  sortAgentTypes,
  type AgentType,
} from "./agent-types";

describe("agent type tables", () => {
  it("lists only the ACP engines", () => {
    expect([...AGENT_TYPES]).toEqual(["claude", "codex"]);
    expect([...CLI_AGENT_TYPES]).toEqual(["claude", "codex"]);
  });
});

describe("isAgentType", () => {
  it.each([...AGENT_TYPES])("returns true for %s", (type) => {
    expect(isAgentType(type)).toBe(true);
  });

  it.each(["terminal", "cursor", "opencode", "vim", ""])(
    "returns false for %s",
    (type) => {
      expect(isAgentType(type)).toBe(false);
    }
  );
});

describe("isCliAgentType", () => {
  it.each([...CLI_AGENT_TYPES])("returns true for %s", (type) => {
    expect(isCliAgentType(type)).toBe(true);
  });

  it("returns false for a retired type", () => {
    expect(isCliAgentType("terminal")).toBe(false);
  });
});

describe("sortAgentTypes", () => {
  it("sorts alphabetically by label", () => {
    expect(sortAgentTypes(["codex", "claude"])).toEqual(["claude", "codex"]);
  });

  it("does not mutate the input array", () => {
    const input: AgentType[] = ["codex", "claude"];
    const copy = [...input];
    sortAgentTypes(input);
    expect(input).toEqual(copy);
  });

  it("handles an empty array", () => {
    expect(sortAgentTypes([])).toEqual([]);
  });
});

describe("sanitizeEnabledAgentTypes", () => {
  it("returns all types for non-array input", () => {
    expect(sanitizeEnabledAgentTypes(null)).toEqual([...AGENT_TYPES]);
    expect(sanitizeEnabledAgentTypes(undefined)).toEqual([...AGENT_TYPES]);
    expect(sanitizeEnabledAgentTypes("claude")).toEqual([...AGENT_TYPES]);
    expect(sanitizeEnabledAgentTypes(42)).toEqual([...AGENT_TYPES]);
  });

  it("drops retired and invalid types from mixed input", () => {
    expect(
      sanitizeEnabledAgentTypes(["claude", "invalid", "cursor", "terminal"])
    ).toEqual(["claude"]);
  });

  it("deduplicates entries", () => {
    expect(
      sanitizeEnabledAgentTypes(["claude", "claude", "codex", "codex"])
    ).toEqual(["claude", "codex"]);
  });

  it("returns all types when nothing valid is left", () => {
    expect(sanitizeEnabledAgentTypes([])).toEqual([...AGENT_TYPES]);
    expect(sanitizeEnabledAgentTypes(["vim", 123, null, "terminal"])).toEqual([
      ...AGENT_TYPES,
    ]);
  });

  it("preserves a single valid type", () => {
    expect(sanitizeEnabledAgentTypes(["codex"])).toEqual(["codex"]);
  });
});
