import { describe, expect, it } from "vitest";

import {
  worktreePathSlug,
  assertSafeRefName,
  GitWorktreeError,
} from "../src/shared/git/worktree.js";

describe("worktreePathSlug", () => {
  it("slugifies branch name for new branches", () => {
    expect(
      worktreePathSlug("feature/auth-flow", { createNewBranch: true })
    ).toBe("feature-auth-flow");
  });

  it("appends hash for existing branches", () => {
    const slug = worktreePathSlug("feature/auth-flow", {
      createNewBranch: false,
    });
    expect(slug).toMatch(/^feature-auth-flow-[a-f0-9]{6}$/);
  });

  it("produces stable hashes for the same input", () => {
    const a = worktreePathSlug("main", { createNewBranch: false });
    const b = worktreePathSlug("main", { createNewBranch: false });
    expect(a).toBe(b);
  });

  it("differentiates similar branch names via hash", () => {
    const a = worktreePathSlug("feature/x", { createNewBranch: false });
    const b = worktreePathSlug("feature-x", { createNewBranch: false });
    expect(a).not.toBe(b);
  });

  it("lowercases the slug", () => {
    expect(worktreePathSlug("Feature/Auth", { createNewBranch: true })).toBe(
      "feature-auth"
    );
  });

  it("throws for empty input after slugification", () => {
    expect(() => worktreePathSlug("///", { createNewBranch: true })).toThrow(
      GitWorktreeError
    );
  });
});

describe("assertSafeRefName", () => {
  it("accepts valid ref names", () => {
    expect(assertSafeRefName("main", "branch")).toBe("main");
    expect(assertSafeRefName("feature/login", "branch")).toBe("feature/login");
    expect(assertSafeRefName("release-2026.04", "branch")).toBe(
      "release-2026.04"
    );
    expect(assertSafeRefName("my_branch", "branch")).toBe("my_branch");
  });

  it("trims whitespace", () => {
    expect(assertSafeRefName("  main  ", "branch")).toBe("main");
  });

  it("rejects empty string", () => {
    expect(() => assertSafeRefName("", "branch")).toThrow(GitWorktreeError);
    expect(() => assertSafeRefName("   ", "branch")).toThrow(GitWorktreeError);
  });

  it("rejects shell metacharacters", () => {
    expect(() => assertSafeRefName("branch;rm -rf", "branch")).toThrow(
      GitWorktreeError
    );
    expect(() => assertSafeRefName("branch$(cmd)", "branch")).toThrow(
      GitWorktreeError
    );
    expect(() => assertSafeRefName("branch`cmd`", "branch")).toThrow(
      GitWorktreeError
    );
    expect(() => assertSafeRefName("branch name", "branch")).toThrow(
      GitWorktreeError
    );
  });
});
