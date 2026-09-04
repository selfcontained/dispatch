import { describe, expect, it } from "vitest";

import {
  DEFAULT_ENABLED_AGENT_TYPES,
  sanitizeEnabledAgentTypes,
} from "../src/agent-type-settings.js";

describe("sanitizeEnabledAgentTypes", () => {
  it("returns defaults when the value is not an array", () => {
    expect(sanitizeEnabledAgentTypes(undefined)).toEqual(
      DEFAULT_ENABLED_AGENT_TYPES
    );
  });

  it("filters unknown values and removes duplicates", () => {
    expect(
      sanitizeEnabledAgentTypes(["codex", "claude", "codex", "unknown"])
    ).toEqual(["codex", "claude"]);
  });

  it("falls back to defaults when the array has no valid types", () => {
    expect(sanitizeEnabledAgentTypes(["unknown"])).toEqual(
      DEFAULT_ENABLED_AGENT_TYPES
    );
  });

  it("keeps dsh opt-in but accepts it when chosen", () => {
    expect(DEFAULT_ENABLED_AGENT_TYPES).not.toContain("dsh");
    expect(sanitizeEnabledAgentTypes(["dsh", "claude"])).toEqual([
      "dsh",
      "claude",
    ]);
  });
});
