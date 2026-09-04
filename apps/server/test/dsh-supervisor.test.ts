import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DshDriver } from "../src/agents/dsh/driver.js";
import { DshSupervisor } from "../src/agents/dsh/supervisor.js";
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

async function build(opts: { turn?: FakeTurn; cliSessionId?: string } = {}) {
  home = await mkdtemp(path.join(os.tmpdir(), "dsh-sup-"));
  const fake = createFakeAcpAgent({ turn: opts.turn });
  const driver = new DshDriver({
    dshBin: "dsh",
    dshHome: home,
    spawn: () => fake.child,
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
    },
    logger,
    driver,
    getAgent: vi.fn(async (id: string) => ({
      id,
      type: "dsh",
      cwd: "/tmp/w",
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
});
