import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

import {
  isScopedMcpRoute,
  shouldAcceptApiBearerToken,
  createAgentMcpToken,
  validateAgentMcpToken,
  createJobMcpToken,
  validateJobMcpToken,
} from "../src/auth.js";

const SERVER_AUTH_TOKEN = "server-auth-token";

function getBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  return authHeader.slice(7);
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();

  app.addHook("onRequest", async (request, reply) => {
    const url = request.url.split("?")[0];
    const authHeader = request.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.slice(7);
      if (shouldAcceptApiBearerToken(url, token, SERVER_AUTH_TOKEN)) {
        return;
      }
      if (isScopedMcpRoute(url)) {
        return;
      }
    }

    return reply.code(401).send({ error: "Authentication required." });
  });

  app.post("/api/mcp", async () => ({ ok: true, route: "root" }));

  app.post("/api/mcp/:agentId", async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    const token = getBearerToken(request.headers.authorization);
    if (token && !validateAgentMcpToken(SERVER_AUTH_TOKEN, token, agentId)) {
      return reply.code(403).send({ error: "Invalid MCP token for the requested agent route." });
    }
    return { ok: true, route: "agent" };
  });

  app.post("/api/mcp/jobs/:runId/:agentId", async (request, reply) => {
    const { runId, agentId } = request.params as { runId: string; agentId: string };
    const token = getBearerToken(request.headers.authorization);
    if (token && !validateJobMcpToken(SERVER_AUTH_TOKEN, token, runId, agentId)) {
      return reply.code(403).send({ error: "Invalid MCP token for the requested job agent route." });
    }
    return { ok: true, route: "job" };
  });

  await app.ready();
  return app;
}

describe("MCP auth", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it("rejects arbitrary bearer tokens on the root MCP route", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/mcp",
      headers: { authorization: "Bearer not-the-server-token" },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "Authentication required." });
  });

  it("still accepts the raw server auth token on the root MCP route", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/mcp",
      headers: { authorization: `Bearer ${SERVER_AUTH_TOKEN}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, route: "root" });
  });

  it("accepts valid scoped agent tokens on agent MCP routes", async () => {
    const agentId = "agt_123456abcdef";
    const token = createAgentMcpToken(SERVER_AUTH_TOKEN, agentId);
    const response = await app.inject({
      method: "POST",
      url: `/api/mcp/${agentId}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, route: "agent" });
  });

  it("accepts valid scoped job tokens on job MCP routes", async () => {
    const runId = "run_123";
    const agentId = "agt_123456abcdef";
    const token = createJobMcpToken(SERVER_AUTH_TOKEN, runId, agentId);
    const response = await app.inject({
      method: "POST",
      url: `/api/mcp/jobs/${runId}/${agentId}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, route: "job" });
  });
});
