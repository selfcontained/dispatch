import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RunCommandResult } from "../src/shared/lib/run-command.js";
import { getDiffStats } from "../src/shared/git/diff-stats.js";

type CommandKey = string;
type CommandHandler = () => RunCommandResult;

function ok(stdout = ""): RunCommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}

function withCommands(
  worktreePath: string,
  baseRef: string,
  handlers: Record<CommandKey, CommandHandler>
) {
  const baseCheckKey = `-C ${worktreePath} rev-parse --verify --quiet ${baseRef}`;
  const committedKey = `-C ${worktreePath} diff ${baseRef}...HEAD --numstat`;
  const uncommittedKey = `-C ${worktreePath} diff HEAD --numstat`;
  const untrackedKey = `-C ${worktreePath} ls-files --others --exclude-standard`;

  const merged: Record<CommandKey, CommandHandler> = {
    [baseCheckKey]: () => ok("abc123"),
    [committedKey]: () => ok(""),
    [uncommittedKey]: () => ok(""),
    [untrackedKey]: () => ok(""),
    ...handlers,
  };

  return vi.fn(async (_command: string, args: string[]) => {
    const key = args.join(" ");
    const handler = merged[key];
    if (!handler) {
      throw new Error(`Unexpected command: ${key}`);
    }
    return handler();
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

  it("returns null when base ref can't be resolved", async () => {
    const worktreePath = tempRoot;
    const runCommand = vi.fn(async (_command: string, args: string[]) => {
      const key = args.join(" ");
      if (key === `-C ${worktreePath} rev-parse --verify --quiet main`) {
        return { exitCode: 1, stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected command: ${key}`);
    });

    const result = await getDiffStats(worktreePath, "main", { runCommand });
    expect(result).toBeNull();
  });

  it("counts committed-only changes", async () => {
    const worktreePath = tempRoot;
    const runCommand = withCommands(worktreePath, "main", {
      [`-C ${worktreePath} diff main...HEAD --numstat`]: () =>
        ok("10\t2\tsrc/foo.ts\n5\t0\tsrc/bar.ts"),
    });

    const result = await getDiffStats(worktreePath, "main", { runCommand });
    expect(result).toMatchObject({ added: 15, deleted: 2, files: 2 });
  });

  it("counts uncommitted-only changes", async () => {
    const worktreePath = tempRoot;
    const runCommand = withCommands(worktreePath, "main", {
      [`-C ${worktreePath} diff HEAD --numstat`]: () => ok("3\t1\tsrc/baz.ts"),
    });

    const result = await getDiffStats(worktreePath, "main", { runCommand });
    expect(result).toMatchObject({ added: 3, deleted: 1, files: 1 });
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

  it("treats binary committed files as 1 file with 0 lines", async () => {
    const worktreePath = tempRoot;
    const runCommand = withCommands(worktreePath, "main", {
      [`-C ${worktreePath} diff main...HEAD --numstat`]: () =>
        ok("-\t-\tassets/logo.png\n4\t1\tsrc/foo.ts"),
    });

    const result = await getDiffStats(worktreePath, "main", { runCommand });
    expect(result).toMatchObject({ added: 4, deleted: 1, files: 2 });
  });

  it("dedupes a file that appears in both committed and uncommitted diffs", async () => {
    const worktreePath = tempRoot;
    const runCommand = withCommands(worktreePath, "main", {
      [`-C ${worktreePath} diff main...HEAD --numstat`]: () =>
        ok("10\t2\tsrc/foo.ts"),
      [`-C ${worktreePath} diff HEAD --numstat`]: () => ok("3\t0\tsrc/foo.ts"),
    });

    const result = await getDiffStats(worktreePath, "main", { runCommand });
    expect(result).toMatchObject({ added: 10, deleted: 2, files: 1 });
  });

  it("mixed committed + uncommitted + untracked", async () => {
    const worktreePath = tempRoot;
    await writeFile(path.join(worktreePath, "new.ts"), "x\ny\n");

    const runCommand = withCommands(worktreePath, "main", {
      [`-C ${worktreePath} diff main...HEAD --numstat`]: () =>
        ok("10\t2\tsrc/foo.ts"),
      [`-C ${worktreePath} diff HEAD --numstat`]: () => ok("4\t1\tsrc/bar.ts"),
      [`-C ${worktreePath} ls-files --others --exclude-standard`]: () =>
        ok("new.ts"),
    });

    const result = await getDiffStats(worktreePath, "main", { runCommand });
    expect(result).toMatchObject({ added: 16, deleted: 3, files: 3 });
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

  it("returns null when git fails outright", async () => {
    const runCommand = vi.fn(async () => {
      throw new Error("git: command not found");
    });

    const result = await getDiffStats(tempRoot, "main", { runCommand });
    expect(result).toBeNull();
  });
});
