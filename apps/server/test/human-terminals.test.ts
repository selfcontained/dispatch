import Fastify from "fastify";
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { Pool } from "pg";
import {
  HumanTerminalManager,
  REPLAY_BYTES,
  terminalEnvironment,
  type PtyProcess,
} from "../src/terminal/manager.js";
import {
  registerHumanTerminalRoutes,
  terminalOriginAllowed,
} from "../src/routes/human-terminals.js";
import { isPasswordSet, validateSession } from "../src/auth.js";
vi.mock("../src/auth.js", () => ({
  isPasswordSet: vi.fn(async () => true),
  validateSession: vi.fn(
    async (_pool, value) => value === "browser-a" || value === "browser-b"
  ),
}));

function harness(grace = 60_000) {
  let output: (data: Uint8Array) => void = () => {};
  const process: PtyProcess = {
    pid: 2147483647,
    terminal: {
      write: vi.fn((data) => Buffer.byteLength(data)),
      resize: vi.fn(),
      close: vi.fn(),
    },
    exited: new Promise(() => {}),
    kill: vi.fn(),
  };
  const spawn = vi.fn((_cwd, callback) => {
    output = callback;
    return process;
  });
  const manager = new HumanTerminalManager(spawn, grace);
  return {
    manager,
    process,
    spawn,
    output: (text: string) => output(Buffer.from(text)),
  };
}
function socket() {
  return Object.assign(new EventEmitter(), {
    send: vi.fn(),
    close: vi.fn(),
    readyState: 1,
    bufferedAmount: 0,
  }) as unknown as WebSocket;
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.mocked(isPasswordSet).mockResolvedValue(true);
});

describe("human terminal lifecycle", () => {
  it("keeps one per owner/tab/workspace, rejects foreign owners, replays bounded bytes and expires disconnected processes", () => {
    vi.useFakeTimers();
    const h = harness();
    const first = h.manager.open("a", "tab", "agent", "/tmp");
    expect(h.manager.open("a", "tab", "agent", "/other")).toEqual(first);
    expect(h.spawn).toHaveBeenCalledTimes(1);
    expect(h.manager.resume(first.id, "b", "tab", "agent")).toBeNull();
    expect(h.manager.resume(first.id, "a", "other", "agent")).toBeNull();
    expect(h.manager.attach(first.id, "b", socket())).toBe(false);
    h.output("x".repeat(REPLAY_BYTES + 100));
    const ws = socket();
    expect(h.manager.attach(first.id, "a", ws)).toBe(true);
    expect(vi.mocked(ws.send).mock.calls[1][0]).toHaveLength(REPLAY_BYTES);
    vi.advanceTimersByTime(120_000);
    expect(h.process.kill).not.toHaveBeenCalled();
    ws.emit("close");
    vi.advanceTimersByTime(59_000);
    const resumed = socket();
    h.manager.attach(first.id, "a", resumed);
    vi.advanceTimersByTime(2000);
    expect(h.manager.owns(first.id, "a")).toBe(true);
    resumed.emit("close");
    vi.advanceTimersByTime(60_001);
    expect(h.process.kill).toHaveBeenCalledOnce();
    expect(h.manager.owns(first.id, "a")).toBe(false);
  });
  it("limits input, validates dimensions, ends only for its owner and cleans shutdown", () => {
    const h = harness();
    const { id } = h.manager.open("a", "tab", "agent", "/tmp");
    const ws = socket();
    h.manager.attach(id, "a", ws);
    ws.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "input", data: "\u0003" })),
      false
    );
    expect(h.process.terminal.write).toHaveBeenCalledWith("\u0003");
    ws.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "resize", cols: 120, rows: 42 })),
      false
    );
    expect(h.process.terminal.resize).toHaveBeenCalledWith(120, 42);
    ws.emit("message", Buffer.from("x".repeat(16_385)), false);
    expect(ws.close).toHaveBeenCalledWith(1008, expect.any(String));
    expect(h.manager.end(id, "b")).toBe(false);
    h.manager.shutdown();
    expect(h.process.terminal.close).toHaveBeenCalledOnce();
    expect(h.manager.owns(id, "a")).toBe(false);
  });
  it("does not inherit credential, identity, startup-hook or arbitrary application environment", () => {
    expect(
      terminalEnvironment({
        HOME: "/home/me",
        PATH: "/bin",
        DISPATCH_AUTH_TOKEN: "secret",
        DISPATCH_AGENT_ID: "agent",
        AWS_SECRET_ACCESS_KEY: "secret",
        NODE_OPTIONS: "hooks",
        BASH_ENV: "hooks",
      })
    ).toEqual({
      HOME: "/home/me",
      PATH: "/bin",
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
    });
  });
});

describe("terminal browser security", () => {
  it("opens passwordless dev terminals with a scoped browser cookie and isolates browsers", async () => {
    vi.stubEnv("DISPATCH_DEV_STACK", "1");
    vi.mocked(isPasswordSet).mockResolvedValue(false);
    const app = Fastify();
    await app.register(cookie, {
      secret: "terminal-test-cookie-secret-32bytes",
    });
    await app.register(websocket);
    const h = harness();
    await registerHumanTerminalRoutes(app, {
      pool: {} as Pool,
      sessionCookie: "session",
      getAgent: async () => ({ cwd: "/tmp", worktreePath: null }),
      manager: h.manager,
    });
    await app.ready();
    const headers = { origin: "http://localhost", host: "localhost" };
    const create = (extra = {}, terminalId?: string) =>
      app.inject({
        method: "POST",
        url: "/api/v1/human-terminals",
        headers: { ...headers, ...extra },
        payload: {
          agentId: "agent",
          clientId: "tab123456789012345",
          terminalId,
        },
      });
    try {
      expect((await create({ origin: "http://evil.test" })).statusCode).toBe(
        403
      );
      const first = await create();
      expect(first.statusCode).toBe(200);
      const setCookie = String(first.headers["set-cookie"]);
      expect(setCookie).toContain("session_terminal_dev=");
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toContain("SameSite=Strict");
      expect(setCookie).toContain("Path=/api/v1/human-terminals");
      const browserCookie = setCookie.split(";")[0];
      const id = first.json().id;
      expect((await create({ cookie: browserCookie }, id)).statusCode).toBe(
        200
      );
      expect((await create({}, id)).statusCode).toBe(404);
      expect(
        (
          await app.inject({
            method: "DELETE",
            url: `/api/v1/human-terminals/${id}`,
            headers,
          })
        ).statusCode
      ).toBe(401);
      const address = await app.listen({ host: "127.0.0.1", port: 0 });
      const ws = new WebSocket(
        `${address.replace("http:", "ws:")}/api/v1/human-terminals/${id}/socket`,
        { headers: { origin: address, cookie: browserCookie } }
      );
      await new Promise<void>((resolve, reject) => {
        ws.once("open", resolve);
        ws.once("error", reject);
      });
      ws.close();
      vi.mocked(isPasswordSet).mockResolvedValue(true);
      expect((await create({ cookie: browserCookie }, id)).statusCode).toBe(
        401
      );
      vi.mocked(isPasswordSet).mockResolvedValue(false);
      vi.stubEnv("DISPATCH_DEV_STACK", "");
      expect((await create({ cookie: browserCookie }, id)).statusCode).toBe(
        401
      );
    } finally {
      await app.close();
    }
  });

  it("keeps terminal ownership across installations sharing a browser cookie jar", async () => {
    vi.stubEnv("DISPATCH_DEV_STACK", "1");
    vi.mocked(isPasswordSet).mockResolvedValue(false);
    const jar = new Map<string, string>();
    const instances = [];
    try {
      for (const name of ["installation_a", "installation_b"]) {
        const app = Fastify();
        instances.push(app);
        await app.register(cookie, {
          secret: name + "-cookie-secret-at-least-32bytes",
        });
        await app.register(websocket);
        await registerHumanTerminalRoutes(app, {
          pool: {} as Pool,
          sessionCookie: name,
          getAgent: async () => ({ cwd: "/tmp", worktreePath: null }),
          manager: harness().manager,
        });
        await app.ready();
      }
      const headers = () => ({
        origin: "http://localhost",
        host: "localhost",
        cookie: [...jar].map(([name, value]) => name + "=" + value).join("; "),
      });
      const ids: string[] = [];
      for (const app of instances) {
        const response = await app.inject({
          method: "POST",
          url: "/api/v1/human-terminals",
          headers: headers(),
          payload: { agentId: "agent", clientId: "tab123456789012345" },
        });
        expect(response.statusCode).toBe(200);
        for (const item of response.cookies) jar.set(item.name, item.value);
        ids.push(response.json().id);
      }
      expect(jar.size).toBe(2);
      for (const [index, app] of instances.entries()) {
        const resumed = await app.inject({
          method: "POST",
          url: "/api/v1/human-terminals",
          headers: headers(),
          payload: {
            agentId: "agent",
            clientId: "tab123456789012345",
            terminalId: ids[index],
          },
        });
        expect(resumed.statusCode).toBe(200);
        expect(resumed.json().id).toBe(ids[index]);
        expect(resumed.headers["set-cookie"]).toBeUndefined();
        const ended = await app.inject({
          method: "DELETE",
          url: `/api/v1/human-terminals/${ids[index]}`,
          headers: headers(),
        });
        expect(ended.statusCode).toBe(200);
      }
    } finally {
      await Promise.all(instances.map((app) => app.close()));
    }
  });

  it("requires exact Origin and secure transport except loopback or explicitly marked dev stacks", () => {
    expect(terminalOriginAllowed(undefined, "localhost", "http")).toBe(false);
    expect(terminalOriginAllowed("null", "localhost", "http")).toBe(false);
    expect(
      terminalOriginAllowed("https://evil.test", "dispatch.test", "https")
    ).toBe(false);
    expect(
      terminalOriginAllowed(
        "https://dispatch.test/path",
        "dispatch.test",
        "https"
      )
    ).toBe(false);
    expect(
      terminalOriginAllowed("http://dispatch.test", "dispatch.test", "http")
    ).toBe(false);
    expect(
      terminalOriginAllowed("http://localhost:123", "localhost:123", "http")
    ).toBe(true);
    expect(
      terminalOriginAllowed("https://dispatch.test", "dispatch.test", "https")
    ).toBe(true);
    expect(
      terminalOriginAllowed(
        "http://192.168.1.2:123",
        "192.168.1.2:123",
        "http",
        true
      )
    ).toBe(true);
  });
  it("rejects first-run, bearer-only, bad cookies and cross-owner REST/WS, uses server cwd", async () => {
    const app = Fastify();
    await app.register(cookie, {
      secret: "terminal-test-cookie-secret-32bytes",
    });
    await app.register(websocket, { options: { maxPayload: 16 * 1024 } });
    const h = harness();
    await registerHumanTerminalRoutes(app, {
      pool: {} as Pool,
      sessionCookie: "session",
      getAgent: async (id) =>
        id === "agent" ? { cwd: "/tmp", worktreePath: null } : null,
      manager: h.manager,
    });
    await app.ready();
    const headers = { origin: "http://localhost", host: "localhost" };
    const signed = (token: string) =>
      `session=${encodeURIComponent(app.signCookie(token))}`;
    const create = (extra = {}, payload = {}) =>
      app.inject({
        method: "POST",
        url: "/api/v1/human-terminals",
        headers: { ...headers, ...extra },
        payload: {
          agentId: "agent",
          clientId: "tab123456789012345",
          ...payload,
        },
      });
    try {
      const noSession = await create({ authorization: "Bearer mcp-token" });
      expect(noSession.statusCode).toBe(401);
      expect(noSession.json()).toEqual({
        code: "session_required",
        error: "Sign in with your Dispatch password to use the terminal.",
      });
      expect((await create({ cookie: "session=unsigned" })).statusCode).toBe(
        401
      );
      vi.mocked(isPasswordSet).mockResolvedValue(false);
      const noPassword = await create({ cookie: signed("browser-a") });
      expect(noPassword.statusCode).toBe(401);
      expect(noPassword.json()).toEqual({
        code: "password_not_set",
        error: "Set a Dispatch password to use the terminal.",
      });
      vi.mocked(isPasswordSet).mockResolvedValue(true);
      expect(
        (
          await create({
            cookie: signed("browser-a"),
            origin: "http://evil.test",
          })
        ).statusCode
      ).toBe(403);
      expect(
        (
          await create(
            { cookie: signed("browser-a") },
            { cwd: "/etc", env: { TOKEN: "oops" } }
          )
        ).statusCode
      ).toBe(200); // Fastify strips extra fields; never forwards them.
      expect(h.spawn).toHaveBeenCalledWith(
        await import("node:fs/promises").then((fs) => fs.realpath("/tmp")),
        expect.any(Function)
      );
      const result = await create({ cookie: signed("browser-a") });
      const id = result.json().id;
      expect(
        (
          await app.inject({
            method: "DELETE",
            url: `/api/v1/human-terminals/${id}`,
            headers: { ...headers, cookie: signed("browser-b") },
          })
        ).statusCode
      ).toBe(404);
      expect(
        (await create({ cookie: signed("browser-b") }, { terminalId: id }))
          .statusCode
      ).toBe(404);
      await expect(
        app.injectWS(`/api/v1/human-terminals/${id}/socket`, {
          headers: { ...headers, authorization: "Bearer mcp-token" },
        })
      ).rejects.toThrow();
      await expect(
        app.injectWS(`/api/v1/human-terminals/${id}/socket`, {
          headers: {
            ...headers,
            cookie: signed("browser-a"),
            origin: "http://evil.test",
          },
        })
      ).rejects.toThrow();
    } finally {
      await app.close();
    }
  });
});
