import { describe, expect, it } from "vitest";

import { buildPersonaReviewDiff } from "../src/personas/review-diff.js";

describe("buildPersonaReviewDiff", () => {
  it("includes committed and uncommitted changes", async () => {
    const runCommand = async (_command: string, args: string[]) => {
      const key = args.join(" ");
      if (key === "diff origin/main...HEAD") {
        return { stdout: "diff --git a/a.ts b/a.ts\n" };
      }
      if (key === "diff HEAD") {
        return { stdout: "diff --git a/b.ts b/b.ts\n" };
      }
      if (key === "ls-files --others --exclude-standard") {
        return { stdout: "" };
      }
      if (key === "diff --stat origin/main...HEAD") {
        return { stdout: " a.ts | 1 +\n 1 file changed\n" };
      }
      if (key === "diff --stat HEAD") {
        return { stdout: " b.ts | 2 +\n 1 file changed\n" };
      }
      throw new Error(`Unexpected command: ${key}`);
    };

    const result = await buildPersonaReviewDiff(
      "/repo",
      "origin/main",
      runCommand
    );

    expect(result.diff).toContain("### Committed changes since main");
    expect(result.diff).toContain("diff --git a/a.ts b/a.ts");
    expect(result.diff).toContain("### Uncommitted working tree changes");
    expect(result.diff).toContain("diff --git a/b.ts b/b.ts");
    expect(result.baseRef).toBe("origin/main");
    expect(result.stat).toContain("a.ts");
    expect(result.uncommittedStat).toContain("b.ts");
    expect(result.diffByteSize).toBeGreaterThan(0);
  });

  it("includes untracked files in the review context", async () => {
    const runCommand = async (_command: string, args: string[]) => {
      const key = args.join(" ");
      if (
        key === "diff origin/main...HEAD" ||
        key === "diff HEAD" ||
        key === "diff --stat origin/main...HEAD" ||
        key === "diff --stat HEAD"
      ) {
        return { stdout: "" };
      }
      if (key === "ls-files --others --exclude-standard") {
        return { stdout: "new-file.ts\nnotes.md\n" };
      }
      throw new Error(`Unexpected command: ${key}`);
    };

    const result = await buildPersonaReviewDiff(
      "/repo",
      "origin/main",
      runCommand
    );

    expect(result.diff).toContain("### Untracked files");
    expect(result.diff).toContain("- new-file.ts");
    expect(result.diff).toContain("- notes.md");
    expect(result.untrackedFiles).toEqual(["new-file.ts", "notes.md"]);
  });

  it("returns a fallback when no changes are detected", async () => {
    const runCommand = async (_command: string, args: string[]) => {
      const key = args.join(" ");
      if (
        key === "diff origin/main...HEAD" ||
        key === "diff HEAD" ||
        key === "ls-files --others --exclude-standard" ||
        key === "diff --stat origin/main...HEAD" ||
        key === "diff --stat HEAD"
      ) {
        return { stdout: "" };
      }
      throw new Error(`Unexpected command: ${key}`);
    };

    const result = await buildPersonaReviewDiff(
      "/repo",
      "origin/main",
      runCommand
    );

    expect(result.diff).toBe("(no committed or uncommitted changes detected)");
    expect(result.diffByteSize).toBe(0);
  });

  it("uses the provided baseRef for diff commands", async () => {
    const commands: string[] = [];
    const runCommand = async (_command: string, args: string[]) => {
      const key = args.join(" ");
      commands.push(key);
      return { stdout: "" };
    };

    await buildPersonaReviewDiff("/repo", "origin/develop", runCommand);

    expect(commands).toContain("diff origin/develop...HEAD");
    expect(commands).toContain("diff --stat origin/develop...HEAD");
  });

  it("strips origin/ prefix for section headers", async () => {
    const runCommand = async (_command: string, args: string[]) => {
      const key = args.join(" ");
      if (key === "diff origin/main...HEAD") {
        return { stdout: "diff --git a/x.ts b/x.ts\n" };
      }
      if (key === "diff --stat origin/main...HEAD") {
        return { stdout: " x.ts | 1 +\n" };
      }
      return { stdout: "" };
    };

    const result = await buildPersonaReviewDiff(
      "/repo",
      "origin/main",
      runCommand
    );

    expect(result.diff).toContain("### Committed changes since main");
    expect(result.diff).not.toContain("since origin/main");
  });
});
