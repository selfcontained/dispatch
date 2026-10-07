import { describe, it, expect } from "vitest";

import { sanitizeAgentName } from "../src/shared/lib/agent-strings.js";

describe("sanitizeAgentName", () => {
  it("passes through valid names unchanged", () => {
    expect(sanitizeAgentName("my-agent_01")).toBe("my-agent_01");
  });

  it("replaces invalid characters with underscores", () => {
    expect(sanitizeAgentName("hello world!")).toBe("hello_world_");
  });

  it("replaces dots and slashes", () => {
    expect(sanitizeAgentName("path/to.name")).toBe("path_to_name");
  });

  it("truncates to 60 characters", () => {
    const long = "a".repeat(80);
    expect(sanitizeAgentName(long).length).toBe(60);
  });

  it("does not truncate names at exactly 60 characters", () => {
    const exact = "b".repeat(60);
    expect(sanitizeAgentName(exact)).toBe(exact);
  });

  it("handles empty string", () => {
    expect(sanitizeAgentName("")).toBe("");
  });

  it("replaces unicode characters but keeps hyphens", () => {
    expect(sanitizeAgentName("café-résumé")).toBe("caf_-r_sum_");
  });
});
