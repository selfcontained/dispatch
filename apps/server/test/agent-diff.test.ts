import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RunCommandResult } from "../src/shared/lib/run-command.js";
import {
  getAgentDiff,
  getAgentFileDiff,
} from "../src/shared/git/agent-diff.js";

const WORKTREE = "/fake/worktree";
const BASE_REF = "main";
const MERGE_BASE_SHA = "abc123";

function ok(stdout = ""): RunCommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}

function generateDiffLines(filePath: string, lineCount: number): string {
  const header = [
    `diff --git a/${filePath} b/${filePath}`,
    `new file mode 100644`,
    `index 0000000..1234567`,
    `--- /dev/null`,
    `+++ b/${filePath}`,
    `@@ -0,0 +1,${lineCount} @@`,
  ];
  const added = Array.from({ length: lineCount }, (_, i) => `+line ${i + 1}`);
  return [...header, ...added].join("\n");
}

function makeMockRunner(
  numstat: string,
  nameStatus: string,
  unifiedDiff: string,
  untrackedFiles = ""
) {
  return async (
    _cmd: string,
    args: string[],
    _opts?: { cwd?: string; allowedExitCodes?: number[]; timeoutMs?: number }
  ): Promise<RunCommandResult> => {
    const joined = args.join(" ");
    if (joined.includes("rev-parse --verify")) return ok(BASE_REF);
    if (joined.includes("merge-base")) return ok(MERGE_BASE_SHA);
    if (joined.includes("ls-files")) return ok(untrackedFiles);
    if (joined.includes("--numstat")) return ok(numstat);
    if (joined.includes("--name-status")) return ok(nameStatus);
    if (joined.includes("-U3")) return ok(unifiedDiff);
    return ok();
  };
}

describe("getAgentDiff truncation", () => {
  it("marks a file as truncated when diff exceeds 2000 lines", async () => {
    const diff = generateDiffLines("big-file.ts", 2100);
    const runner = makeMockRunner(
      "2100\t0\tbig-file.ts",
      "A\tbig-file.ts",
      diff
    );

    const result = await getAgentDiff(WORKTREE, BASE_REF, runner);
    expect(result).not.toBeNull();
    const file = result!.files.find((f) => f.path === "big-file.ts");
    expect(file).toBeDefined();
    expect(file!.truncated).toBe(true);
    expect(file!.diff).toBeNull();
    expect(file!.added).toBe(2100);
    expect(file!.status).toBe("added");
  });

  it("does not truncate a file under 2000 lines", async () => {
    const diff = generateDiffLines("small-file.ts", 500);
    const runner = makeMockRunner(
      "500\t0\tsmall-file.ts",
      "A\tsmall-file.ts",
      diff
    );

    const result = await getAgentDiff(WORKTREE, BASE_REF, runner);
    expect(result).not.toBeNull();
    const file = result!.files.find((f) => f.path === "small-file.ts");
    expect(file).toBeDefined();
    expect(file!.truncated).toBe(false);
    expect(file!.diff).not.toBeNull();
  });

  it("marks a file as truncated when diff exceeds 100KB", async () => {
    const longLine = "x".repeat(200);
    const header = [
      "diff --git a/big.bin b/big.bin",
      "new file mode 100644",
      "index 0000000..1234567",
      "--- /dev/null",
      "+++ b/big.bin",
      "@@ -0,0 +1,600 @@",
    ];
    const lines = Array.from({ length: 600 }, () => `+${longLine}`);
    const diff = [...header, ...lines].join("\n");

    const runner = makeMockRunner("600\t0\tbig.bin", "A\tbig.bin", diff);

    const result = await getAgentDiff(WORKTREE, BASE_REF, runner);
    const file = result!.files.find((f) => f.path === "big.bin");
    expect(file).toBeDefined();
    expect(file!.truncated).toBe(true);
    expect(file!.diff).toBeNull();
  });

  it("preserves truncated files in the file list with stats", async () => {
    const smallDiff = generateDiffLines("small.ts", 10);
    const bigDiff = generateDiffLines("big.ts", 2500);
    const combined = smallDiff + "\n" + bigDiff;

    const runner = makeMockRunner(
      "10\t0\tsmall.ts\n2500\t0\tbig.ts",
      "A\tsmall.ts\nA\tbig.ts",
      combined
    );

    const result = await getAgentDiff(WORKTREE, BASE_REF, runner);
    expect(result).not.toBeNull();
    expect(result!.files).toHaveLength(2);

    const small = result!.files.find((f) => f.path === "small.ts");
    expect(small!.truncated).toBe(false);
    expect(small!.diff).not.toBeNull();
    expect(small!.added).toBe(10);

    const big = result!.files.find((f) => f.path === "big.ts");
    expect(big!.truncated).toBe(true);
    expect(big!.diff).toBeNull();
    expect(big!.added).toBe(2500);
    expect(big!.status).toBe("added");
  });

  it("handles a modified file with many added lines", async () => {
    const header = [
      "diff --git a/existing.ts b/existing.ts",
      "index 1234567..abcdef0 100644",
      "--- a/existing.ts",
      "+++ b/existing.ts",
      "@@ -1,3 +1,2103 @@",
    ];
    const context = [" const x = 1;", " const y = 2;", " const z = 3;"];
    const added = Array.from({ length: 2100 }, (_, i) => `+new line ${i + 1}`);
    const diff = [...header, ...context, ...added].join("\n");

    const runner = makeMockRunner(
      "2100\t0\texisting.ts",
      "M\texisting.ts",
      diff
    );

    const result = await getAgentDiff(WORKTREE, BASE_REF, runner);
    const file = result!.files.find((f) => f.path === "existing.ts");
    expect(file).toBeDefined();
    expect(file!.truncated).toBe(true);
    expect(file!.diff).toBeNull();
    expect(file!.status).toBe("modified");
    expect(file!.added).toBe(2100);
  });

  it("handles renamed files with brace syntax in numstat", async () => {
    const diff = [
      "diff --git a/src/new-name.ts b/src/new-name.ts",
      "similarity index 90%",
      "rename from src/old-name.ts",
      "rename to src/new-name.ts",
      "--- a/src/old-name.ts",
      "+++ b/src/new-name.ts",
      "@@ -1,3 +1,5 @@",
      " const a = 1;",
      "+const b = 2;",
      "+const c = 3;",
      " const d = 4;",
    ].join("\n");

    const runner = makeMockRunner(
      "2\t0\tsrc/{old-name.ts => new-name.ts}",
      "R100\tsrc/old-name.ts\tsrc/new-name.ts",
      diff
    );

    const result = await getAgentDiff(WORKTREE, BASE_REF, runner);
    expect(result!.files).toHaveLength(1);
    const file = result!.files[0]!;
    expect(file.path).toBe("src/new-name.ts");
    expect(file.oldPath).toBe("src/old-name.ts");
    expect(file.status).toBe("renamed");
    expect(file.added).toBe(2);
    expect(file.diff).toBe(diff);
  });

  it("handles cross-directory renames with brace syntax", async () => {
    const diff = [
      "diff --git a/lib/util.ts b/src/util.ts",
      "similarity index 100%",
      "rename from lib/util.ts",
      "rename to src/util.ts",
    ].join("\n");

    const runner = makeMockRunner(
      "0\t0\t{lib => src}/util.ts",
      "R100\tlib/util.ts\tsrc/util.ts",
      diff
    );

    const result = await getAgentDiff(WORKTREE, BASE_REF, runner);
    expect(result!.files).toHaveLength(1);
    const file = result!.files[0]!;
    expect(file.path).toBe("src/util.ts");
    expect(file.oldPath).toBe("lib/util.ts");
    expect(file.status).toBe("renamed");
  });

  it("flags test files so the client never re-derives the rule", async () => {
    const runner = makeMockRunner(
      [
        "4\t0\tsrc/app.ts",
        "9\t1\tsrc/app.test.ts",
        // A move into a test directory: classified by where it lands, the
        // same way getDiffStats counts it.
        "1\t1\tsrc/{lib => test}/helper.ts",
        // Prose that merely looks spec-ish stays a normal file.
        "2\t0\tdocs/api-spec.md",
      ].join("\n"),
      "",
      ""
    );

    const result = await getAgentDiff(WORKTREE, BASE_REF, runner);
    const flags = Object.fromEntries(
      result!.files.map((file) => [file.path, file.isTest])
    );

    expect(flags).toEqual({
      "src/app.ts": false,
      "src/app.test.ts": true,
      "src/test/helper.ts": true,
      "docs/api-spec.md": false,
    });
  });

  it("excludes lock files from results", async () => {
    const diff = generateDiffLines("pnpm-lock.yaml", 100);
    const runner = makeMockRunner(
      "5000\t2000\tpnpm-lock.yaml",
      "M\tpnpm-lock.yaml",
      diff
    );

    const result = await getAgentDiff(WORKTREE, BASE_REF, runner);
    expect(result!.files).toHaveLength(0);
  });
});

describe("getAgentDiff untracked files", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "agent-diff-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("includes small untracked files with synthetic diff", async () => {
    const content = "line 1\nline 2\nline 3\n";
    await writeFile(path.join(tmpDir, "new-file.ts"), content);

    const runner = makeMockRunner("", "", "", "new-file.ts");

    const result = await getAgentDiff(tmpDir, BASE_REF, runner);
    expect(result).not.toBeNull();
    expect(result!.files).toHaveLength(1);

    const file = result!.files[0]!;
    expect(file.path).toBe("new-file.ts");
    expect(file.status).toBe("added");
    expect(file.added).toBe(3);
    expect(file.deleted).toBe(0);
    expect(file.truncated).toBe(false);
    expect(file.diff).toContain("+line 1");
    expect(file.diff).toContain("+line 2");
    expect(file.diff).toContain("+line 3");
    expect(file.diff).toContain("--- /dev/null");
  });

  it("marks large untracked files as truncated", async () => {
    const lines = Array.from({ length: 2500 }, (_, i) => `line ${i}`).join(
      "\n"
    );
    await writeFile(path.join(tmpDir, "huge.ts"), lines);

    const runner = makeMockRunner("", "", "", "huge.ts");

    const result = await getAgentDiff(tmpDir, BASE_REF, runner);
    const file = result!.files[0]!;
    expect(file.path).toBe("huge.ts");
    expect(file.status).toBe("added");
    expect(file.added).toBe(2500);
    expect(file.truncated).toBe(true);
    expect(file.diff).toBeNull();
  });

  it("includes untracked files alongside tracked files", async () => {
    const trackedDiff = generateDiffLines("tracked.ts", 10);
    await writeFile(path.join(tmpDir, "untracked.ts"), "hello\nworld\n");

    const runner = makeMockRunner(
      "10\t0\ttracked.ts",
      "A\ttracked.ts",
      trackedDiff,
      "untracked.ts"
    );

    const result = await getAgentDiff(tmpDir, BASE_REF, runner);
    expect(result!.files).toHaveLength(2);

    const tracked = result!.files.find((f) => f.path === "tracked.ts");
    expect(tracked).toBeDefined();
    expect(tracked!.status).toBe("added");

    const untracked = result!.files.find((f) => f.path === "untracked.ts");
    expect(untracked).toBeDefined();
    expect(untracked!.status).toBe("added");
    expect(untracked!.added).toBe(2);
  });

  it("excludes untracked lock files", async () => {
    await writeFile(path.join(tmpDir, "pnpm-lock.yaml"), "content\n");

    const runner = makeMockRunner("", "", "", "pnpm-lock.yaml");

    const result = await getAgentDiff(tmpDir, BASE_REF, runner);
    expect(result!.files).toHaveLength(0);
  });

  it("handles untracked files in subdirectories", async () => {
    await mkdir(path.join(tmpDir, "src", "lib"), { recursive: true });
    await writeFile(path.join(tmpDir, "src", "lib", "util.ts"), "export {};\n");

    const runner = makeMockRunner("", "", "", "src/lib/util.ts");

    const result = await getAgentDiff(tmpDir, BASE_REF, runner);
    expect(result!.files).toHaveLength(1);
    expect(result!.files[0]!.path).toBe("src/lib/util.ts");
    expect(result!.files[0]!.added).toBe(1);
  });
});

describe("getAgentDiff stats consistency", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "agent-diff-stats-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("file count includes both tracked and untracked files", async () => {
    const trackedDiff = generateDiffLines("a.ts", 5);
    await writeFile(path.join(tmpDir, "b.ts"), "new\nfile\n");

    const runner = makeMockRunner("5\t0\ta.ts", "A\ta.ts", trackedDiff, "b.ts");

    const result = await getAgentDiff(tmpDir, BASE_REF, runner);
    expect(result!.files).toHaveLength(2);

    const totalAdded = result!.files.reduce((sum, f) => sum + f.added, 0);
    const totalDeleted = result!.files.reduce((sum, f) => sum + f.deleted, 0);
    expect(totalAdded).toBe(7);
    expect(totalDeleted).toBe(0);
  });

  it("truncated files preserve their added/deleted counts", async () => {
    const bigDiff = generateDiffLines("big.ts", 2500);
    const runner = makeMockRunner("2500\t3\tbig.ts", "M\tbig.ts", bigDiff);

    const result = await getAgentDiff(WORKTREE, BASE_REF, runner);
    const file = result!.files[0]!;
    expect(file.truncated).toBe(true);
    expect(file.added).toBe(2500);
    expect(file.deleted).toBe(3);
  });

  it("uses committed-only ranges and omits untracked files when requested", async () => {
    await writeFile(path.join(tmpDir, "uncommitted.ts"), "not committed\n");
    const committedDiff = generateDiffLines("committed.ts", 2);
    const runner = vi.fn(
      makeMockRunner(
        "2\t0\tcommitted.ts",
        "A\tcommitted.ts",
        committedDiff,
        "uncommitted.ts"
      )
    );

    const result = await getAgentDiff(tmpDir, BASE_REF, runner, {
      includeUncommitted: false,
    });

    expect(result!.files.map((file) => file.path)).toEqual(["committed.ts"]);
    expect(
      runner.mock.calls
        .map(([, args]) => args.join(" "))
        .filter((args) => args.includes(" diff "))
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining(`diff ${MERGE_BASE_SHA} HEAD`),
      ])
    );
    expect(
      runner.mock.calls.some(([, args]) => args.includes("ls-files"))
    ).toBe(false);
  });
});

describe("getAgentFileDiff (force load)", () => {
  it("returns full diff for a truncated file when force-loaded", async () => {
    const diff = generateDiffLines("big-file.ts", 2500);

    const runner = async (
      _cmd: string,
      args: string[],
      _opts?: {
        cwd?: string;
        allowedExitCodes?: number[];
        timeoutMs?: number;
      }
    ): Promise<RunCommandResult> => {
      const joined = args.join(" ");
      if (joined.includes("rev-parse --verify")) return ok(BASE_REF);
      if (joined.includes("merge-base")) return ok(MERGE_BASE_SHA);
      if (joined.includes("--numstat")) return ok("2500\t0\tbig-file.ts");
      if (joined.includes("--name-status")) return ok("A\tbig-file.ts");
      if (joined.includes("-U3")) return ok(diff);
      return ok();
    };

    const result = await getAgentFileDiff(
      WORKTREE,
      BASE_REF,
      "big-file.ts",
      runner
    );
    expect(result).not.toBeNull();
    expect(result!.path).toBe("big-file.ts");
    expect(result!.diff).toBe(diff);
    expect(result!.added).toBe(2500);
  });

  it("returns synthetic diff for untracked file force-load", async () => {
    const tmpDir = await mkdtemp(
      path.join(os.tmpdir(), "agent-diff-file-test-")
    );
    try {
      await writeFile(path.join(tmpDir, "new.ts"), "hello\nworld\n");

      const runner = async (
        _cmd: string,
        args: string[],
        _opts?: {
          cwd?: string;
          allowedExitCodes?: number[];
          timeoutMs?: number;
        }
      ): Promise<RunCommandResult> => {
        const joined = args.join(" ");
        if (joined.includes("rev-parse --verify")) return ok(BASE_REF);
        if (joined.includes("merge-base")) return ok(MERGE_BASE_SHA);
        if (joined.includes("--numstat")) return ok("");
        if (joined.includes("--name-status")) return ok("");
        if (joined.includes("-U3")) return ok("");
        return ok();
      };

      const result = await getAgentFileDiff(tmpDir, BASE_REF, "new.ts", runner);
      expect(result).not.toBeNull();
      expect(result!.path).toBe("new.ts");
      expect(result!.status).toBe("added");
      expect(result!.added).toBe(2);
      expect(result!.diff).toContain("+hello");
      expect(result!.diff).toContain("+world");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not force-load an untracked file in committed-only mode", async () => {
    const tmpDir = await mkdtemp(
      path.join(os.tmpdir(), "agent-diff-file-committed-test-")
    );
    try {
      await writeFile(path.join(tmpDir, "new.ts"), "uncommitted\n");
      const runner = makeMockRunner("", "", "");

      const result = await getAgentFileDiff(
        tmpDir,
        BASE_REF,
        "new.ts",
        runner,
        { includeUncommitted: false }
      );

      expect(result).toBeNull();
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
