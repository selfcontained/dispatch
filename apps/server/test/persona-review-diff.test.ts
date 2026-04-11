import { describe, expect, it } from "vitest";

import { buildPersonaReviewDiff } from "../src/personas/review-diff.js";

describe("buildPersonaReviewDiff", () => {
  it("includes committed and uncommitted changes", async () => {
    const runCommand = async (_command: string, args: string[]) => {
      const key = args.join(" ");
      if (key === "symbolic-ref refs/remotes/origin/HEAD --short") {
        return { stdout: "origin/main\n" };
      }
      if (key === "diff main...HEAD") {
        return { stdout: "diff --git a/a.ts b/a.ts\n" };
      }
      if (key === "diff HEAD") {
        return { stdout: "diff --git a/b.ts b/b.ts\n" };
      }
      if (key === "ls-files --others --exclude-standard") {
        return { stdout: "" };
      }
      throw new Error(`Unexpected command: ${key}`);
    };

    const result = await buildPersonaReviewDiff("/repo", runCommand);

    expect(result).toContain("### Committed changes since main");
    expect(result).toContain("diff --git a/a.ts b/a.ts");
    expect(result).toContain("### Uncommitted working tree changes");
    expect(result).toContain("diff --git a/b.ts b/b.ts");
  });

  it("includes untracked files in the review context", async () => {
    const runCommand = async (_command: string, args: string[]) => {
      const key = args.join(" ");
      if (key === "symbolic-ref refs/remotes/origin/HEAD --short") {
        return { stdout: "origin/main\n" };
      }
      if (key === "diff main...HEAD" || key === "diff HEAD") {
        return { stdout: "" };
      }
      if (key === "ls-files --others --exclude-standard") {
        return { stdout: "new-file.ts\nnotes.md\n" };
      }
      throw new Error(`Unexpected command: ${key}`);
    };

    const result = await buildPersonaReviewDiff("/repo", runCommand);

    expect(result).toContain("### Untracked files");
    expect(result).toContain("- new-file.ts");
    expect(result).toContain("- notes.md");
  });

  it("notes when base branch detection fails", async () => {
    const runCommand = async (_command: string, args: string[]) => {
      const key = args.join(" ");
      if (key === "symbolic-ref refs/remotes/origin/HEAD --short") {
        throw new Error("no origin head");
      }
      if (key === "diff main...HEAD" || key === "diff HEAD" || key === "ls-files --others --exclude-standard") {
        return { stdout: "" };
      }
      throw new Error(`Unexpected command: ${key}`);
    };

    const result = await buildPersonaReviewDiff("/repo", runCommand);

    expect(result).toContain('base branch detection failed; committed diff was generated against "main"');
  });

  it("returns a fallback when no changes are detected", async () => {
    const runCommand = async (_command: string, args: string[]) => {
      const key = args.join(" ");
      if (key === "symbolic-ref refs/remotes/origin/HEAD --short") {
        return { stdout: "origin/main\n" };
      }
      if (key === "diff main...HEAD" || key === "diff HEAD" || key === "ls-files --others --exclude-standard") {
        return { stdout: "" };
      }
      throw new Error(`Unexpected command: ${key}`);
    };

    const result = await buildPersonaReviewDiff("/repo", runCommand);

    expect(result).toBe("(no committed or uncommitted changes detected)");
  });
});
