import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerAgentPullRequestRoutes } from "../src/routes/agents/pull-request-routes.js";
import type { AgentRouteDeps } from "../src/routes/agents/shared.js";

describe("agent current preview", () => {
  it("returns only the last explicit preview in the newest authored preview post", async () => {
    const app = Fastify();
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          attachments: [
            { type: "preview", url: "https://old.test", title: "Old" },
            { type: "preview", url: "https://new.test", title: "Current" },
            { type: "link", url: "https://generic.test" },
          ],
        },
      ],
    });
    await registerAgentPullRequestRoutes(app, {
      pool: { query },
      agentManager: { getAgent: async () => ({ id: "a" }) },
    } as unknown as AgentRouteDeps);
    try {
      expect((await app.inject("/api/v1/agents/a/preview")).json()).toEqual({
        preview: { type: "preview", url: "https://new.test", title: "Current" },
      });
      expect(query.mock.calls[0][1]).toEqual(["a"]);
      query.mockResolvedValue({ rows: [] });
      expect((await app.inject("/api/v1/agents/a/preview")).json()).toEqual({
        preview: null,
      });
    } finally {
      await app.close();
    }
  });
});
