/*
 * `github.pr.status`: one executor for every placement. Main's local read
 * (credential-scoped first, else the plain query shared for a minute) is
 * pinned here with fixture commands only; nothing reaches GitHub.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PULL_REQUEST_ACTIVE_REFRESH_MS,
  type GitHubPullRequestObservation,
} from "@dispatch/runner-protocol";
import {
  RunnerCallError,
  type Runner,
} from "@dispatch/runner-protocol/contract";
import type { Pool } from "pg";

const childFallback = vi.hoisted(() => ({
  pullRequestStatus: vi.fn(),
}));
vi.mock(
  "../../../packages/runner/src/workload/agents/checkout-worker.js",
  async (original) => ({
    ...(await original<
      typeof import("../../../packages/runner/src/workload/agents/checkout-worker.js")
    >()),
    githubWorkload: childFallback,
  })
);

import {
  GitHubPullRequestStatus,
  localPullRequestStatus,
} from "../../../packages/runner/src/workload/agents/remote/github-runner-executor.js";
import {
  createRunnerPullRequestReader,
  pullRequestQueryArgs,
} from "../src/agents/pull-request-reader.js";
import { createLocalCheckoutRunner } from "../src/runners/local.js";
import { PullRequestRefresher } from "../src/agents/pull-request-refresher.js";
import type { CommandRunner } from "../src/shared/lib/run-command.js";

const target = { owner: "a", repo: "b", number: 1 };
const scoped: GitHubPullRequestObservation = {
  state: "OPEN",
  draft: false,
  title: "Scoped",
  head: "sha",
  rollup: [],
  credentialContext: "c".repeat(64),
};
const plainStdout = JSON.stringify({
  data: {
    repository: {
      pullRequest: {
        state: "MERGED",
        isDraft: false,
        title: "Plain",
        headRefOid: "sha",
        commits: {
          nodes: [{ commit: { oid: "sha", statusCheckRollup: null } }],
        },
      },
    },
  },
});

function commands(stdout = plainStdout) {
  return vi.fn<CommandRunner>(async () => ({
    exitCode: 0,
    stdout,
    stderr: "",
  }));
}

afterEach(() => {
  vi.useRealTimers();
  childFallback.pullRequestStatus.mockReset();
});

describe("the pull request status executor", () => {
  it("reads with the credential scope first and does not cache it", async () => {
    const run = commands();
    const status = vi.fn(async () => scoped);
    const executor = localPullRequestStatus(run, { status });
    expect(await executor.read(target)).toEqual(scoped);
    expect(await executor.read(target)).toEqual(scoped);
    expect(status).toHaveBeenCalledTimes(2);
    expect(run).not.toHaveBeenCalled();
  });

  it("falls back to main's plain query and shares its answer for a minute", async () => {
    vi.useFakeTimers();
    const run = commands();
    const status = vi.fn(async () => {
      throw new Error("no token");
    });
    const executor = localPullRequestStatus(run, { status });
    const [first, second] = await Promise.all([
      executor.read(target),
      executor.read({ owner: "A", repo: "B", number: 1 }),
    ]);
    expect(first).toEqual({
      state: "MERGED",
      draft: false,
      title: "Plain",
      head: "sha",
      rollup: [],
    });
    expect(second).toBe(first);
    expect(run).toHaveBeenCalledExactlyOnceWith(
      "gh",
      pullRequestQueryArgs("a", "b", "1"),
      { timeoutMs: 10_000, allowedExitCodes: [0, 1] }
    );
    vi.advanceTimersByTime(59_000);
    await executor.read(target);
    expect(run).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2_000);
    await executor.read(target);
    expect(run).toHaveBeenCalledTimes(2);
    expect(status).toHaveBeenCalledTimes(4);
  });

  it("shares a failed plain read for a minute too, and forgets it on reset", async () => {
    const run = vi.fn<CommandRunner>(async () => {
      throw new Error("offline");
    });
    const executor = localPullRequestStatus(run, null);
    await expect(executor.read(target)).rejects.toThrow("offline");
    await expect(executor.read(target)).rejects.toThrow("offline");
    expect(run).toHaveBeenCalledTimes(1);
    executor.reset();
    await expect(executor.read(target)).rejects.toThrow("offline");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("skips the credential scope when an older app does not ask for it", async () => {
    const plain = vi.fn(async () => plainStdout);
    const status = vi.fn(async () => scoped);
    const executor = new GitHubPullRequestStatus({ status }, plain);
    expect((await executor.read(target, undefined, false)).title).toBe("Plain");
    expect(status).not.toHaveBeenCalled();
  });
});

describe("PR reads through the agent's runner", () => {
  it("projects the runner's answer exactly as main's local read did", async () => {
    const executor = localPullRequestStatus(commands(), {
      status: async () => scoped,
    });
    const runner = {
      call: ((_op: string, input: typeof target) =>
        executor.read(input)) as Runner["call"],
    };
    const read = createRunnerPullRequestReader(() => runner);
    expect(
      await read("https://github.com/A/B/pull/01#discussion", "Old", null)
    ).toEqual({
      url: "https://github.com/a/b/pull/1",
      title: "Scoped",
      status: "Open",
      ci: expect.objectContaining({
        headSha: "sha",
        availability: "available",
        summary: expect.objectContaining({ status: "none", total: 0 }),
      }),
    });
    expect(
      await read("https://example.com/a/b/pull/1", "Other", "beta")
    ).toEqual({
      url: "https://example.com/a/b/pull/1",
      title: "Other",
      status: "Unavailable",
    });
  });

  it("serves local reads in the child when it is ready, else in process", async () => {
    const description = {
      runnerId: "local",
      displayName: "Local",
      build: { version: "" },
      protocol: 1,
      engines: [],
      capabilities: {},
    } as never;
    const childCall = vi.fn(async () => scoped);
    const child = {
      connection: { state: "ready", epoch: 1, onChange: () => () => {} },
      call: childCall,
    } as unknown as Runner;
    const viaChild = createLocalCheckoutRunner(undefined, description, child);
    expect(await viaChild.call("github.pr.status", target)).toEqual(scoped);
    // One attempt: a child that cannot answer is not waited for.
    expect(childCall).toHaveBeenCalledWith(
      "github.pr.status",
      target,
      expect.objectContaining({ wait: false, timeoutMs: null })
    );
    expect(childFallback.pullRequestStatus).not.toHaveBeenCalled();

    childFallback.pullRequestStatus.mockResolvedValue(scoped);
    const inProcess = createLocalCheckoutRunner(undefined, description);
    expect(await inProcess.call("github.pr.status", target)).toEqual(scoped);
    expect(childFallback.pullRequestStatus).toHaveBeenCalledWith(target, {
      signal: undefined,
    });
  });

  it("reads in process when the child dies mid-call, but keeps the child's gh failure", async () => {
    vi.useFakeTimers();
    const description = {
      runnerId: "local",
      displayName: "Local",
      build: { version: "" },
      protocol: 1,
      engines: [],
      capabilities: {},
    } as never;
    const childCall = vi.fn(async (): Promise<GitHubPullRequestObservation> => {
      throw new RunnerCallError({
        code: "unknown_outcome",
        message: "The github.pr.status reply did not arrive",
      });
    });
    const child = {
      connection: { state: "ready", epoch: 1, onChange: () => () => {} },
      call: childCall,
    } as unknown as Runner;
    childFallback.pullRequestStatus.mockResolvedValue(scoped);
    const url = "https://github.com/a/b/pull/1";
    const query = vi.fn(async (sql: string) => ({
      rows: sql.includes("FROM blocks")
        ? [
            {
              id: "post",
              author_agent_id: "a",
              attachments: [{ type: "pr", url, title: "PR" }],
            },
          ]
        : [],
    }));
    const service = new PullRequestRefresher({
      pool: { query } as unknown as Pool,
      listAgents: async () => [{ id: "a", runnerId: null }],
      publish: vi.fn(),
      read: createRunnerPullRequestReader(() =>
        createLocalCheckoutRunner(undefined, description, child)
      ),
      warn: vi.fn(),
    });
    try {
      service.start();
      await vi.advanceTimersByTimeAsync(200);
      expect(childCall).toHaveBeenCalledTimes(1);
      expect(childFallback.pullRequestStatus).toHaveBeenCalledTimes(1);
      expect(service.get("a")[0]).toMatchObject({
        title: "Scoped",
        status: "Open",
        ci: expect.objectContaining({ availability: "available" }),
      });
      // The normal five-minute cadence, not the failure backoff.
      await vi.advanceTimersByTimeAsync(PULL_REQUEST_ACTIVE_REFRESH_MS + 1_000);
      expect(childCall).toHaveBeenCalledTimes(2);

      childCall.mockRejectedValueOnce(
        new RunnerCallError({ code: "failed", message: "gh failed" })
      );
      await expect(service.refreshOne("a", url)).rejects.toThrow(
        "Could not refresh PR. Check GitHub authentication and try again."
      );
      expect(childFallback.pullRequestStatus).toHaveBeenCalledTimes(2);
    } finally {
      await service.stop();
    }
  });
});
