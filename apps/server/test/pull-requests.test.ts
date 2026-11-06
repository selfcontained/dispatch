import { registerAgentPullRequestRoutes } from "../src/routes/agents/pull-request-routes.js";
import { PullRequestRefresher } from "../src/agents/pull-request-refresher.js";
import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import {
  createPullRequestReader,
  githubPullRequestUrl,
  mapPullRequestChecks,
} from "../src/agents/pull-request-reader.js";
import type { AgentRouteDeps } from "../src/routes/agents/shared.js";

describe("session pull requests", () => {
  it("canonicalizes GitHub URLs and refuses other hosts for authenticated gh reads", () => {
    expect(
      githubPullRequestUrl("https://github.com/a/b/pull/12#discussion")
    ).toBe("https://github.com/a/b/pull/12");
    for (const url of [
      "https://evil.test/a/b/pull/12",
      "file:///a/b/pull/12",
      "https://github.com/a/b/issues/12",
    ])
      expect(githubPullRequestUrl(url)).toBeNull();
  });
  it.each([
    ["OPEN", false, "Open"],
    ["OPEN", true, "Draft"],
    ["MERGED", true, "Merged"],
    ["CLOSED", false, "Closed"],
  ])(
    "reads %s (draft %s) as %s and coalesces requests",
    async (state, isDraft, status) => {
      const run = vi.fn().mockResolvedValue({
        stdout: JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                state,
                isDraft,
                title: "Fix",
                headRefOid: "abc",
                commits: {
                  nodes: [{ commit: { oid: "abc", statusCheckRollup: null } }],
                },
              },
            },
          },
        }),
      });
      const read = createPullRequestReader(run);
      const results = await Promise.all([
        read("https://github.com/a/b/pull/1", "old"),
        read("https://github.com/a/b/pull/1#discussion", "old"),
      ]);
      expect(results[0].status).toBe(status);
      expect(results[1]).toEqual(results[0]);
      expect(run).toHaveBeenCalledTimes(1);
    }
  );
  it("does not turn lookup failures into closed PRs", async () => {
    const read = createPullRequestReader(
      vi.fn().mockRejectedValue(new Error("offline"))
    );
    expect((await read("https://github.com/a/b/pull/1", "Fix")).status).toBe(
      "Unavailable"
    );
  });
  it("requires an existing agent and validates dismiss input before persistence", async () => {
    const app = Fastify();
    const dismiss = vi.fn();
    await registerAgentPullRequestRoutes(app, {
      agentManager: { getAgent: async () => null },
      pullRequests: { dismiss },
    } as unknown as AgentRouteDeps);
    try {
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/v1/agents/missing/pull-requests/dismiss",
            payload: { url: "https://github.com/a/b/pull/1" },
          })
        ).statusCode
      ).toBe(404);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/v1/agents/missing/pull-requests/dismiss",
            payload: { url: "invalid" },
          })
        ).statusCode
      ).toBe(400);
      expect(dismiss).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it("returns every distinct authored PR, without the inbox resource cap", async () => {
    const app = Fastify();
    const rows = Array.from({ length: 12 }, (_, n) => ({
      author_agent_id: "agent",
      kind: "text",
      attachments: [
        {
          type: "pr",
          url: `https://gitlab.com/a/b/merge_requests/${n}`,
          title: `Fix ${n}`,
        },
      ],
    }));
    const query = vi.fn().mockImplementation(async (sql: string) =>
      sql.includes("FROM agent_pr_dismissals")
        ? { rows: [] }
        : {
            rows: [
              ...rows,
              rows[0],
              {
                kind: "text",
                attachments: [{ type: "pr", url: "javascript:alert(1)" }],
              },
            ],
          }
    );
    const pullRequests = new PullRequestRefresher({
      pool: { query } as any,
      listAgentIds: async () => ["agent"],
      publish: vi.fn(),
      warn: vi.fn(),
    });
    await pullRequests.refresh();
    await registerAgentPullRequestRoutes(app, {
      pullRequests,
      pool: { query },
      agentManager: { getAgent: vi.fn().mockResolvedValue({ id: "agent" }) },
    } as unknown as AgentRouteDeps);
    try {
      const response = await app.inject("/api/v1/agents/agent/pull-requests");
      expect(response.statusCode).toBe(200);
      expect(response.json().pullRequests).toHaveLength(12);
      await app.inject("/api/v1/agents/agent/pull-requests");
      expect(query).toHaveBeenCalledTimes(2);
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining("attachments @>"),
        [["agent"]]
      );
    } finally {
      await app.close();
    }
  });
});

describe("current-head checks mapping", () => {
  it("distinguishes no checks from unavailable", () => {
    expect(mapPullRequestChecks("abc", []).summary.status).toBe("none");
    expect(mapPullRequestChecks("abc", null).availability).toBe("unavailable");
  });
  it("combines check runs and legacy contexts without repeated nodes", () => {
    const run = (conclusion: string | null) => ({
      __typename: "CheckRun",
      name: conclusion ?? "running",
      status: conclusion ? "COMPLETED" : "IN_PROGRESS",
      conclusion,
    });
    const legacy = {
      __typename: "StatusContext",
      context: "deploy",
      state: "ERROR",
      targetUrl: "javascript:bad",
    };
    const ci = mapPullRequestChecks("abc", [
      run("SUCCESS"),
      run("NEUTRAL"),
      run("SKIPPED"),
      run("CANCELLED"),
      run(null),
      legacy,
      legacy,
    ]);
    expect(ci.summary).toEqual({
      status: "failing",
      total: 6,
      passed: 1,
      failed: 2,
      skipped: 2,
      pending: 1,
    });
    expect(ci.checks.at(-1)?.detailsUrl).toBeNull();
  });
  it("preserves lifecycle when GitHub returns partial checks errors", async () => {
    const read = createPullRequestReader(
      vi.fn().mockResolvedValue({
        stdout: JSON.stringify({
          errors: [{ message: "forbidden" }],
          data: {
            repository: {
              pullRequest: {
                state: "OPEN",
                isDraft: true,
                headRefOid: "new",
                title: "Draft",
              },
            },
          },
        }),
      })
    );
    const pr = await read("https://github.com/a/b/pull/1", "Old");
    expect(pr.status).toBe("Draft");
    expect(pr.ci?.availability).toBe("unavailable");
    expect(pr.ci?.headSha).toBe("new");
  });
});

it("uses the latest rerun rather than counting a cancelled historical attempt", () => {
  const attempt = (databaseId: number, conclusion: string) => ({
    __typename: "CheckRun",
    databaseId,
    name: "ci",
    status: "COMPLETED",
    conclusion,
    checkSuite: { app: { slug: "github-actions" } },
  });
  const ci = mapPullRequestChecks("abc", [
    attempt(2, "SUCCESS"),
    attempt(1, "CANCELLED"),
  ]);
  expect(ci.summary).toMatchObject({ status: "passing", total: 1, failed: 0 });
});

it.each(["head-race", "truncated", "empty"])(
  "handles bounded transport %s safely",
  async (scenario) => {
    const pr = {
      title: "Draft",
      state: "OPEN",
      isDraft: true,
      headRefOid: "new",
      commits: {
        nodes: [
          {
            commit: {
              oid: scenario === "head-race" ? "old" : "new",
              statusCheckRollup:
                scenario === "empty"
                  ? null
                  : {
                      contexts: {
                        pageInfo: { hasNextPage: scenario === "truncated" },
                        nodes: [],
                      },
                    },
            },
          },
        ],
      },
    };
    const run = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ data: { repository: { pullRequest: pr } } }),
    });
    const result = await createPullRequestReader(run)(
      "https://github.com/a/b/pull/1",
      "Old"
    );
    expect(result.status).toBe("Draft");
    expect(result.ci?.headSha).toBe("new");
    expect(result.ci?.availability).toBe(
      scenario === "empty" ? "available" : "unavailable"
    );
    expect(result.ci?.checks).toEqual([]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][1]).toContain("graphql");
    expect(run.mock.calls[0][1]).toEqual(
      expect.arrayContaining(["--hostname", "github.com"])
    );
  }
);

it("retains valid check-run timing but never invents commit-status runtime", () => {
  const fields = {
    startedAt: "2026-11-06T00:00:00Z",
    completedAt: "2026-11-06T00:01:23Z",
  };
  const ci = mapPullRequestChecks("abc", [
    {
      __typename: "CheckRun",
      name: "Build",
      status: "COMPLETED",
      conclusion: "SUCCESS",
      ...fields,
    },
    {
      __typename: "StatusContext",
      context: "deploy",
      state: "SUCCESS",
      ...fields,
    },
  ]);
  expect(ci.checks[0]).toMatchObject(fields);
  expect(ci.checks[1].startedAt).toBeUndefined();
  expect(ci.checks[1].completedAt).toBeUndefined();
});

it("refresh route requires an agent and delegates only the requested URL", async () => {
  const app = Fastify();
  const refreshOne = vi.fn().mockResolvedValue([]);
  await registerAgentPullRequestRoutes(app, {
    agentManager: {
      getAgent: vi.fn(async (id) => (id === "a" ? { id } : null)),
    },
    pullRequests: { refreshOne },
  } as unknown as AgentRouteDeps);
  const url = "https://github.com/a/b/pull/1";
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/v1/agents/missing/pull-requests/refresh",
        payload: { url },
      })
    ).statusCode
  ).toBe(404);
  expect(refreshOne).not.toHaveBeenCalled();
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/v1/agents/a/pull-requests/refresh",
        payload: { url },
      })
    ).statusCode
  ).toBe(200);
  expect(refreshOne).toHaveBeenCalledWith("a", url);
  refreshOne.mockRejectedValue(new Error("PR no longer tracked"));
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/v1/agents/a/pull-requests/refresh",
        payload: { url },
      })
    ).statusCode
  ).toBe(409);
  await app.close();
});
