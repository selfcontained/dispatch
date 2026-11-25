/*
 * Pins origin/main: on the local runner the user's own Git configuration and
 * credential helpers are theirs. main's server never runs `git config` or
 * `gh auth setup-git`, and the local runner has no GitHub sign-in at all; the
 * agent's plain git uses whatever the user already configured.
 */
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { githubHandlers } from "../../../packages/runner/src/core/github.js";
import type { Platform } from "../../../packages/runner/src/platform/types.js";
import {
  localPullRequestEvidence,
  localPullRequestStatus,
} from "../src/agents/remote/github-runner-executor.js";
import type { CommandRunner } from "../src/shared/lib/run-command.js";

it("the local runner serves only GitHub reads, with no account operations", () => {
  const handlers = githubHandlers({
    workload: { run: vi.fn() } as unknown as Platform["workload"],
    github: {
      pullRequestStatus: vi.fn(),
      pullRequestDetails: vi.fn(),
      pullRequestDiff: vi.fn(),
    },
  });
  expect(Object.keys(handlers).sort()).toEqual([
    "github.pr.details",
    "github.pr.diff",
    "github.pr.status",
  ]);
});

it("local GitHub reads run only gh reads and leave HOME untouched", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "dispatch-local-pin-"));
  const previous = process.env.HOME;
  process.env.HOME = home;
  const calls: [string, string[]][] = [];
  const run: CommandRunner = async (bin, args) => {
    calls.push([bin, args]);
    const joined = args.join(" ");
    const stdout = joined.includes("--jq .base.sha")
      ? "b".repeat(40)
      : joined.includes("/compare/")
        ? "[]"
        : joined.startsWith("pr view")
          ? JSON.stringify({ number: 1, files: [] })
          : JSON.stringify({ data: { repository: { pullRequest: null } } });
    return { stdout, stderr: "", exitCode: 0 } as Awaited<
      ReturnType<CommandRunner>
    >;
  };
  try {
    const target = { owner: "org", repo: "project", number: 1 };
    await localPullRequestStatus(run, null)
      .read(target)
      .catch(() => {});
    const evidence = localPullRequestEvidence(run);
    await evidence.details(target);
    await evidence.diff({ ...target, head: "a".repeat(40) });
    expect(calls.length).toBeGreaterThan(0);
    for (const [bin, args] of calls) {
      expect(bin).toBe("gh");
      expect(args).not.toContain("setup-git");
      expect(args).not.toContain("git-credential");
      expect(args[0]).not.toBe("auth");
      expect(args[0]).not.toBe("config");
    }
    expect(await readdir(home)).toEqual([]);
  } finally {
    process.env.HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
});
