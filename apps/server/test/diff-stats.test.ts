import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RunCommandResult } from "../src/shared/lib/run-command.js";
import { getDiffStats } from "../src/shared/git/diff-stats.js";

type CommandKey = string;
type CommandHandler = () => RunCommandResult;

const MERGE_BASE_SHA = "abcd1234";

function ok(stdout = ""): RunCommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}

function fail(stdout = ""): RunCommandResult {
  return { exitCode: 1, stdout, stderr: "" };
}

/**
 * Build a runCommand mock that satisfies the standard sequence:
 *   1. resolveBaseRef → `git rev-parse --verify --quiet <baseRef>` (success)
 *   2. `git merge-base HEAD <baseRef>` → MERGE_BASE_SHA
 *   3. `git diff <merge-base> --numstat`
 *   4. `git ls-files --others --exclude-standard`
 *
 * Callers can override any of those keys via `handlers`.
 */
function withCommands(
  worktreePath: string,
  baseRef: string,
  handlers: Record<CommandKey, CommandHandler>
) {
  const baseCheckKey = `-C ${worktreePath} rev-parse --verify --quiet ${baseRef}`;
  const mergeBaseKey = `-C ${worktreePath} merge-base HEAD ${baseRef}`;
  const trackedKey = `-C ${worktreePath} diff ${MERGE_BASE_SHA} --numstat`;
  const untrackedKey = `-C ${worktreePath} ls-files --others --exclude-standard`;

  const merged: Record<CommandKey, CommandHandler> = {
    [baseCheckKey]: () => ok(baseRef),
    [mergeBaseKey]: () => ok(MERGE_BASE_SHA),
    [trackedKey]: () => ok(""),
    [untrackedKey]: () => ok(""),
    ...handlers,
  };

  return vi.fn(async (_command: string, args: string[]) => {
    const key = args.join(" ");
    const handler = merged[key];
    if (handler) return handler();

    // check-ignore args vary with tracked paths; default to "none ignored"
    if (args.includes("check-ignore")) {
      return { exitCode: 1, stdout: "", stderr: "" };
    }

    throw new Error(`Unexpected command: ${key}`);
  });
}

describe("getDiffStats", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "dispatch-diffstats-"));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("returns null when no base ref resolves through the fallback chain", async () => {
    const worktreePath = tempRoot;
    const runCommand = vi.fn(async (_command: string, args: string[]) => {
      const key = args.join(" ");
      if (
        key.includes("rev-parse --verify --quiet") ||
        key.includes("rev-parse --abbrev-ref @{upstream}")
      ) {
        return fail("");
      }
      throw new Error(`Unexpected command: ${key}`);
    });

    const result = await getDiffStats(worktreePath, "main", { runCommand });
    expect(result).toBeNull();
  });

  it("returns null when merge-base can't be computed", async () => {
    const worktreePath = tempRoot;
    const runCommand = withCommands(worktreePath, "main", {
      [`-C ${worktreePath} merge-base HEAD main`]: () => fail(""),
    });

    const result = await getDiffStats(worktreePath, "main", { runCommand });
    expect(result).toBeNull();
  });

  it("counts a single tracked diff (committed-only scenario)", async () => {
    const worktreePath = tempRoot;
    const runCommand = withCommands(worktreePath, "main", {
      [`-C ${worktreePath} diff ${MERGE_BASE_SHA} --numstat`]: () =>
        ok("10\t2\tsrc/foo.ts\n5\t0\tsrc/bar.ts"),
    });

    const result = await getDiffStats(worktreePath, "main", { runCommand });
    expect(result).toMatchObject({ added: 15, deleted: 2, files: 2 });
  });

  it("compares merge-base to HEAD and skips untracked files when requested", async () => {
    const worktreePath = tempRoot;
    const committedOnlyKey = `-C ${worktreePath} diff ${MERGE_BASE_SHA} HEAD --numstat`;
    const runCommand = withCommands(worktreePath, "main", {
      [committedOnlyKey]: () => ok("4\t1\tsrc/committed.ts"),
    });

    const result = await getDiffStats(worktreePath, "main", {
      runCommand,
      includeUncommitted: false,
    });

    expect(result).toMatchObject({ added: 4, deleted: 1, files: 1 });
    expect(runCommand).toHaveBeenCalledWith(
      "git",
      ["-C", worktreePath, "diff", MERGE_BASE_SHA, "HEAD", "--numstat"],
      expect.any(Object)
    );
    expect(runCommand).not.toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["ls-files"]),
      expect.anything()
    );
  });

  it("captures committed AND uncommitted edits to the same file as one net diff", async () => {
    // Regression: the previous two-stream approach deduped by path and
    // dropped the uncommitted slice when a file appeared in both. With a
    // single `git diff <merge-base> --numstat`, git reports the net diff
    // for the file in one row — so the badge tracks the true current state.
    const worktreePath = tempRoot;
    const runCommand = withCommands(worktreePath, "main", {
      [`-C ${worktreePath} diff ${MERGE_BASE_SHA} --numstat`]: () =>
        ok("13\t2\tsrc/foo.ts"),
    });

    const result = await getDiffStats(worktreePath, "main", { runCommand });
    expect(result).toMatchObject({ added: 13, deleted: 2, files: 1 });
  });

  it("counts untracked files (line counts of new files, capped by binary detection)", async () => {
    const worktreePath = tempRoot;
    await writeFile(path.join(worktreePath, "new.ts"), "a\nb\nc\n");
    await writeFile(
      path.join(worktreePath, "blob.bin"),
      Buffer.from([0, 1, 2, 0, 5, 6])
    );

    const runCommand = withCommands(worktreePath, "main", {
      [`-C ${worktreePath} ls-files --others --exclude-standard`]: () =>
        ok("new.ts\nblob.bin"),
    });

    const result = await getDiffStats(worktreePath, "main", { runCommand });
    // new.ts contributes 3 lines, blob.bin is binary (0-byte detected) so
    // contributes 0 lines but still 1 file. Total: added=3, files=2.
    expect(result).toMatchObject({ added: 3, deleted: 0, files: 2 });
  });

  it("treats binary tracked files as 1 file with 0 lines", async () => {
    const worktreePath = tempRoot;
    const runCommand = withCommands(worktreePath, "main", {
      [`-C ${worktreePath} diff ${MERGE_BASE_SHA} --numstat`]: () =>
        ok("-\t-\tassets/logo.png\n4\t1\tsrc/foo.ts"),
    });

    const result = await getDiffStats(worktreePath, "main", { runCommand });
    expect(result).toMatchObject({ added: 4, deleted: 1, files: 2 });
  });

  it("returns zeros when there are no changes", async () => {
    const worktreePath = tempRoot;
    const runCommand = withCommands(worktreePath, "main", {});
    const result = await getDiffStats(worktreePath, "main", { runCommand });
    expect(result).toMatchObject({ added: 0, deleted: 0, files: 0 });
  });

  it("counts a single-line file without a trailing newline", async () => {
    const worktreePath = tempRoot;
    await writeFile(path.join(worktreePath, "single.ts"), "no-newline-here");

    const runCommand = withCommands(worktreePath, "main", {
      [`-C ${worktreePath} ls-files --others --exclude-standard`]: () =>
        ok("single.ts"),
    });

    const result = await getDiffStats(worktreePath, "main", { runCommand });
    expect(result).toMatchObject({ added: 1, deleted: 0, files: 1 });
  });

  it("skips line counting for untracked files larger than 1MB but still counts as 1 file", async () => {
    const worktreePath = tempRoot;
    const big = "x\n".repeat(600_000); // ~1.2MB
    await mkdir(path.join(worktreePath, "big"), { recursive: true });
    await writeFile(path.join(worktreePath, "big/data.txt"), big);

    const runCommand = withCommands(worktreePath, "main", {
      [`-C ${worktreePath} ls-files --others --exclude-standard`]: () =>
        ok("big/data.txt"),
    });

    const result = await getDiffStats(worktreePath, "main", { runCommand });
    expect(result).toMatchObject({ added: 0, deleted: 0, files: 1 });
  });

  it("includes both tracked and untracked files in the file count", async () => {
    const worktreePath = tempRoot;
    await writeFile(path.join(worktreePath, "new.ts"), "x\ny\n");

    const runCommand = withCommands(worktreePath, "main", {
      [`-C ${worktreePath} diff ${MERGE_BASE_SHA} --numstat`]: () =>
        ok("10\t2\tsrc/foo.ts\n4\t1\tsrc/bar.ts"),
      [`-C ${worktreePath} ls-files --others --exclude-standard`]: () =>
        ok("new.ts"),
    });

    const result = await getDiffStats(worktreePath, "main", { runCommand });
    expect(result).toMatchObject({ added: 16, deleted: 3, files: 3 });
  });

  it("excludes common lockfiles from tracked and untracked diff counts", async () => {
    const worktreePath = tempRoot;
    await writeFile(path.join(worktreePath, "pnpm-lock.yaml"), "ignored\n");
    await mkdir(path.join(worktreePath, "nested"), { recursive: true });
    await writeFile(
      path.join(worktreePath, "nested", "Cargo.lock"),
      "ignored\n"
    );
    await writeFile(path.join(worktreePath, "notes.txt"), "keep\nme\n");

    const runCommand = withCommands(worktreePath, "main", {
      [`-C ${worktreePath} diff ${MERGE_BASE_SHA} --numstat`]: () =>
        ok(
          "100\t250\tpnpm-lock.yaml\n50\t20\tnested/Cargo.lock\n4\t1\tsrc/foo.ts"
        ),
      [`-C ${worktreePath} ls-files --others --exclude-standard`]: () =>
        ok("pnpm-lock.yaml\nnested/Cargo.lock\nnotes.txt"),
    });

    const result = await getDiffStats(worktreePath, "main", { runCommand });
    expect(result).toMatchObject({ added: 6, deleted: 1, files: 2 });
  });

  it("falls back to origin/main when the requested baseRef does not resolve", async () => {
    const worktreePath = tempRoot;
    const runCommand = vi.fn(async (_command: string, args: string[]) => {
      const key = args.join(" ");
      if (key === `-C ${worktreePath} rev-parse --verify --quiet feature-x`) {
        return fail("");
      }
      if (key === `-C ${worktreePath} rev-parse --abbrev-ref @{upstream}`) {
        return { exitCode: 128, stdout: "", stderr: "no upstream" };
      }
      if (key === `-C ${worktreePath} rev-parse --verify --quiet origin/main`) {
        return ok("origin/main");
      }
      if (key === `-C ${worktreePath} merge-base HEAD origin/main`) {
        return ok(MERGE_BASE_SHA);
      }
      if (key === `-C ${worktreePath} diff ${MERGE_BASE_SHA} --numstat`) {
        return ok("3\t1\tsrc/foo.ts");
      }
      if (key === `-C ${worktreePath} ls-files --others --exclude-standard`) {
        return ok("");
      }
      if (args.includes("check-ignore")) {
        return fail("");
      }
      throw new Error(`Unexpected command: ${key}`);
    });

    const result = await getDiffStats(worktreePath, "feature-x", {
      runCommand,
    });
    expect(result).toMatchObject({ added: 3, deleted: 1, files: 1 });
  });

  it("prefers origin/main over local main when baseRef is main", async () => {
    const worktreePath = tempRoot;
    const runCommand = vi.fn(async (_command: string, args: string[]) => {
      const key = args.join(" ");
      if (key === `-C ${worktreePath} rev-parse --verify --quiet origin/main`) {
        return ok("origin/main");
      }
      if (key === `-C ${worktreePath} merge-base HEAD origin/main`) {
        return ok(MERGE_BASE_SHA);
      }
      if (key === `-C ${worktreePath} diff ${MERGE_BASE_SHA} --numstat`) {
        return ok("49\t6\tsrc/base-ref.ts");
      }
      if (key === `-C ${worktreePath} ls-files --others --exclude-standard`) {
        return ok("");
      }
      if (args.includes("check-ignore")) {
        return fail("");
      }
      if (key === `-C ${worktreePath} rev-parse --verify --quiet main`) {
        throw new Error("resolveBaseRef should not consult local main first");
      }
      throw new Error(`Unexpected command: ${key}`);
    });

    const result = await getDiffStats(worktreePath, "main", { runCommand });
    expect(result).toMatchObject({ added: 49, deleted: 6, files: 1 });
  });

  it("returns null when git fails outright", async () => {
    const runCommand = vi.fn(async () => {
      throw new Error("git: command not found");
    });

    const result = await getDiffStats(tempRoot, "main", { runCommand });
    expect(result).toBeNull();
  });

  it("rejects refs that start with `-` so a crafted base branch can't be parsed as a git option", async () => {
    // Defense: even if a `-`-prefixed ref reached this layer, resolveBaseRef
    // must refuse it BEFORE shelling out. Verify by asserting we never see
    // the bad ref in any git argv.
    const seen: string[][] = [];
    const runCommand = vi.fn(async (_command: string, args: string[]) => {
      seen.push(args);
      // Make every fallback fail so we end up returning null overall.
      return fail("");
    });

    const result = await getDiffStats(tempRoot, "--all", { runCommand });
    expect(result).toBeNull();
    for (const args of seen) {
      expect(args).not.toContain("--all");
    }
  });

  it("excludes gitignored tracked files from diff stats", async () => {
    const worktreePath = tempRoot;
    const runCommand = vi.fn(async (_command: string, args: string[]) => {
      const key = args.join(" ");
      if (key === `-C ${worktreePath} rev-parse --verify --quiet main`) {
        return ok("main");
      }
      if (key === `-C ${worktreePath} merge-base HEAD main`) {
        return ok(MERGE_BASE_SHA);
      }
      if (key === `-C ${worktreePath} diff ${MERGE_BASE_SHA} --numstat`) {
        return ok(
          "10\t2\tsrc/foo.ts\n500\t0\tdist/bundle.js\n3\t1\tsrc/bar.ts"
        );
      }
      if (key === `-C ${worktreePath} ls-files --others --exclude-standard`) {
        return ok("");
      }
      if (args.includes("check-ignore")) {
        return ok("dist/bundle.js");
      }
      throw new Error(`Unexpected command: ${key}`);
    });

    const result = await getDiffStats(worktreePath, "main", { runCommand });
    expect(result).toMatchObject({ added: 13, deleted: 3, files: 2 });
  });

  it("does not follow symlinks for untracked-file line counting", async () => {
    // A symlinked untracked file would otherwise let the badge act as a
    // tiny content oracle for files outside the worktree. Confirm the
    // symlink contributes 1 file but 0 lines.
    const { symlink } = await import("node:fs/promises");
    const worktreePath = tempRoot;
    const target = path.join(os.tmpdir(), "outside-the-worktree.txt");
    await writeFile(target, "secret line 1\nsecret line 2\n");
    await symlink(target, path.join(worktreePath, "link.txt"));

    const runCommand = withCommands(worktreePath, "main", {
      [`-C ${worktreePath} ls-files --others --exclude-standard`]: () =>
        ok("link.txt"),
    });

    const result = await getDiffStats(worktreePath, "main", { runCommand });
    expect(result).toMatchObject({ added: 0, deleted: 0, files: 1 });
  });
});
