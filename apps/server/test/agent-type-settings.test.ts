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

  // The Dispatch Harness has its own setting (`dispatch_harness_enabled`), so
  // this list is not where it is turned on. A prerelease database can still
  // hold it inside the stored JSON; dropping it on read is what keeps every
  // reader on one source for the harness.
  it("drops the harness from a list that names it", () => {
    expect(DEFAULT_ENABLED_AGENT_TYPES).not.toContain("dispatch");
    expect(sanitizeEnabledAgentTypes(["dispatch", "claude"])).toEqual([
      "claude",
    ]);
  });

  it("falls back to the defaults for a list that names only the harness", () => {
    expect(sanitizeEnabledAgentTypes(["dispatch"])).toEqual(
      DEFAULT_ENABLED_AGENT_TYPES
    );
  });
});
