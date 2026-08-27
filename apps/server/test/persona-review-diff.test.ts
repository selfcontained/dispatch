import { describe, expect, it } from "vitest";

import { buildPersonaReviewDiff } from "../src/personas/review-diff.js";

describe("buildPersonaReviewDiff", () => {
  it("collects file-level stats and untracked files", async () => {
    const runCommand = async (_command: string, args: string[]) => {
      const key = args.join(" ");
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

    expect(result.baseRef).toBe("origin/main");
    expect(result.stat).toContain("a.ts");
    expect(result.uncommittedStat).toContain("b.ts");
    expect(result.hasChanges).toBe(true);
  });

  it("never runs the full-diff commands", async () => {
    // The diff is deliberately not collected: reviewers run in the
    // worktree and read hunks themselves, and embedding it was what
    // pushed the launch payload past tmux's command-length ceiling.
    const commands: string[] = [];
    const runCommand = async (_command: string, args: string[]) => {
      commands.push(args.join(" "));
      return { stdout: "" };
    };

    await buildPersonaReviewDiff("/repo", "origin/main", runCommand);

    expect(commands).not.toContain("diff origin/main...HEAD");
    expect(commands).not.toContain("diff HEAD");
    expect(commands).toContain("diff --stat origin/main...HEAD");
    expect(commands).toContain("diff --stat HEAD");
  });

  it("reports untracked files", async () => {
    const runCommand = async (_command: string, args: string[]) => {
      const key = args.join(" ");
      if (key === "ls-files --others --exclude-standard") {
        return { stdout: "new-file.ts\nnotes.md\n" };
      }
      return { stdout: "" };
    };

    const result = await buildPersonaReviewDiff(
      "/repo",
      "origin/main",
      runCommand
    );

    expect(result.untrackedFiles).toEqual(["new-file.ts", "notes.md"]);
    expect(result.hasChanges).toBe(true);
  });

  it("reports hasChanges false when nothing changed", async () => {
    const runCommand = async () => ({ stdout: "" });

    const result = await buildPersonaReviewDiff(
      "/repo",
      "origin/main",
      runCommand
    );

    expect(result.hasChanges).toBe(false);
    expect(result.stat).toBe("");
    expect(result.untrackedFiles).toEqual([]);
  });

  it("uses the provided baseRef", async () => {
    const commands: string[] = [];
    const runCommand = async (_command: string, args: string[]) => {
      commands.push(args.join(" "));
      return { stdout: "" };
    };

    await buildPersonaReviewDiff("/repo", "origin/develop", runCommand);

    expect(commands).toContain("diff --stat origin/develop...HEAD");
  });

  it("degrades to no-changes when git fails", async () => {
    const runCommand = async () => {
      throw new Error("not a git repository");
    };

    const result = await buildPersonaReviewDiff(
      "/repo",
      "origin/main",
      runCommand
    );

    expect(result.hasChanges).toBe(false);
    expect(result.baseRef).toBe("origin/main");
  });
});
