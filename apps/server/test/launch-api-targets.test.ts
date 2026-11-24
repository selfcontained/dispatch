import Fastify from "fastify";
import multipart from "@fastify/multipart";
import { expect, it, vi } from "vitest";
import { registerAgentCrudRoutes } from "../src/routes/agents/crud-routes.js";

it("keeps a runner PR URL accepted through the create API", async () => {
  const app = Fastify();
  await app.register(multipart);
  const createAgent = vi.fn(async () => ({ id: "fixture-agent" }));
  await registerAgentCrudRoutes(app, {
    pool: { query: async () => ({ rows: [] }) },
    agentManager: { createAgent },
    withStreamFlag: (agent: unknown) => agent,
    publishUiEvent: vi.fn(),
    handleAgentError: (_reply: unknown, error: unknown) => {
      throw error;
    },
  } as never);
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/agents",
      payload: {
        runner: "fixture",
        projectId: "fixture-project",
        type: "codex",
        useWorktree: true,
        createNewBranch: false,
        pullRequest: "https://github.com/org/repo/pull/123",
      },
    });
    expect(response.statusCode).toBe(201);
    expect(createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "fixture-project",
        useWorktree: true,
        createNewBranch: false,
        pullRequest: "https://github.com/org/repo/pull/123",
      }),
      expect.anything()
    );
  } finally {
    await app.close();
  }
});
