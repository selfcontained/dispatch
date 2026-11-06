import { registerAgentPullRequestRoutes } from "../src/routes/agents/pull-request-routes.js";
import { PullRequestRefresher } from "../src/agents/pull-request-refresher.js";
import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import {
  createPullRequestReader,
  githubPullRequestUrl,
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
        stdout: JSON.stringify({ state, isDraft, title: "Fix" }),
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
