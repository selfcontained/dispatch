import Fastify from "fastify";
import { it, expect, vi } from "vitest";
import { registerAgentPullRequestRoutes } from "../src/routes/agents/pull-request-routes.js";
import type { AgentRouteDeps } from "../src/routes/agents/shared.js";
it("validates the click contract, rejects agent bearer requests and scopes calls to the route agent", async () => {
  const app = Fastify();
  const explain = vi.fn().mockResolvedValue({ state: "unavailable" });
  await registerAgentPullRequestRoutes(app, {
    agentManager: {
      getAgent: async (id: string) => (id === "owner" ? { id } : null),
    },
    riskExplanations: { explain },
  } as unknown as AgentRouteDeps);
  try {
    const payload = {
      url: "https://github.com/a/b/pull/1",
      assessmentId: "42",
    };
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/agents/owner/pull-requests/explain",
          headers: { authorization: "Bearer agent-token" },
          payload,
        })
      ).statusCode
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/agents/other/pull-requests/explain",
          payload,
        })
      ).statusCode
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/agents/owner/pull-requests/explain",
          payload: { ...payload, assessmentId: "invalid" },
        })
      ).statusCode
    ).toBe(400);
    expect(explain).not.toHaveBeenCalled();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agents/owner/pull-requests/explain",
      payload,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(explain).toHaveBeenCalledWith({ agentId: "owner", ...payload });
  } finally {
    await app.close();
  }
});
