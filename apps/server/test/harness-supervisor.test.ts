import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createJobMcpToken } from "../src/auth.js";
import { HarnessDriver } from "../src/agents/harness/driver.js";
import {
  buildChildEnv,
  HarnessSupervisor,
  loginFailureMessage,
  RESTART_PROMPT,
} from "../src/agents/harness/supervisor.js";
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
    /** The agent's stored model id; claude/default when omitted. */
    model?: string | null;
    /** Config options the fake session publishes. */
    configOptions?: Parameters<typeof createFakeAcpAgent>[0]["configOptions"];
    /** Slash commands the fake session announces after it opens. */
    commands?: Parameters<typeof createFakeAcpAgent>[0]["commands"];
    /** The binary cannot be resolved: driver.start rejects. */
    startFails?: boolean;
    /** What the newest turn row's error column says. */
    lastTurnError?: string | null;
    /** When that turn ended; defaults to now. */
    lastTurnEndedAt?: Date;
    /** The stored session cannot be resumed: the engine opens a fresh one. */
    resumeFails?: boolean;
  } = {}
) {
  home = await mkdtemp(path.join(os.tmpdir(), "harness-sup-"));
  const fake = createFakeAcpAgent({
    turn: opts.turn,
    resumeFails: opts.resumeFails,
    configOptions: opts.configOptions,
    commands: opts.commands,
  });
  const resolveBinary = async (bin: string) => {
    if (opts.startFails) {
      throw new Error(`${bin} was not found on the server's PATH`);
    }
    return bin;
  };
  const driver = new HarnessDriver({
    spawn: () => fake.child,
    resolveBinary,
    logger,
  });
  vi.mocked(logger.warn).mockClear();
  // A pool stand-in: every query takes a tick, and INSERTs hand back a row
  // like Postgres would so the stream recorder's accumulation state works.
  let nextId = 1;
  const defaultQuery = async (sql: string, params?: unknown[]) => {
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
  };
  const query = vi.fn(defaultQuery);
  if (opts.lastTurnError !== undefined) {
    const error = opts.lastTurnError;
    // Only the settlement query is special-cased here; everything else
    // (INSERTs included) falls through to the default stand-in above, or
    // the recorder's writes fail silently and every other test that also
    // passes `lastTurnError` would show no stream rows and a swallowed
    // "harness event handling failed" warning.
    query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (/payload->>'error' AS error/.test(sql)) {
        await new Promise((r) => setTimeout(r, 2));
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
      return defaultQuery(sql, params);
    });
  }
  const events: { type: string; message: string }[] = [];
  const deps = {
    pool: { query } as never,
    config: {
      claudeHarnessBin: "/bin/claude-agent-acp",
      codexHarnessBin: "/bin/codex-acp",
      geminiBin: "/bin/gemini",
      opencodeBin: "/bin/opencode",
      claudeBin: "/bin/claude",
      codexBin: "/bin/codex",
      port: 1,
      tls: null,
      authToken: "secret",
      mediaRoot: path.join(home, "media"),
    },
    logger,
    driver,
    resolveBinary,
    getAgent: vi.fn(async (id: string) => ({
      id,
      type: "dispatch",
      cwd: "/tmp/w",
      mediaDir: null,
      model: opts.model === undefined ? null : opts.model,
      cliSessionId: opts.cliSessionId ?? null,
    })) as never,
    setCliSessionId: vi.fn(async () => {}),
    setLatestEvent: vi.fn(
      async (_id: string, input: { type: string; message: string }) => {
        events.push(input);
      }
    ),
    publishHarness: vi.fn(),
    personaPromptFor: vi.fn(async () => "PERSONA TEXT"),
    launchPromptFor: vi.fn(async () => opts.launchPrompt ?? null),
    listRunningAgentIds: vi.fn(async () => [] as string[]),
    markStartFailed: vi.fn(async () => {}),
  };
  const sup = new HarnessSupervisor(deps);
  return { fake, deps, events, sup, query };
}

describe("HarnessSupervisor", () => {
  it("start records the session id, delivers the persona via _meta, and marks idle", async () => {
    const { sup, deps, fake, events } = await build();
    await sup.start("agt_1");
    expect(deps.setCliSessionId).toHaveBeenCalledWith("agt_1", "sess_1");
    expect(fake.seen.newSession[0].cwd).toBe("/tmp/w");
    expect(fake.seen.newSession[0].mcpServers?.[0]).toMatchObject({
      type: "http",
      name: "dispatch",
      url: "http://127.0.0.1:1/api/mcp/agt_1",
    });
    expect(fake.seen.newSession[0]._meta).toEqual({
      systemPrompt: { append: "PERSONA TEXT" },
    });
    expect(events.at(-1)).toEqual({
      type: "idle",
      message: "Harness session started.",
    });
    expect(sup.isRunning("agt_1")).toBe(true);
    await sup.stop("agt_1");
  });

  it("resumes a stored session id", async () => {
    const { sup, fake, events } = await build({ cliSessionId: "sess_old" });
    await sup.start("agt_1");
    expect(fake.seen.resumeSession[0]?.sessionId).toBe("sess_old");
    expect(events.at(-1)?.message).toBe("Harness session resumed.");
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
    expect(deps.publishHarness).toHaveBeenCalledWith("agt_1", true);
    // The stream recorder wrote through the pool.
    expect(query).toHaveBeenCalled();
    await sup.stop("agt_1");
  });

  it("coalesces the publishes streamed updates drive, and publishes a settled turn at once", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { sup, deps } = await build({
      turn: async (_p, emit) => {
        for (let i = 0; i < 10; i += 1) {
          await emit({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `chunk ${i}` },
          });
        }
        await gate;
        return "end_turn";
      },
    });
    await sup.start("agt_1");
    vi.useFakeTimers();
    try {
      deps.publishHarness.mockClear();
      const turn = sup.prompt("agt_1", "go");
      // The turn's start publishes at once. The ten chunks behind it wait on
      // one trailing timer instead of taking a frame each.
      await vi.advanceTimersByTimeAsync(50);
      expect(deps.publishHarness.mock.calls).toEqual([["agt_1", true]]);
      await vi.advanceTimersByTimeAsync(60);
      expect(deps.publishHarness.mock.calls).toEqual([
        ["agt_1", true],
        ["agt_1"],
      ]);
      release();
      await vi.advanceTimersByTimeAsync(20);
      await turn;
      expect(deps.publishHarness.mock.calls.at(-1)).toEqual(["agt_1", true]);
      // Nothing is left on a timer behind the settled turn.
      const total = deps.publishHarness.mock.calls.length;
      await vi.advanceTimersByTimeAsync(300);
      expect(deps.publishHarness.mock.calls.length).toBe(total);
    } finally {
      vi.useRealTimers();
    }
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

  it("refuses to start a non-Dispatch Harness agent", async () => {
    const { sup, deps } = await build();
    deps.getAgent.mockResolvedValueOnce({
      id: "agt_c",
      type: "claude",
      cwd: "/tmp",
      model: null,
      cliSessionId: null,
    } as never);
    await expect(sup.start("agt_c")).rejects.toThrow(
      /not a Dispatch Harness agent/
    );
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
      "harness event handling failed"
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
            type: "dispatch",
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
      expect.stringContaining("not a Dispatch Harness agent")
    );
    expect(fake.seen.newSession).toHaveLength(1);
    await sup.stopAll();
    expect(sup.isRunning("agt_1")).toBe(false);
  });
});

describe("HarnessSupervisor engines", () => {
  it("claude: persona travels in _meta and the first prompt is the launch post alone", async () => {
    const { sup, fake } = await build({
      launchPrompt:
        "--- DISPATCH CHAT (id: 11111111-1111-1111-1111-111111111111) ---\nhello",
    });
    await sup.start("agt_c");
    await new Promise((r) => setTimeout(r, 20));
    expect(fake.seen.newSession[0]._meta).toEqual({
      systemPrompt: { append: "PERSONA TEXT" },
    });
    expect(fake.seen.prompts[0]).toMatch(/^--- DISPATCH CHAT/);
    await sup.stop("agt_c");
  });

  it("codex: the persona is the leading block of the first prompt of a fresh session", async () => {
    const { sup, fake } = await build({
      model: "codex/default",
      launchPrompt:
        "--- DISPATCH CHAT (id: 22222222-2222-2222-2222-222222222222) ---\nhello",
    });
    await sup.start("agt_x");
    await new Promise((r) => setTimeout(r, 20));
    expect(fake.seen.newSession[0]._meta).toBeUndefined();
    expect(fake.seen.prompts[0]).toBe(
      "PERSONA TEXT\n\n--- DISPATCH CHAT (id: 22222222-2222-2222-2222-222222222222) ---\nhello"
    );
    // The second prompt carries no persona.
    await sup.prompt("agt_x", "again");
    expect(fake.seen.prompts[1]).toBe("again");
    await sup.stop("agt_x");
  });

  it("codex: a resumed session gets no persona prefix", async () => {
    const { sup, fake } = await build({
      model: "codex/default",
      cliSessionId: "sess_old",
      // A turn already ran on this session, so its history already has the
      // persona; only that (not merely `resumed`) should suppress it.
      lastTurnError: null,
    });
    await sup.start("agt_r");
    await sup.prompt("agt_r", "continue");
    expect(fake.seen.prompts).toEqual(["continue"]);
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.anything(),
      "harness event handling failed"
    );
    await sup.stop("agt_r");
  });

  it("codex: a resumed session that never ran a turn still gets the persona prefix", async () => {
    // The process stopped (or crashed) between opening the session and its
    // first prompt: the resume has nothing in its history to carry the
    // persona, so it must still be delivered: same as a fresh session, the
    // launch prompt is resent as the first turn.
    const { sup, fake } = await build({
      model: "codex/default",
      cliSessionId: "sess_old",
      launchPrompt:
        "--- DISPATCH CHAT (id: 33333333-3333-3333-3333-333333333333) ---\nhello",
    });
    await sup.start("agt_r");
    await new Promise((r) => setTimeout(r, 20));
    expect(fake.seen.prompts[0]).toBe(
      "PERSONA TEXT\n\n--- DISPATCH CHAT (id: 33333333-3333-3333-3333-333333333333) ---\nhello"
    );
    // The second prompt carries no persona: it was already consumed.
    await sup.prompt("agt_r", "continue");
    expect(fake.seen.prompts[1]).toBe("continue");
    await sup.stop("agt_r");
  });

  it("gemini: sets the yolo mode and never asks the session for a model option", async () => {
    const { sup, fake } = await build({ model: "gemini/gemini-2.5-pro" });
    await sup.start("agt_g");
    expect(fake.seen.setMode).toEqual([
      { sessionId: "sess_1", modeId: "yolo" },
    ]);
    expect(fake.seen.setConfig).toEqual([]);
    // A non-default model with no config option to apply it through would
    // normally warn; the modelFixedAtLaunch guard is what keeps this quiet.
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringMatching(/publishes no model option/)
    );
    await sup.stop("agt_g");
  });

  it("applies a non-default model through the session's model option", async () => {
    const { sup, fake } = await build({
      model: "opencode/anthropic/claude-sonnet-5",
      configOptions: [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "openai/gpt-5.5",
          options: [
            { value: "openai/gpt-5.5", name: "GPT-5.5" },
            { value: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5" },
          ],
        },
      ],
    });
    await sup.start("agt_o");
    expect(fake.seen.setConfig).toEqual([
      {
        sessionId: "sess_1",
        configId: "model",
        value: "anthropic/claude-sonnet-5",
      },
    ]);
    await sup.stop("agt_o");
  });

  it("warns and keeps the default when a non-default model meets no model option", async () => {
    const { sup, fake } = await build({ model: "codex/gpt-5.6-sol" });
    await sup.start("agt_w");
    expect(fake.seen.setConfig).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "agt_w", model: "gpt-5.6-sol" }),
      expect.stringMatching(/publishes no model option/)
    );
    await sup.stop("agt_w");
  });

  it("rejects an agent whose model has no engine prefix", async () => {
    const { sup } = await build({ model: "gpt-5.6-sol" });
    await expect(sup.start("agt_bad")).rejects.toThrow(/engine\/model/);
  });

  it("records the engine, not just the model, on the token-usage row", async () => {
    const { sup, query } = await build({
      model: "codex/gpt-5.6-sol",
      turn: async () => ({
        stopReason: "end_turn",
        usage: {
          totalTokens: 30,
          inputTokens: 20,
          outputTokens: 10,
          thoughtTokens: 0,
          cachedReadTokens: 0,
          cachedWriteTokens: 0,
        },
      }),
    });
    await sup.start("agt_1");
    await sup.prompt("agt_1", "go");
    const usageInsert = query.mock.calls.find(([sql]) =>
      /INSERT INTO agent_token_usage/.test(String(sql))
    );
    expect(usageInsert?.[1]?.[2]).toBe("codex/gpt-5.6-sol");
    await sup.stop("agt_1");
  });

  it("serves the commands the engine advertised", async () => {
    const { sup } = await build({
      commands: [
        { name: "review", description: "Review the branch", input: null },
        { name: "compact", description: "Compact", input: { hint: "focus" } },
      ],
    });
    expect(sup.getCommands("agt_none")).toBeNull();
    await sup.start("agt_1");
    await new Promise((r) => setTimeout(r, 20));
    expect(sup.getCommands("agt_1")).toEqual([
      { name: "review", description: "Review the branch" },
      { name: "compact", description: "Compact", input: { hint: "focus" } },
    ]);
    await sup.stop("agt_1");
  });
});

describe("HarnessSupervisor launch prompt", () => {
  it("sends the launch prompt as the first turn of a fresh session", async () => {
    const { sup, fake, events } = await build({ launchPrompt: "do the thing" });
    await sup.start("agt_1");
    await new Promise((r) => setTimeout(r, 20));
    expect(fake.seen.prompts).toEqual(["do the thing"]);
    expect(events.map((e) => e.type)).toEqual(["idle", "working", "idle"]);
    await sup.stop("agt_1");
  });

  it("does not resend it on resume once a turn has run", async () => {
    const { sup, fake } = await build({
      launchPrompt: "do the thing",
      cliSessionId: "sess_old",
      // A turn already ran on this session, so the launch prompt already
      // went out; only a resume that never ran a turn resends it.
      lastTurnError: null,
    });
    await sup.start("agt_1");
    await new Promise((r) => setTimeout(r, 20));
    expect(fake.seen.prompts).toEqual([]);
    await sup.stop("agt_1");
  });

  it("resends it on a resume that never ran a turn", async () => {
    // The process stopped (or crashed) between opening the session and its
    // first prompt: the resume has no turn behind it, so the launch prompt
    // never went out and must be sent now.
    const { sup, fake } = await build({
      launchPrompt: "do the thing",
      cliSessionId: "sess_old",
    });
    await sup.start("agt_1");
    await new Promise((r) => setTimeout(r, 20));
    expect(fake.seen.prompts).toEqual(["do the thing"]);
    await sup.stop("agt_1");
  });
});

describe("buildChildEnv", () => {
  const base = {
    PATH: "/usr/bin",
    HOME: "/home/u",
    SSH_AUTH_SOCK: "/tmp/agent.sock",
    HTTPS_PROXY: "http://proxy:3128",
    OPENAI_API_KEY: "sk-test",
    CODEX_API_KEY: "sk-codex",
    ANTHROPIC_API_KEY: "sk-anthropic",
    GEMINI_API_KEY: "gem-key",
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
    expect(env.HOME).toBe("/home/u");
    // Each engine authenticates through its own host login, so a provider
    // key left in the service environment must not reach the child.
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.CODEX_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    // Except this one: it is one of Gemini CLI's own logins.
    expect(env.GEMINI_API_KEY).toBe("gem-key");
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

describe("HarnessSupervisor lifecycle edges", () => {
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
      type: "dispatch",
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
    // The engine quits on its own: the child exits without Dispatch asking.
    fake.child.kill("SIGTERM");
    await vi.waitFor(() => expect(markExited).toHaveBeenCalled());
    expect(markExited).toHaveBeenCalledWith(
      "agt_1",
      expect.stringContaining("The engine exited")
    );
    expect(sup.isRunning("agt_1")).toBe(false);
  });

  it("fails to start when the engine binary cannot be resolved", async () => {
    const { sup } = await build({ startFails: true });
    await expect(sup.start("agt_1")).rejects.toThrow(
      /was not found on the server's PATH/
    );
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

describe("HarnessSupervisor job runs", () => {
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

describe("HarnessSupervisor message queue", () => {
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
    expect(deps.publishHarness).toHaveBeenCalledWith("agt_1");
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

describe("HarnessSupervisor restart resilience", () => {
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
    // As in production: the record says "done" until start() writes
    // "session resumed" over it, so the guard must read it before that.
    let latest = { type: "done", message: "Review submitted", updatedAt: "x" };
    deps.setLatestEvent.mockImplementation(
      async (_id: string, input: { type: string; message: string }) => {
        latest = { ...input, updatedAt: "y" };
      }
    );
    deps.getAgent.mockImplementation(async (id: string) => ({
      id,
      type: "dispatch",
      cwd: "/tmp/w",
      mediaDir: null,
      model: null,
      cliSessionId: "sess_old",
      latestEvent: latest,
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

describe("loginFailureMessage", () => {
  it("names the engine for an auth_required code", () => {
    const err = Object.assign(new Error("Authentication required"), {
      code: -32000,
    });
    expect(loginFailureMessage("codex", err)).toBe(
      "Codex is not logged in on the server."
    );
  });

  it("is null for an unrelated error", () => {
    expect(loginFailureMessage("codex", new Error("ENOENT"))).toBeNull();
  });

  it("recognizes Claude's please-run-/login reply", () => {
    expect(loginFailureMessage("claude", new Error("Please run /login"))).toBe(
      "Claude Code is not logged in on the server."
    );
  });
});

describe("HarnessSupervisor login failure", () => {
  /** A driver stub whose start() always rejects; only start() and onEvent()
   * are exercised by the paths under test here. */
  function stubDriver(err: unknown): HarnessDriver {
    return {
      start: vi.fn().mockRejectedValue(err),
      onEvent: vi.fn(),
    } as unknown as HarnessDriver;
  }

  it("start() rejects with the engine's login message on an auth_required failure", async () => {
    const { deps } = await build({ model: "codex/default" });
    const err = Object.assign(new Error("Authentication required"), {
      code: -32000,
    });
    const sup = new HarnessSupervisor({ ...deps, driver: stubDriver(err) });
    await expect(sup.start("agt_1")).rejects.toThrow(
      "Codex is not logged in on the server."
    );
  });

  it("boot restore marks a login failure with the engine's message", async () => {
    const { deps } = await build({ model: "gemini/default" });
    deps.listRunningAgentIds.mockResolvedValue(["agt_g"]);
    const err = new Error("Authentication required: run gemini");
    const sup = new HarnessSupervisor({ ...deps, driver: stubDriver(err) });
    const result = await sup.restoreRunning();
    expect(result.failed).toEqual(["agt_g"]);
    expect(deps.markStartFailed).toHaveBeenCalledWith(
      "agt_g",
      "Gemini CLI is not logged in on the server."
    );
  });

  it("stops a Claude session that answers /login and reports through markExited", async () => {
    const { sup, deps } = await build({
      turn: async (_prompt, emit) => {
        await emit({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Please run /login to authenticate." },
        });
        return "end_turn";
      },
    });
    const markExited = vi.fn(async () => {});
    (deps as { markExited?: typeof markExited }).markExited = markExited;
    const stopSpy = vi.spyOn(HarnessDriver.prototype, "stop");
    await sup.start("agt_1");
    await sup.prompt("agt_1", "hi");
    await vi.waitFor(() => expect(markExited).toHaveBeenCalled());
    expect(stopSpy).toHaveBeenCalledWith("agt_1");
    expect(markExited).toHaveBeenCalledWith(
      "agt_1",
      "Claude Code is not logged in on the server."
    );
    stopSpy.mockRestore();
  });

  it("leaves a Claude turn alone when the phrase is prose in a working turn", async () => {
    const { sup, deps } = await build({
      turn: async (_prompt, emit) => {
        await emit({
          sessionUpdate: "tool_call",
          toolCallId: "t1",
          title: "Read docs/10-operations-runbook.md",
          kind: "read",
          status: "completed",
        });
        await emit({
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "The runbook says to please run /login as the service user.",
          },
        });
        return "end_turn";
      },
    });
    const markExited = vi.fn(async () => {});
    (deps as { markExited?: typeof markExited }).markExited = markExited;
    const stopSpy = vi.spyOn(HarnessDriver.prototype, "stop");
    await sup.start("agt_1");
    await sup.prompt("agt_1", "what does the runbook say");
    expect(markExited).not.toHaveBeenCalled();
    expect(stopSpy).not.toHaveBeenCalled();
    expect(sup.isRunning("agt_1")).toBe(true);
    stopSpy.mockRestore();
    await sup.stop("agt_1");
  });
});
