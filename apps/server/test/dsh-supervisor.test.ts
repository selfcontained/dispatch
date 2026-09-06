import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createJobMcpToken } from "../src/auth.js";
import { DshDriver } from "../src/agents/dsh/driver.js";
import {
  buildChildEnv,
  defaultModelFor,
  DshSupervisor,
  RESTART_PROMPT,
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
  opts: {
    turn?: FakeTurn;
    cliSessionId?: string;
    launchPrompt?: string;
    /** The binary cannot be resolved: driver.start rejects. */
    startFails?: boolean;
    /** What the newest turn row's error column says. */
    lastTurnError?: string | null;
    /** When that turn ended; defaults to now. */
    lastTurnEndedAt?: Date;
    /** The stored session cannot be resumed: dsh opens a fresh one. */
    resumeFails?: boolean;
  } = {}
) {
  home = await mkdtemp(path.join(os.tmpdir(), "dsh-sup-"));
  const fake = createFakeAcpAgent({
    turn: opts.turn,
    resumeFails: opts.resumeFails,
  });
  const driver = new DshDriver({
    dshBin: "dsh",
    dshHome: home,
    spawn: () => fake.child,
    resolveBinary: async (bin) => {
      if (opts.startFails) throw new Error("dsh not found on PATH");
      return bin;
    },
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
  if (opts.lastTurnError !== undefined) {
    const error = opts.lastTurnError;
    query.mockImplementation(async (sql: string) => {
      await new Promise((r) => setTimeout(r, 2));
      if (/payload->>'error' AS error/.test(sql)) {
        return {
          rows: [
            {
              error,
              ended_at: (opts.lastTurnEndedAt ?? new Date()).toISOString(),
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
  }
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
      .map(([, params]) => (params as unknown[])[1])
      .filter((kind) => kind !== "turn");
    // "a" opens the assistant row, "b" appends to it, the tool call closes
    // it, "c" opens a second row: exactly three inserts, in stream order.
    expect(inserted).toEqual(["assistant", "tool_call", "assistant"]);
    const finalTexts = writes
      .filter(([op]) => op === "UPDATE")
      // Row updates carry the payload as $2; the reconcile sweep does not.
      .filter(([, params]) => typeof (params as unknown[])[1] === "string")
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
    expect(defaultModelFor({ OPENAI_API_KEY: "y" })).toBe("openai/gpt-5.6-sol");
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

describe("DshSupervisor lifecycle edges", () => {
  it("keeps a terminal status the agent set during the turn", async () => {
    let depsRef: {
      setLatestEvent: (
        id: string,
        e: { type: string; message: string }
      ) => Promise<void>;
    } | null = null;
    const { sup, deps, events, fake } = await build({
      turn: async () => {
        // The agent's own dispatch_event done, from inside the turn.
        await depsRef!.setLatestEvent("agt_1", {
          type: "done",
          message: "Review submitted",
        });
        return "end_turn";
      },
    });
    depsRef = deps;
    const stamp = (n: number) =>
      new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
    deps.getAgent.mockImplementation(async (id: string) => ({
      id,
      type: "dsh",
      cwd: "/tmp/w",
      mediaDir: null,
      model: null,
      cliSessionId: null,
      latestEvent: events.length
        ? {
            ...events[events.length - 1],
            updatedAt: stamp(events.length),
            metadata: null,
          }
        : null,
    }));
    await sup.start("agt_1");
    events.length = 0;
    await sup.prompt("agt_1", "review this");
    expect(events.map((e) => e.type)).toEqual(["working", "done"]);
    await sup.stopAll();
    expect(fake.seen.prompts).toHaveLength(1);
  });

  it("marks an unexpected exit, code 0 included, through markExited", async () => {
    const { sup, deps, fake } = await build();
    const markExited = vi.fn(async () => {});
    (deps as { markExited?: typeof markExited }).markExited = markExited;
    await sup.start("agt_1");
    // dsh quits on its own: the child exits without Dispatch asking.
    fake.child.kill("SIGTERM");
    await vi.waitFor(() => expect(markExited).toHaveBeenCalled());
    expect(markExited).toHaveBeenCalledWith(
      "agt_1",
      expect.stringContaining("dsh exited")
    );
    expect(sup.isRunning("agt_1")).toBe(false);
  });

  it("removes the overlay when the driver fails to start", async () => {
    const { sup } = await build({ startFails: true });
    await expect(sup.start("agt_1")).rejects.toThrow(/dsh not found/);
    const overlays = await readdir(path.join(home, "overlays")).catch(() => []);
    expect(overlays).toEqual([]);
  });

  it("settles rows a previous process left open before starting", async () => {
    const { sup, query } = await build();
    await sup.start("agt_1");
    const settle = query.mock.calls.find(([sql]) =>
      /payload->>'state' = 'started'/.test(String(sql))
    );
    expect(settle?.[1]?.[0]).toBe("agt_1");
    await sup.stopAll();
  });
});

describe("DshSupervisor job runs", () => {
  it("attaches the job MCP route and token for an agent running a job", async () => {
    const { sup, deps, fake } = await build();
    (
      deps as { activeJobRunIdFor?: (id: string) => Promise<string | null> }
    ).activeJobRunIdFor = vi.fn(async () => "run_42");
    await sup.start("agt_1");
    const server = fake.seen.newSession[0]?.mcpServers?.[0] as {
      url: string;
      headers: { name: string; value: string }[];
    };
    expect(server.url).toMatch(/\/api\/mcp\/jobs\/run_42\/agt_1$/);
    expect(server.headers[0].value).toBe(
      `Bearer ${createJobMcpToken("secret", "run_42", "agt_1")}`
    );
    expect(deps.personaPromptFor).toHaveBeenCalledWith(
      expect.objectContaining({ id: "agt_1" }),
      "run_42"
    );
    await sup.stopAll();
  });
});

describe("DshSupervisor message queue", () => {
  const CHAT_ID = "0f3d2a8e-6c4b-4c1e-9b7a-1d2e3f4a5b6c";
  const envelope = (text: string) =>
    `--- DISPATCH CHAT (id: ${CHAT_ID}) ---\n${text}\n--- END DISPATCH CHAT ---`;

  it("lists what waits behind the running turn, in order, and drains it", async () => {
    const { sup, fake, deps } = await build({
      turn: async () => {
        await new Promise((r) => setTimeout(r, 15));
        return "end_turn";
      },
    });
    await sup.start("agt_1");
    const first = sup.enqueuePrompt("agt_1", "one");
    sup.enqueuePrompt("agt_1", envelope("two"));
    const third = sup.enqueuePrompt("agt_1", "three");
    await first.started;
    const queued = sup.listQueued("agt_1");
    expect(queued.map((q) => q.source)).toEqual([
      { source: "chat", chatMessageId: CHAT_ID },
      { source: "system", text: "three" },
    ]);
    // A chat message queues under its own id, so the view can act on it.
    expect(queued[0].id).toBe(CHAT_ID);
    expect(queued[1].id).toMatch(/^q_/);
    expect(queued[0].createdAt <= queued[1].createdAt).toBe(true);
    // The feed is told, so the view lists the wait without a stream write.
    expect(deps.publishChat).toHaveBeenCalledWith("agt_1");
    await third.settled;
    expect(sup.listQueued("agt_1")).toEqual([]);
    expect(fake.seen.prompts).toEqual(["one", envelope("two"), "three"]);
    expect(sup.isBusy("agt_1")).toBe(false);
    await sup.stop("agt_1");
  });

  it("removes a queued prompt: it never runs and its start rejects", async () => {
    const { sup, fake, events } = await build({
      turn: async () => {
        await new Promise((r) => setTimeout(r, 15));
        return "end_turn";
      },
    });
    await sup.start("agt_1");
    const first = sup.enqueuePrompt("agt_1", "one");
    const second = sup.enqueuePrompt("agt_1", envelope("two"));
    await first.started;
    expect(sup.removeQueued("agt_1", CHAT_ID)).toBe(true);
    expect(sup.removeQueued("agt_1", CHAT_ID)).toBe(false);
    await expect(second.started).rejects.toThrow(/removed/i);
    await second.settled;
    await first.settled;
    expect(fake.seen.prompts).toEqual(["one"]);
    // With nothing left behind it, the first turn settles the agent idle.
    expect(events.map((e) => e.type)).toEqual(["idle", "working", "idle"]);
    expect(sup.isBusy("agt_1")).toBe(false);
    await sup.stop("agt_1");
  });

  it("send-now moves a prompt to the front and interrupts the running turn", async () => {
    const { sup, fake } = await build({
      turn: async (_p, _emit, _ask, signal) => {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 400);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
          });
        });
        return signal.aborted ? "cancelled" : "end_turn";
      },
    });
    await sup.start("agt_1");
    const first = sup.enqueuePrompt("agt_1", "one");
    const second = sup.enqueuePrompt("agt_1", "two");
    const third = sup.enqueuePrompt("agt_1", envelope("three"));
    await first.started;
    expect(await sup.sendQueuedNow("agt_1", CHAT_ID)).toBe(true);
    expect(await sup.sendQueuedNow("agt_1", "nope")).toBe(false);
    await third.started;
    expect(sup.listQueued("agt_1").map((q) => q.source)).toEqual([
      { source: "system", text: "two" },
    ]);
    await second.settled;
    expect(fake.seen.cancels).toBe(1);
    expect(fake.seen.prompts).toEqual(["one", envelope("three"), "two"]);
    await sup.stop("agt_1");
  });

  it("shutdown leaves a queued chat message pending for the next boot", async () => {
    const CHAT = "0f3d2a8e-6c4b-4c1e-9b7a-1d2e3f4a5b6c";
    const { sup, fake } = await build({
      turn: async (_p, _emit, _ask, signal) => {
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve());
          setTimeout(resolve, 2000);
        });
        return "cancelled";
      },
    });
    await sup.start("agt_1");
    const first = sup.enqueuePrompt("agt_1", "one");
    const chat = sup.enqueuePrompt(
      "agt_1",
      `--- DISPATCH CHAT (id: ${CHAT}) ---\nlater\n--- END DISPATCH CHAT ---`
    );
    const system = sup.enqueuePrompt("agt_1", "system note");
    await first.started;
    let chatSettled: "pending" | "started" | "failed" = "pending";
    chat.started.then(
      () => (chatSettled = "started"),
      () => (chatSettled = "failed")
    );
    await sup.stopAll();
    await expect(system.started).rejects.toThrow(/stopped/);
    await chat.settled;
    await new Promise((r) => setTimeout(r, 10));
    expect(chatSettled).toBe("pending");
    expect(fake.seen.prompts).toEqual(["one"]);
  });

  it("stop drops what is queued and fails their starts", async () => {
    const { sup, fake } = await build({
      turn: async (_p, _emit, _ask, signal) => {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 400);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
          });
        });
        return "end_turn";
      },
    });
    await sup.start("agt_1");
    const first = sup.enqueuePrompt("agt_1", "one");
    const second = sup.enqueuePrompt("agt_1", "two");
    await first.started;
    await sup.stop("agt_1");
    await expect(second.started).rejects.toThrow(/stopped/i);
    await first.settled;
    expect(fake.seen.prompts).toEqual(["one"]);
    expect(sup.listQueued("agt_1")).toEqual([]);
    expect(sup.isBusy("agt_1")).toBe(false);
  });
});

describe("DshSupervisor restart resilience", () => {
  it("resumes an agent whose last turn the restart cut short", async () => {
    const { sup, deps, fake } = await build({
      cliSessionId: "sess_old",
      lastTurnError: "interrupted by restart",
    });
    deps.listRunningAgentIds.mockResolvedValue(["agt_1"]);
    await sup.restoreRunning();
    await vi.waitFor(() => expect(fake.seen.prompts).toEqual([RESTART_PROMPT]));
    await sup.stopAll();
  });

  it("does not resume when the cut is old, the agent is done, or the session is fresh", async () => {
    for (const build_opts of [
      {
        cliSessionId: "sess_old",
        lastTurnError: "interrupted by restart",
        lastTurnEndedAt: new Date(Date.now() - 2 * 60 * 60_000),
      },
      {
        cliSessionId: "sess_old",
        lastTurnError: "interrupted by restart",
        resumeFails: true,
      },
    ]) {
      const { sup, deps, fake } = await build(build_opts);
      deps.listRunningAgentIds.mockResolvedValue(["agt_1"]);
      await sup.restoreRunning();
      await new Promise((r) => setTimeout(r, 30));
      expect(fake.seen.prompts).toEqual([]);
      await sup.stopAll();
    }
    const { sup, deps, fake } = await build({
      cliSessionId: "sess_old",
      lastTurnError: "interrupted by restart",
    });
    deps.getAgent.mockImplementation(async (id: string) => ({
      id,
      type: "dsh",
      cwd: "/tmp/w",
      mediaDir: null,
      model: null,
      cliSessionId: "sess_old",
      latestEvent: {
        type: "done",
        message: "Review submitted",
        updatedAt: "x",
      },
    }));
    deps.listRunningAgentIds.mockResolvedValue(["agt_1"]);
    await sup.restoreRunning();
    await new Promise((r) => setTimeout(r, 30));
    expect(fake.seen.prompts).toEqual([]);
    await sup.stopAll();
  });

  it("leaves an agent alone when its last turn ended on its own", async () => {
    const { sup, deps, fake } = await build({
      cliSessionId: "sess_old",
      lastTurnError: null,
    });
    deps.listRunningAgentIds.mockResolvedValue(["agt_1"]);
    await sup.restoreRunning();
    await new Promise((r) => setTimeout(r, 30));
    expect(fake.seen.prompts).toEqual([]);
    await sup.stopAll();
  });

  it("marks a running turn as interrupted by restart when shutting down", async () => {
    const { sup, query, fake } = await build({
      turn: async (_p, _emit, _ask, signal) => {
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve());
          setTimeout(resolve, 2000);
        });
        return "cancelled";
      },
    });
    await sup.start("agt_1");
    const first = sup.enqueuePrompt("agt_1", "long job");
    await first.started;
    query.mockClear();
    await sup.stopAll();
    const settle = query.mock.calls.find(([sql]) =>
      /payload->>'state' = 'started'/.test(String(sql))
    );
    expect(settle?.[1]?.[0]).toBe("agt_1");
    expect(String(settle?.[1]?.[1])).toContain("interrupted by restart");
    expect(fake.seen.closes).toBe(1);
  });
});
