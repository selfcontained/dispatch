import { pathFromWire } from "@dispatch/runner-protocol/contract";
import { describe, expect, it, vi } from "vitest";
import { githubHandlers } from "../src/core/github.js";
import { SERVED_WHILE_FROZEN } from "../src/local/fence.js";
import type { Platform } from "../src/platform/types.js";

const workload = { run: vi.fn() } as unknown as Platform["workload"];

describe("the core's GitHub reads", () => {
  it("serves github.pr.status from the platform's port", async () => {
    const observation = {
      state: "OPEN" as const,
      draft: false,
      title: "Fix",
      head: "sha",
      rollup: [],
    };
    const pullRequestStatus = vi.fn(async () => observation);
    const handlers = githubHandlers({
      workload,
      github: {
        pullRequestHead: vi.fn(),
        pullRequestStatus,
        pullRequestDetails: vi.fn(),
        pullRequestDiff: vi.fn(),
      },
    });
    const request = { owner: "a", repo: "b", number: 1 };
    expect(await handlers["github.pr.status"]!(request, {} as never)).toEqual(
      observation
    );
    expect(pullRequestStatus).toHaveBeenCalledWith(request, {});
  });

  it("serves merge-risk details and diff from the same port", async () => {
    const details = {
      number: 1,
      title: "Fix",
      body: "",
      baseRefName: "main",
      headRefName: "fix",
      headRefOid: "a".repeat(40),
      additions: 1,
      deletions: 0,
      files: [{ path: "a.ts", additions: 1, deletions: 0 }],
    };
    const diff = { base: "b".repeat(40), files: [] };
    const github = {
      pullRequestHead: vi.fn(async () => ({
        url: "https://github.com/a/b.git",
        branch: "fix",
      })),
      pullRequestStatus: vi.fn(),
      pullRequestDetails: vi.fn(async () => details),
      pullRequestDiff: vi.fn(async () => diff),
    };
    const handlers = githubHandlers({ workload, github });
    const pr = { owner: "a", repo: "b", number: 1 };
    const headRequest = { ...pr, cwd: pathFromWire("/checkout") };
    expect(await handlers["github.pr.head"]!(headRequest, {} as never)).toEqual(
      { url: "https://github.com/a/b.git", branch: "fix" }
    );
    expect(github.pullRequestHead).toHaveBeenCalledWith(headRequest);
    expect(await handlers["github.pr.details"]!(pr, {} as never)).toEqual(
      details
    );
    expect(github.pullRequestDetails).toHaveBeenCalledWith(pr, {});
    const request = { ...pr, head: "a".repeat(40) };
    expect(await handlers["github.pr.diff"]!(request, {} as never)).toEqual(
      diff
    );
    expect(github.pullRequestDiff).toHaveBeenCalledWith(request, {});
  });

  it("leaves GitHub unsupported without a port, and serves it while frozen", () => {
    expect(githubHandlers({ workload })).toEqual({});
    for (const op of [
      "github.pr.head",
      "github.pr.status",
      "github.pr.details",
      "github.pr.diff",
    ])
      expect(SERVED_WHILE_FROZEN.has(op as never)).toBe(true);
  });
});

it("serves repository search on the same local core GitHub port", async () => {
  const result = {
    repositories: [{ name: "org/repo", url: "https://github.com/org/repo" }],
  };
  const repositories = vi.fn().mockResolvedValue(result);
  const calls = githubHandlers({
    workload,
    github: {
      repositories,
      pullRequestHead: vi.fn(),
      pullRequestStatus: vi.fn(),
      pullRequestDetails: vi.fn(),
      pullRequestDiff: vi.fn(),
    },
  });
  expect(
    await calls["github.repositories"]!({ query: "repo" }, {} as never)
  ).toEqual(result);
  expect(repositories).toHaveBeenCalledWith({ query: "repo" });
});
