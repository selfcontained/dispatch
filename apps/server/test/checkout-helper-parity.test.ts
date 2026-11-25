import { describe, expect, it } from "vitest";
import {
  assertSafeRefName,
  normalizeBaseBranch,
  GitWorktreeError,
} from "../src/shared/git/worktree.js";
import { shouldExcludePath } from "../src/shared/git/diff-file-rules.js";
import { isTestFile } from "../src/shared/git/test-files.js";
import { toToolError } from "../src/shared/mcp/tool-error.js";

// Pinned against origin/main's pure implementations before extracting them.
describe("checkout helper main parity", () => {
  it("preserves ref trimming, permissive ref subset, and exact errors", () => {
    expect(assertSafeRefName("  origin/topic..x  ", "branch")).toBe(
      "origin/topic..x"
    );
    expect(normalizeBaseBranch(" origin/topic ")).toBe("topic");
    for (const [input, message] of [
      ["", "baseBranch must not be empty."],
      [
        "origin/origin/main",
        "baseBranch must not contain nested origin/ prefixes.",
      ],
      ["-main", "baseBranch must not start with '-'."],
      [
        "a b",
        "baseBranch may only contain letters, digits, '.', '_', '-', or '/'.",
      ],
    ]) {
      try {
        normalizeBaseBranch(input!);
        throw new Error("expected error");
      } catch (error) {
        expect(error).toBeInstanceOf(GitWorktreeError);
        expect(error).toMatchObject({
          message,
          statusCode: 400,
          name: "GitWorktreeError",
        });
      }
    }
  });
  it("retains POSIX basename and test path classification", () => {
    expect(
      [
        "pnpm-lock.yaml",
        "a/pnpm-lock.yaml",
        "a/pnpm-lock.yaml/",
        "a\\pnpm-lock.yaml",
        "PNPM-lock.yaml",
      ].map(shouldExcludePath)
    ).toEqual([true, true, true, false, false]);
    expect(
      [
        "src/a.test.ts",
        "src\\test_a.py",
        "tests/data.json",
        "test_fixtures.json",
        "api-spec.md",
        "src/a.ts",
      ].map(isTestFile)
    ).toEqual([true, true, true, false, false, false]);
  });
  it("retains tool error bytes for Error and non Error values", () => {
    for (const error of [
      new GitWorktreeError("bad branch"),
      new Error("failed"),
      "oops",
      null,
      { x: 1 },
    ]) {
      expect(toToolError(error)).toEqual({
        content: [
          {
            type: "text",
            text: error instanceof Error ? error.message : String(error),
          },
        ],
        isError: true,
      });
    }
  });
});
