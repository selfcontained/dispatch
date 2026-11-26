/*
 * Pins origin/main: on the local runner the user's own Git configuration and
 * credential helpers are theirs. main's server never runs `git config` or
 * `gh auth setup-git`, and the local runner has no GitHub sign-in at all; the
 * agent's plain git uses whatever the user already configured.
 */
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { pathFromWire } from "@dispatch/runner-protocol/contract";
import { githubWorkload } from "../../../packages/runner/src/workload/agents/checkout-worker.js";
import { runnerDirectory } from "../src/runners/directory.js";
import { controllerPlacement } from "../src/runners/placement.js";
import { startTestLocalRunner } from "./helpers/local-runner-child.js";
import { githubHandlers } from "../../../packages/runner/src/core/github.js";
import type { Platform } from "../../../packages/runner/src/platform/types.js";
import {
  localPullRequestEvidence,
  localPullRequestStatus,
} from "../../../packages/runner/src/workload/agents/remote/github-runner-executor.js";
import type { CommandRunner } from "../src/shared/lib/run-command.js";

it("the local runner serves only GitHub reads, with no account operations", () => {
  const handlers = githubHandlers({
    workload: { run: vi.fn() } as unknown as Platform["workload"],
    github: {
      pullRequestHead: vi.fn(),
      pullRequestStatus: vi.fn(),
      pullRequestDetails: vi.fn(),
      pullRequestDiff: vi.fn(),
    },
  });
  expect(Object.keys(handlers).sort()).toEqual([
    "github.pr.details",
    "github.pr.diff",
    "github.pr.head",
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

it("runs gh for the PR head in the chosen checkout and preserves command failures", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pr-head-"));
  const bin = path.join(cwd, "gh");
  const pr = { owner: "org", repo: "repo", number: 12, cwd: pathFromWire(cwd) };
  const command =
    "gh api repos/org/repo/pulls/12 --jq {url:.head.repo.clone_url,branch:.head.ref}";
  try {
    vi.stubEnv("PATH", cwd);
    await writeFile(path.join(cwd, "selected"), "");
    await writeFile(
      bin,
      `#!/bin/sh
test -f ./selected || exit 3
printf '%s' '{"url":"https://github.com/org/fork.git","branch":"topic"}'
`,
      { mode: 0o700 }
    );
    expect(await githubWorkload.pullRequestHead(pr)).toEqual({
      url: "https://github.com/org/fork.git",
      branch: "topic",
    });
    await writeFile(bin, "#!/bin/sh\nprintf 'fixture denied' >&2\nexit 2\n");
    await expect(githubWorkload.pullRequestHead(pr)).rejects.toThrow(
      `Command failed (${command}), exitCode=2, stderr=fixture denied`
    );
  } finally {
    vi.unstubAllEnvs();
    await rm(cwd, { force: true, recursive: true });
  }
});

it("reads the PR head once at a real child and uses the port once when the connection is lost", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pr-head-child-"));
  const bin = path.join(root, "gh");
  const head = { url: "https://github.com/org/repo.git", branch: "topic" };
  const request = {
    owner: "org",
    repo: "repo",
    number: 1,
    cwd: pathFromWire(root),
  };
  const signal = AbortSignal.timeout(10_000);
  const fallback = vi
    .spyOn(githubWorkload, "pullRequestHead")
    .mockResolvedValue(head);
  const child = startTestLocalRunner(root, {
    env: { PATH: root + path.delimiter + process.env.PATH },
    backoffMs: 60_000,
  });
  try {
    await child.ready();
    await child.session.call("runner.describe", {}, { signal });
    const call = vi.spyOn(child.session, "call");
    const runner = runnerDirectory({ child: () => child.session }).for(
      controllerPlacement
    );
    const read = () => runner.call("github.pr.head", request, { signal });
    await writeFile(bin, `#!/bin/sh\nprintf '%s' '${JSON.stringify(head)}'\n`, {
      mode: 0o700,
    });
    expect(await read()).toEqual(head);
    expect(call).toHaveBeenCalledExactlyOnceWith("github.pr.head", request, {
      signal,
      wait: false,
      timeoutMs: null,
    });
    expect(fallback).not.toHaveBeenCalled();
    call.mockClear();
    await writeFile(bin, "#!/bin/sh\nprintf '{}'\n");
    await expect(read()).rejects.toThrow(
      "GitHub pull request source branch is unavailable."
    );
    expect(call).toHaveBeenCalledTimes(1);
    expect(fallback).not.toHaveBeenCalled();
    call.mockClear();
    // The fixture gh is the child's direct subprocess. Lose the connection mid-read.
    await writeFile(bin, '#!/bin/sh\nkill -KILL "$PPID"\n');
    expect(await read()).toEqual(head);
    expect(call).toHaveBeenCalledTimes(1);
    expect(fallback).toHaveBeenCalledExactlyOnceWith(request);
  } finally {
    await child.stop();
    fallback.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
