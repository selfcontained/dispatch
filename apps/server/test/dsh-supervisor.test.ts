import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DshDriver } from "../src/agents/dsh/driver.js";
import {
  buildChildEnv,
  defaultModelFor,
  DshSupervisor,
} from "../src/agents/dsh/supervisor.js";
import { createFakeAcpAgent, type FakeTurn } from "./helpers/fake-acp-agent.js";

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

let home = "";
afterEach(async () => {
  if (home) await rm(home, { recursive: true, force: true });
  home = "";
});

async function build(
  opts: { turn?: FakeTurn; cliSessionId?: string; launchPrompt?: string } = {}
) {
  home = await mkdtemp(path.join(os.tmpdir(), "dsh-sup-"));
  const fake = createFakeAcpAgent({ turn: opts.turn });
  const driver = new DshDriver({
    dshBin: "dsh",
    dshHome: home,
    spawn: () => fake.child,
    resolveBinary: async (bin) => bin,
    logger,
  });
  vi.mocked(logger.warn).mockClear();
  // A pool stand-in: every query takes a tick, and INSERTs hand back a row
  // like Postgres would so the stream recorder's accumulation state works.
  let nextId = 1;
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    await new Promise((r) => setTimeout(r, 2));
    if (/INSERT INTO agent_stream_events/.test(sql)) {
      const id = nextId++;
      return {
        rows: [
          {
            id,
            agent_id: params?.[0],
            seq: id,
            kind: params?.[1],
            key: params?.[2],
            payload: JSON.parse(String(params?.[3])),
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  });
  const events: { type: string; message: string }[] = [];
  const deps = {
    pool: { query } as never,
    config: {
      dshBin: "dsh",
      dshHome: home,
      port: 1,
      tls: null,
      authToken: "secret",
      mediaRoot: path.join(home, "media"),
    },
    logger,
    driver,
    getAgent: vi.fn(async (id: string) => ({
      id,
      type: "dsh",
      cwd: "/tmp/w",
      mediaDir: null,
      model: "openai/gpt-5.2",
      cliSessionId: opts.cliSessionId ?? null,
    })) as never,
    setCliSessionId: vi.fn(async () => {}),
    setLatestEvent: vi.fn(
      async (_id: string, input: { type: string; message: string }) => {
        events.push(input);
      }
    ),
    publishChat: vi.fn(),
    personaPromptFor: vi.fn(async () => "PERSONA TEXT"),
    launchPromptFor: vi.fn(async () => opts.launchPrompt ?? null),
    listRunningAgentIds: vi.fn(async () => [] as string[]),
    markStartFailed: vi.fn(async () => {}),
  };
  const sup = new DshSupervisor(deps);
  return { fake, deps, events, sup, query };
}

describe("DshSupervisor", () => {
  it("start writes the overlay, records the session id, and marks idle", async () => {
    const { sup, deps, fake, events } = await build();
    await sup.start("agt_1");
    expect(deps.setCliSessionId).toHaveBeenCalledWith("agt_1", "sess_1");
    expect(fake.seen.newSession[0].cwd).toBe("/tmp/w");
    expect(fake.seen.newSession[0].mcpServers?.[0]).toMatchObject({
      type: "http",
      name: "dispatch",
      url: "http://127.0.0.1:1/api/mcp/agt_1",
    });
    const overlay = await readFile(
      path.join(home, "overlays", "agt_1.patch.yml"),
      "utf8"
    );
    expect(overlay).toContain("PERSONA TEXT");
    expect(overlay).toContain("gpt-5.2");
    expect(events.at(-1)).toEqual({
      type: "idle",
      message: "dsh session started.",
    });
    expect(sup.isRunning("agt_1")).toBe(true);
    await sup.stop("agt_1");
    await expect(
      readFile(path.join(home, "overlays", "agt_1.patch.yml"), "utf8")
    ).rejects.toThrow();
  });

  it("resumes a stored session id", async () => {
    const { sup, fake, events } = await build({ cliSessionId: "sess_old" });
    await sup.start("agt_1");
    expect(fake.seen.resumeSession[0]?.sessionId).toBe("sess_old");
    expect(events.at(-1)?.message).toBe("dsh session resumed.");
    await sup.stop("agt_1");
  });

  it("prompt marks working, then idle when the turn settles, and publishes the chat", async () => {
    const { sup, events, deps, query } = await build({
      turn: async (_p, emit) => {
        await emit({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "ok" },
        });
        return "end_turn";
      },
    });
    await sup.start("agt_1");
    await sup.prompt("agt_1", "go");
    expect(events.map((e) => e.type)).toEqual(["idle", "working", "idle"]);
    expect(deps.publishChat).toHaveBeenCalledWith("agt_1");
    // The stream recorder wrote through the pool.
    expect(query).toHaveBeenCalled();
    await sup.stop("agt_1");
  });

  it("prompt failure surfaces as idle with the error message", async () => {
    const { sup, events } = await build({
      turn: async () => {
        throw new Error("no API key for provider route");
      },
    });
    await sup.start("agt_1");
    await sup.prompt("agt_1", "go");
    expect(events.at(-1)).toMatchObject({
      type: "idle",
      message: expect.stringContaining("no API key"),
    });
    await sup.stop("agt_1");
  });

  it("refuses to start a non-dsh agent", async () => {
    const { sup, deps } = await build();
    deps.getAgent.mockResolvedValueOnce({
      id: "agt_c",
      type: "claude",
      cwd: "/tmp",
      model: null,
      cliSessionId: null,
    } as never);
    await expect(sup.start("agt_c")).rejects.toThrow(/not a dsh agent/);
  });

  it("handles a burst of stream events in order, one writer per agent", async () => {
    const { sup, query, deps } = await build({
      turn: async (_p, emit) => {
        // Fire without awaiting: the driver sees these back to back.
        const chunk = (text: string) =>
          emit({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text },
          });
        void chunk("a");
        void chunk("b");
        void emit({
          sessionUpdate: "tool_call",
          toolCallId: "t1",
          title: "Read x",
          kind: "read",
          status: "completed",
        });
        await chunk("c");
        return "end_turn";
      },
    });
    await sup.start("agt_1");
    await sup.prompt("agt_1", "go");
    const writes = query.mock.calls.map(
      ([sql, params]) => [String(sql).trim().slice(0, 6), params] as const
    );
    const inserted = writes
      .filter(([op]) => op === "INSERT")
      .map(([, params]) => (params as unknown[])[1]);
    // "a" opens the assistant row, "b" appends to it, the tool call closes
    // it, "c" opens a second row: exactly three inserts, in stream order.
    expect(inserted).toEqual(["assistant", "tool_call", "assistant"]);
    const finalTexts = writes
      .filter(([op]) => op === "UPDATE")
      .map(([, params]) => JSON.parse(String((params as unknown[])[1])).text)
      .filter((text) => typeof text === "string");
    expect(finalTexts.at(-1)).toBe("c");
    expect(finalTexts).toContain("ab");
    expect(deps.logger.warn).not.toHaveBeenCalledWith(
      expect.anything(),
      "dsh event handling failed"
    );
    await sup.stop("agt_1");
  });

  it("runs overlapping prompts one at a time, in order, and reports idle once", async () => {
    const { sup, fake, events } = await build({
      turn: async (p, emit) => {
        await new Promise((r) => setTimeout(r, 15));
        await emit({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `echo ${p}` },
        });
        return "end_turn";
      },
    });
    await sup.start("agt_1");
    const first = sup.enqueuePrompt("agt_1", "one");
    const second = sup.enqueuePrompt("agt_1", "two");
    expect(sup.isBusy("agt_1")).toBe(true);
    await first.started;
    let secondStarted = false;
    void second.started.then(() => {
      secondStarted = true;
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(secondStarted).toBe(false);
    await first.settled;
    await second.settled;
    expect(fake.seen.prompts).toEqual(["one", "two"]);
    expect(events.map((e) => e.type)).toEqual([
      "idle",
      "working",
      "working",
      "idle",
    ]);
    expect(sup.isBusy("agt_1")).toBe(false);
    await sup.stop("agt_1");
  });

  it("restores running agents at boot and marks the ones that fail", async () => {
    const { sup, deps, fake } = await build();
    deps.listRunningAgentIds.mockResolvedValue(["agt_1", "agt_2"]);
    deps.getAgent.mockImplementation(async (id: string) =>
      id === "agt_2"
        ? {
            id,
            type: "claude",
            cwd: "/tmp",
            mediaDir: null,
            model: null,
            cliSessionId: null,
          }
        : {
            id,
            type: "dsh",
            cwd: "/tmp/w",
            mediaDir: null,
            model: null,
            cliSessionId: null,
          }
    );
    const result = await sup.restoreRunning();
    expect(result).toEqual({ restored: ["agt_1"], failed: ["agt_2"] });
    expect(deps.markStartFailed).toHaveBeenCalledWith(
      "agt_2",
      expect.stringContaining("not a dsh agent")
    );
    expect(fake.seen.newSession).toHaveLength(1);
    await sup.stopAll();
    expect(sup.isRunning("agt_1")).toBe(false);
  });
});

describe("DshSupervisor launch prompt", () => {
  it("sends the launch prompt as the first turn of a fresh session", async () => {
    const { sup, fake, events } = await build({ launchPrompt: "do the thing" });
    await sup.start("agt_1");
    await new Promise((r) => setTimeout(r, 20));
    expect(fake.seen.prompts).toEqual(["do the thing"]);
    expect(events.map((e) => e.type)).toEqual(["idle", "working", "idle"]);
    await sup.stop("agt_1");
  });

  it("does not resend it on resume", async () => {
    const { sup, fake } = await build({
      launchPrompt: "do the thing",
      cliSessionId: "sess_old",
    });
    await sup.start("agt_1");
    await new Promise((r) => setTimeout(r, 20));
    expect(fake.seen.prompts).toEqual([]);
    await sup.stop("agt_1");
  });
});

describe("defaultModelFor", () => {
  it("prefers DeepSeek, then OpenAI, else the profile default", () => {
    expect(
      defaultModelFor({ DEEPSEEK_API_KEY: "x", OPENAI_API_KEY: "y" })
    ).toBe("deepseek-official/deepseek-v4-flash");
    expect(defaultModelFor({ OPENAI_API_KEY: "y" })).toBe("openai/gpt-5.2");
    expect(defaultModelFor({})).toBeNull();
  });
});

describe("buildChildEnv", () => {
  const base = {
    PATH: "/usr/bin",
    HOME: "/home/u",
    SSH_AUTH_SOCK: "/tmp/agent.sock",
    HTTPS_PROXY: "http://proxy:3128",
    OPENAI_API_KEY: "sk-test",
    DATABASE_URL: "postgres://secret",
    PGPASSWORD: "hunter2",
    DISPATCH_SESSION_PREFIX: "dispatch",
    TLS_CA: "/etc/ca.pem",
  };

  it("passes the login-shell environment through and drops Dispatch internals", () => {
    const env = buildChildEnv({
      agentId: "agt_1",
      mediaDir: "/media/agt_1",
      config: { port: 6767, tls: null },
      base,
    });
    expect(env.SSH_AUTH_SOCK).toBe("/tmp/agent.sock");
    expect(env.HTTPS_PROXY).toBe("http://proxy:3128");
    expect(env.OPENAI_API_KEY).toBe("sk-test");
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.PGPASSWORD).toBeUndefined();
    expect(env.DISPATCH_SESSION_PREFIX).toBeUndefined();
    expect(env.DISPATCH_AGENT_ID).toBe("agt_1");
    expect(env.DISPATCH_MEDIA_DIR).toBe("/media/agt_1");
    expect(env.DISPATCH_PORT).toBe("6767");
    expect(env.DISPATCH_SCHEME).toBe("http");
    expect(env.NODE_EXTRA_CA_CERTS).toBeUndefined();
  });

  it("exports the TLS CA for the loopback https MCP URL", () => {
    const env = buildChildEnv({
      agentId: "agt_1",
      mediaDir: "/m",
      config: {
        port: 6767,
        tls: { cert: Buffer.from(""), key: Buffer.from("") },
      },
      base,
    });
    expect(env.DISPATCH_SCHEME).toBe("https");
    expect(env.NODE_EXTRA_CA_CERTS).toBe("/etc/ca.pem");
    expect(env.TLS_CA).toBeUndefined();
  });
});
