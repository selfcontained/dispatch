import { describe, it, expect } from "vitest";

import {
  MAX_NOTE_BYTES,
  sanitizeAgentName,
  sanitizeAgentString,
} from "../src/shared/lib/agent-strings.js";

describe("sanitizeAgentString", () => {
  it("returns undefined for undefined input", () => {
    expect(sanitizeAgentString(undefined)).toBeUndefined();
  });

  it("passes through a simple string unchanged", () => {
    expect(sanitizeAgentString("hello world")).toBe("hello world");
  });

  it("replaces newlines with spaces", () => {
    expect(sanitizeAgentString("line1\nline2")).toBe("line1 line2");
  });

  it("replaces carriage returns with spaces", () => {
    expect(sanitizeAgentString("line1\rline2")).toBe("line1 line2");
  });

  it("collapses consecutive \\r\\n sequences into a single space", () => {
    expect(sanitizeAgentString("a\r\n\r\nb")).toBe("a b");
  });

  it("truncates strings exceeding MAX_NOTE_BYTES", () => {
    const long = "x".repeat(MAX_NOTE_BYTES + 100);
    const result = sanitizeAgentString(long)!;
    expect(result.length).toBe(MAX_NOTE_BYTES);
  });

  it("does not truncate strings at exactly MAX_NOTE_BYTES", () => {
    const exact = "y".repeat(MAX_NOTE_BYTES);
    expect(sanitizeAgentString(exact)).toBe(exact);
  });

  it("handles empty string", () => {
    expect(sanitizeAgentString("")).toBe("");
  });

  it("strips newlines before checking length", () => {
    const withNewlines = "a".repeat(MAX_NOTE_BYTES - 1) + "\n";
    const result = sanitizeAgentString(withNewlines)!;
    expect(result).toBe("a".repeat(MAX_NOTE_BYTES - 1) + " ");
    expect(result.length).toBe(MAX_NOTE_BYTES);
  });
});

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
