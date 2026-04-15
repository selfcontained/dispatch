import { describe, expect, it, beforeEach } from "vitest";
import { McpSessionManager } from "../src/shared/mcp/server.js";
import type { McpRequestContext } from "../src/shared/mcp/server.js";
import http from "node:http";
import { once } from "node:events";

function buildContext(agentId: string): McpRequestContext {
  return {
    agent: { id: agentId, cwd: "/tmp/test" },
    repoRoot: null,
    worktreeRoot: null,
  };
}

/**
 * Helper: send an MCP request to the session manager via a real HTTP
 * server so we get actual IncomingMessage/ServerResponse objects.
 */
async function sendMcpRequest(
  manager: McpSessionManager,
  method: "POST" | "GET" | "DELETE",
  body: unknown,
  context: McpRequestContext,
  headers: Record<string, string> = {}
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        // Parse body from request
        const chunks: Buffer[] = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", async () => {
          const rawBody = Buffer.concat(chunks).toString();
          const parsedBody = rawBody ? JSON.parse(rawBody) : undefined;
          try {
            if (method === "POST") {
              await manager.handlePost(req, res, parsedBody, context);
            } else if (method === "GET") {
              await manager.handleGet(req, res);
            } else {
              await manager.handleDelete(req, res);
            }
          } catch (err) {
            if (!res.headersSent) {
              res.writeHead(500);
              res.end(String(err));
            }
          }
        });
      } catch (err) {
        reject(err);
      }
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      const reqHeaders: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...headers,
      };

      const reqOpts: http.RequestOptions = {
        hostname: "127.0.0.1",
        port: addr.port,
        path: "/",
        method,
        headers: reqHeaders,
      };

      const req = http.request(reqOpts, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          server.close();
          resolve({
            status: res.statusCode!,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          });
        });
      });

      req.on("error", (err) => {
        server.close();
        reject(err);
      });

      if (body && method === "POST") {
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  });
}

describe("McpSessionManager", () => {
  let manager: McpSessionManager;

  beforeEach(() => {
    manager = new McpSessionManager();
  });

  it("creates a session on initialize and returns session ID", async () => {
    const ctx = buildContext("agt_test1");
    const res = await sendMcpRequest(manager, "POST", {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0" },
      },
    }, ctx);

    expect(res.status).toBe(200);
    expect(res.headers["mcp-session-id"]).toBeDefined();
    expect(manager.hasSession("agt_test1")).toBe(true);
  });

  it("falls back to stateless for non-initialize requests without session", async () => {
    const ctx = buildContext("agt_test2");
    const res = await sendMcpRequest(manager, "POST", {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    }, ctx);

    // Should work (stateless fallback) — no session created
    expect(res.status).toBe(200);
    expect(manager.hasSession("agt_test2")).toBe(false);
  });

  it("routes subsequent requests to existing session", async () => {
    const ctx = buildContext("agt_test3");

    // Initialize
    const initRes = await sendMcpRequest(manager, "POST", {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0" },
      },
    }, ctx);

    const sessionId = initRes.headers["mcp-session-id"] as string;
    expect(sessionId).toBeDefined();

    // Send initialized notification
    await sendMcpRequest(manager, "POST", {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    }, ctx, { "mcp-session-id": sessionId });

    // Now list tools using the session
    const listRes = await sendMcpRequest(manager, "POST", {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    }, ctx, { "mcp-session-id": sessionId });

    expect(listRes.status).toBe(200);
  });

  it("notify returns false when no session exists", async () => {
    const result = await manager.notify("agt_nonexistent", "dispatch://reviews/agt_nonexistent");
    expect(result).toBe(false);
  });

  it("removeSession cleans up agent session", async () => {
    const ctx = buildContext("agt_test4");

    // Initialize
    await sendMcpRequest(manager, "POST", {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0" },
      },
    }, ctx);

    expect(manager.hasSession("agt_test4")).toBe(true);

    manager.removeSession("agt_test4");
    expect(manager.hasSession("agt_test4")).toBe(false);
  });

  it("removeSession is a no-op for unknown agents", () => {
    // Should not throw
    manager.removeSession("agt_unknown");
    expect(manager.hasSession("agt_unknown")).toBe(false);
  });
});
