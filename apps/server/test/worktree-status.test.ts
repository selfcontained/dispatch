import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/shared/lib/run-command.js", () => ({
  runCommand: vi.fn(),
}));

const {
  checkWorktreeStatus,
  getUncommittedChanges,
  getUnmergedChanges,
  hasOutstandingChanges,
} = await import("../src/shared/git/worktree-status.js");
const { runCommand } = await import("../src/shared/lib/run-command.js");

const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" });
const fail = (stdout = "") => ({ exitCode: 1, stdout, stderr: "" });

beforeEach(() => {
  vi.mocked(runCommand).mockReset();
});

const matchArgs = (args: string[], pattern: string[]) =>
  pattern.every((p, i) => args[i] === p);

describe("getUncommittedChanges", () => {
  it("returns empty arrays when git status is clean", async () => {
    vi.mocked(runCommand).mockResolvedValue(ok(""));
    const result = await getUncommittedChanges("/wt");
    expect(result).toEqual({
      hasUncommittedChanges: false,
      uncommittedFiles: [],
    });
  });

  it("parses git status --porcelain output line-by-line", async () => {
    // Note: the function applies `.trim()` to the whole stdout before
    // splitting, which strips leading whitespace on the FIRST line. For
    // porcelain output, the first column can be a space (` M` = modified
    // unstaged), which gets eaten. Locking in current behaviour — the
    // consumers (UI status display) don't parse the status code so this
    // is cosmetic; flagged for a future pure-cleanup pass.
    vi.mocked(runCommand).mockResolvedValue(
      ok(" M src/foo.ts\n?? new-file.txt\nM  src/bar.ts")
    );
    const result = await getUncommittedChanges("/wt");
    expect(result.hasUncommittedChanges).toBe(true);
    expect(result.uncommittedFiles).toEqual([
      "M src/foo.ts", // leading space lost via outer .trim()
      "?? new-file.txt",
      "M  src/bar.ts",
    ]);
  });

  it("falls back to clean on git failure (soft-clean philosophy)", async () => {
    vi.mocked(runCommand).mockRejectedValue(new Error("git not found"));
    const result = await getUncommittedChanges("/wt");
    expect(result).toEqual({
      hasUncommittedChanges: false,
      uncommittedFiles: [],
    });
  });

  it("invokes git status --porcelain in the supplied worktree path", async () => {
    vi.mocked(runCommand).mockResolvedValue(ok(""));
    await getUncommittedChanges("/path/to/wt");
    const call = vi.mocked(runCommand).mock.calls[0];
    expect(call?.[0]).toBe("git");
    expect(call?.[1]).toEqual(["-C", "/path/to/wt", "status", "--porcelain"]);
  });
});

describe("getUnmergedChanges", () => {
  // Helper: stub the typical multi-call sequence inside getUnmergedChanges.
  // The function fires several git invocations in a fixed order:
  //   1. rev-parse --abbrev-ref @{upstream}        — discover upstream
  //   2. fetch origin <branch>                      — refresh remote
  //   3. rev-parse --verify <upstream>              — resolve base ref
  //   4. (if step 3 fails)  rev-parse --verify origin/main, then main
  //   5. merge-tree --write-tree <base> HEAD        — simulate merge
  //   6. rev-parse <base>^{tree}                    — base tree hash
  //   7. (if trees differ) diff --name-only <base> <result>
  // Tests below stub by matching argv prefixes.

  const stubByArgs = (
    handlers: Array<{ match: string[]; result: ReturnType<typeof ok> }>
  ) => {
    vi.mocked(runCommand).mockImplementation(
      async (_cmd: string, args: string[]) => {
        for (const h of handlers) {
          if (matchArgs(args, h.match)) return h.result;
        }
        return fail();
      }
    );
  };

  it("returns clean when there is no upstream and no fallback base resolves", async () => {
    stubByArgs([
      // upstream lookup fails
      { match: ["-C", "/wt", "rev-parse", "--abbrev-ref"], result: fail() },
      // fetch returns ok, doesn't matter
      { match: ["-C", "/wt", "fetch"], result: ok() },
      // both fallback resolves return non-zero (ref not found)
      // (default fallthrough is fail() via stubByArgs)
    ]);

    const result = await getUnmergedChanges("/wt");
    expect(result).toEqual({ hasUnmergedCommits: false, changedFiles: [] });
  });

  it("returns clean when merge-tree result matches the base tree exactly (already merged)", async () => {
    const baseTreeHash = "abc123baseTree";
    stubByArgs([
      { match: ["-C", "/wt", "rev-parse", "--abbrev-ref"], result: fail() },
      { match: ["-C", "/wt", "fetch"], result: ok() },
      // origin/main resolves
      {
        match: ["-C", "/wt", "rev-parse", "--verify", "--quiet", "origin/main"],
        result: ok("origin/main"),
      },
      // merge-tree returns the same hash as the base tree → already merged
      {
        match: ["-C", "/wt", "merge-tree", "--write-tree"],
        result: ok(baseTreeHash),
      },
      {
        match: ["-C", "/wt", "rev-parse", "origin/main^{tree}"],
        result: ok(baseTreeHash),
      },
    ]);

    const result = await getUnmergedChanges("/wt");
    expect(result).toEqual({ hasUnmergedCommits: false, changedFiles: [] });
  });

  it("returns dirty + file list when merge-tree differs from the base tree", async () => {
    stubByArgs([
      { match: ["-C", "/wt", "rev-parse", "--abbrev-ref"], result: fail() },
      { match: ["-C", "/wt", "fetch"], result: ok() },
      {
        match: ["-C", "/wt", "rev-parse", "--verify", "--quiet", "origin/main"],
        result: ok("origin/main"),
      },
      {
        match: ["-C", "/wt", "merge-tree", "--write-tree"],
        result: ok("resultTreeXYZ"),
      },
      {
        match: ["-C", "/wt", "rev-parse", "origin/main^{tree}"],
        result: ok("baseTreeABC"),
      },
      {
        match: ["-C", "/wt", "diff", "--name-only"],
        result: ok("src/foo.ts\nsrc/bar.ts"),
      },
    ]);

    const result = await getUnmergedChanges("/wt");
    expect(result.hasUnmergedCommits).toBe(true);
    expect(result.changedFiles).toEqual(["src/foo.ts", "src/bar.ts"]);
  });

  it("uses @{upstream} as the base when one is configured", async () => {
    stubByArgs([
      {
        match: ["-C", "/wt", "rev-parse", "--abbrev-ref", "@{upstream}"],
        result: ok("origin/feature-x"),
      },
      { match: ["-C", "/wt", "fetch"], result: ok() },
      {
        match: [
          "-C",
          "/wt",
          "rev-parse",
          "--verify",
          "--quiet",
          "origin/feature-x",
        ],
        result: ok("origin/feature-x"),
      },
      {
        match: ["-C", "/wt", "merge-tree", "--write-tree"],
        result: ok("sameTree"),
      },
      {
        match: ["-C", "/wt", "rev-parse", "origin/feature-x^{tree}"],
        result: ok("sameTree"),
      },
    ]);

    await getUnmergedChanges("/wt");

    // Confirms the fetch targeted the upstream's *branch* (without the
    // origin/ prefix) — verifies the slice("origin/".length) logic.
    const fetchCall = vi
      .mocked(runCommand)
      .mock.calls.find((c) => c[1].includes("fetch"));
    expect(fetchCall?.[1]).toContain("feature-x");
    expect(fetchCall?.[1]).not.toContain("origin/feature-x");
  });

  it("returns clean on any thrown error (soft-clean philosophy)", async () => {
    vi.mocked(runCommand).mockRejectedValue(new Error("boom"));
    const result = await getUnmergedChanges("/wt");
    expect(result).toEqual({ hasUnmergedCommits: false, changedFiles: [] });
  });
});

describe("hasOutstandingChanges", () => {
  it("is true when only uncommitted changes exist", async () => {
    vi.mocked(runCommand).mockImplementation(
      async (_cmd: string, args: string[]) => {
        if (args.includes("status") && args.includes("--porcelain")) {
          return ok(" M dirty.ts");
        }
        if (args.includes("rev-parse") && args.includes("--abbrev-ref")) {
          return fail();
        }
        return fail();
      }
    );
    expect(await hasOutstandingChanges("/wt")).toBe(true);
  });

  it("is true when only unmerged commits exist", async () => {
    vi.mocked(runCommand).mockImplementation(
      async (_cmd: string, args: string[]) => {
        if (args.includes("status") && args.includes("--porcelain")) {
          return ok(""); // clean working tree
        }
        if (args.includes("--abbrev-ref")) {
          return fail();
        }
        if (args.includes("fetch")) {
          return ok();
        }
        if (
          args.includes("--verify") &&
          (args.includes("origin/main") || args.includes("main"))
        ) {
          return ok(args.find((a) => a === "origin/main" || a === "main")!);
        }
        if (args.includes("merge-tree")) {
          return ok("differentTree");
        }
        if (
          args.includes("rev-parse") &&
          args.some((a) => a.endsWith("^{tree}"))
        ) {
          return ok("baseTree");
        }
        if (args.includes("diff") && args.includes("--name-only")) {
          return ok("changed.ts");
        }
        return fail();
      }
    );
    expect(await hasOutstandingChanges("/wt")).toBe(true);
  });

  it("is false when worktree is fully clean and merged", async () => {
    vi.mocked(runCommand).mockImplementation(
      async (_cmd: string, args: string[]) => {
        if (args.includes("status") && args.includes("--porcelain")) {
          return ok("");
        }
        if (args.includes("--abbrev-ref")) {
          return fail();
        }
        if (args.includes("fetch")) {
          return ok();
        }
        if (
          args.includes("--verify") &&
          (args.includes("origin/main") || args.includes("main"))
        ) {
          return ok("origin/main");
        }
        if (args.includes("merge-tree")) {
          return ok("sameTree");
        }
        if (
          args.includes("rev-parse") &&
          args.some((a) => a.endsWith("^{tree}"))
        ) {
          return ok("sameTree");
        }
        return fail();
      }
    );
    expect(await hasOutstandingChanges("/wt")).toBe(false);
  });
});

describe("checkWorktreeStatus", () => {
  it("always returns hasWorktree:true (caller handles the no-worktree case)", async () => {
    vi.mocked(runCommand).mockImplementation(
      async (_cmd: string, args: string[]) => {
        if (args.includes("symbolic-ref")) return ok("feature-x");
        if (args.includes("status") && args.includes("--porcelain"))
          return ok("");
        if (args.includes("--abbrev-ref")) return fail();
        return fail();
      }
    );
    const result = await checkWorktreeStatus("/wt");
    expect(result.hasWorktree).toBe(true);
    expect(result.worktreePath).toBe("/wt");
  });

  it("populates branchName from `git symbolic-ref --short -q HEAD`", async () => {
    vi.mocked(runCommand).mockImplementation(
      async (_cmd: string, args: string[]) => {
        if (args.includes("symbolic-ref")) return ok("my-branch");
        if (args.includes("status") && args.includes("--porcelain"))
          return ok("");
        if (args.includes("--abbrev-ref")) return fail();
        return fail();
      }
    );
    const result = await checkWorktreeStatus("/wt");
    expect(result.branchName).toBe("my-branch");
  });

  it("reports null branchName on detached HEAD (symbolic-ref exits non-zero)", async () => {
    vi.mocked(runCommand).mockImplementation(
      async (_cmd: string, args: string[]) => {
        if (args.includes("symbolic-ref")) return fail();
        if (args.includes("status") && args.includes("--porcelain"))
          return ok("");
        if (args.includes("--abbrev-ref")) return fail();
        return fail();
      }
    );
    const result = await checkWorktreeStatus("/wt");
    expect(result.branchName).toBeNull();
  });

  it("merges results from both inspectors into a single status record", async () => {
    vi.mocked(runCommand).mockImplementation(
      async (_cmd: string, args: string[]) => {
        if (args.includes("symbolic-ref")) return ok("topic");
        if (args.includes("status") && args.includes("--porcelain")) {
          return ok(" M src/dirty.ts");
        }
        if (args.includes("--abbrev-ref")) return fail();
        if (args.includes("fetch")) return ok();
        if (
          args.includes("--verify") &&
          (args.includes("origin/main") || args.includes("main"))
        ) {
          return ok("origin/main");
        }
        if (args.includes("merge-tree")) return ok("resultTree");
        if (
          args.includes("rev-parse") &&
          args.some((a) => a.endsWith("^{tree}"))
        ) {
          return ok("baseTree");
        }
        if (args.includes("diff") && args.includes("--name-only")) {
          return ok("src/feature.ts");
        }
        return fail();
      }
    );

    const result = await checkWorktreeStatus("/wt");
    expect(result).toEqual({
      hasWorktree: true,
      hasUnmergedCommits: true,
      hasUncommittedChanges: true,
      worktreePath: "/wt",
      branchName: "topic",
      changedFiles: ["src/feature.ts"],
      uncommittedFiles: ["M src/dirty.ts"], // leading space lost via outer .trim()
    });
  });
});
