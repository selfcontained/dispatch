import { taskAgentName } from "@dispatch/shared";
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

describe("taskAgentName", () => {
  it.each([
    ["Fix the login form", "Fix the login form"],
    ["a".repeat(40), "a".repeat(40)],
    ["  Fix\n the\t login   form  ", "Fix the login form"],
    [" \n\t ", ""],
    [
      "Implement task agent names across launch paths",
      "Implement task agent names across launch…",
    ],
    ["a".repeat(41), "a".repeat(40) + "…"],
    ["😀".repeat(41), "😀".repeat(40) + "…"],
    ["😀".repeat(40), "😀".repeat(40)],
    ["a".repeat(40) + " word", "a".repeat(40) + "…"],
  ])("names %j as %j", (title, expected) => {
    expect(taskAgentName(title)).toBe(expected);
  });
});
