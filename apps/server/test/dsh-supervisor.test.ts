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
  const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
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
});
