import { describe, expect, it } from "vitest";

import { encodeRepoRoot, decodeRepoRoot } from "./brain-encoding";

describe("encodeRepoRoot / decodeRepoRoot", () => {
  it("round-trips a simple ASCII path", () => {
    const path = "/Users/brad/dev/apps/dispatch";
    expect(decodeRepoRoot(encodeRepoRoot(path))).toBe(path);
  });

  it("round-trips a path with non-ASCII characters", () => {
    const path = "/home/ユーザー/プロジェクト";
    expect(decodeRepoRoot(encodeRepoRoot(path))).toBe(path);
  });

  it("round-trips a path with emoji", () => {
    const path = "/home/user/🚀-project";
    expect(decodeRepoRoot(encodeRepoRoot(path))).toBe(path);
  });

  it("produces URL-safe output (no +, /, or =)", () => {
    const encoded = encodeRepoRoot("/a/b/c/d/e/f/g/h/i");
    expect(encoded).not.toMatch(/[+/=]/);
  });

  it("handles an empty string", () => {
    expect(decodeRepoRoot(encodeRepoRoot(""))).toBe("");
  });

  it("throws on malformed input", () => {
    expect(() => decodeRepoRoot("!!!invalid!!!")).toThrow();
  });
});
