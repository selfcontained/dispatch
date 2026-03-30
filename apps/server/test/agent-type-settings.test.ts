import { describe, expect, it } from "vitest";

import { AGENT_TYPES, sanitizeEnabledAgentTypes } from "../src/agent-type-settings.js";

describe("sanitizeEnabledAgentTypes", () => {
  it("returns defaults when the value is not an array", () => {
    expect(sanitizeEnabledAgentTypes(undefined)).toEqual(AGENT_TYPES);
  });

  it("filters unknown values and removes duplicates", () => {
    expect(sanitizeEnabledAgentTypes(["codex", "claude", "codex", "unknown"])).toEqual([
      "codex",
      "claude",
    ]);
  });

  it("falls back to defaults when the array has no valid types", () => {
    expect(sanitizeEnabledAgentTypes(["unknown"])).toEqual(AGENT_TYPES);
  });
});
