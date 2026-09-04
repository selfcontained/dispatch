import { describe, expect, it, vi } from "vitest";

import { DshDriver, type DriverEvent } from "../src/agents/dsh/driver.js";
import { createFakeAcpAgent } from "./helpers/fake-acp-agent.js";

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

function launch(agentId = "agt_1") {
  return {
    agentId,
    cwd: "/tmp/w",
    overlayPath: "/tmp/w/agt_1.patch.yml",
    mcp: { url: "http://127.0.0.1:1/api/mcp/agt_1", token: "tok" },
    sessionId: null,
    env: { PATH: "/usr/bin" },
  };
}

describe("DshDriver", () => {
  it("spawns dsh with the acp profile, overlay, cwd, env, and attaches the MCP server", async () => {
    const fake = createFakeAcpAgent();
    const spawn = vi.fn(() => fake.child);
    const driver = new DshDriver({
      dshBin: "/bin/dsh",
      dshHome: "/home/dsh",
      spawn,
      logger,
    });
    const { sessionId } = await driver.start(launch());
    expect(sessionId).toBe("sess_1");
    expect(spawn).toHaveBeenCalledWith(
      "/bin/dsh",
      ["--profile", "acp", "--patch", "/tmp/w/agt_1.patch.yml"],
      expect.objectContaining({
        cwd: "/tmp/w",
        env: expect.objectContaining({
          DSH_HOME: "/home/dsh",
          DSH_PERMISSION_MODE: "danger-full-access",
          PATH: "/usr/bin",
        }),
      })
    );
    const req = fake.seen.newSession[0];
    expect(req.cwd).toBe("/tmp/w");
    expect(req.mcpServers).toEqual([
      {
        type: "http",
        name: "dispatch",
        url: "http://127.0.0.1:1/api/mcp/agt_1",
        headers: [{ name: "Authorization", value: "Bearer tok" }],
      },
    ]);
    expect(driver.isRunning("agt_1")).toBe(true);
    await driver.stop("agt_1");
  });

  it("forwards updates and turn boundaries while a prompt runs", async () => {
    const fake = createFakeAcpAgent({
      turn: async (_p, emit) => {
        await emit({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "hi" },
        });
        return "end_turn";
      },
    });
    const driver = new DshDriver({
      dshBin: "dsh",
      dshHome: "/h",
      spawn: () => fake.child,
      logger,
    });
    const events: DriverEvent[] = [];
    driver.onEvent((e) => events.push(e));
    await driver.start(launch());
    await driver.prompt("agt_1", "hello");
    expect(fake.seen.prompts).toEqual(["hello"]);
    expect(events.map((e) => e.type)).toEqual(["turn", "update", "turn"]);
    expect(events[2]).toMatchObject({
      type: "turn",
      state: "settled",
      stopReason: "end_turn",
    });
    await driver.stop("agt_1");
  });

  it("resumes when a session id is given", async () => {
    const fake = createFakeAcpAgent();
    const driver = new DshDriver({
      dshBin: "dsh",
      dshHome: "/h",
      spawn: () => fake.child,
      logger,
    });
    const { sessionId } = await driver.start({
      ...launch(),
      sessionId: "sess_prev",
    });
    expect(sessionId).toBe("sess_prev");
    expect(fake.seen.newSession).toHaveLength(0);
    expect(fake.seen.resumeSession[0]).toMatchObject({
      sessionId: "sess_prev",
      cwd: "/tmp/w",
    });
    await driver.stop("agt_1");
  });

  it("stop closes the session and reaps the child", async () => {
    const fake = createFakeAcpAgent();
    const driver = new DshDriver({
      dshBin: "dsh",
      dshHome: "/h",
      spawn: () => fake.child,
      logger,
    });
    const events: DriverEvent[] = [];
    driver.onEvent((e) => events.push(e));
    await driver.start(launch());
    await driver.stop("agt_1");
    expect(fake.seen.closes).toBe(1);
    expect(driver.isRunning("agt_1")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "exit", agentId: "agt_1" });
  });

  it("refuses to start twice for one agent", async () => {
    const fake = createFakeAcpAgent();
    const driver = new DshDriver({
      dshBin: "dsh",
      dshHome: "/h",
      spawn: () => fake.child,
      logger,
    });
    await driver.start(launch());
    await expect(driver.start(launch())).rejects.toThrow(/already running/);
    await driver.stop("agt_1");
  });

  it("a prompt rejected by the agent settles the turn with an error", async () => {
    const fake = createFakeAcpAgent({
      turn: async () => {
        throw new Error("no API key");
      },
    });
    const driver = new DshDriver({
      dshBin: "dsh",
      dshHome: "/h",
      spawn: () => fake.child,
      logger,
    });
    const events: DriverEvent[] = [];
    driver.onEvent((e) => events.push(e));
    await driver.start(launch());
    await expect(driver.prompt("agt_1", "x")).rejects.toThrow(/no API key/);
    expect(events.at(-1)).toMatchObject({
      type: "turn",
      state: "settled",
      error: expect.stringContaining("no API key"),
    });
    await driver.stop("agt_1");
  });

  it("prompting an agent that is not running throws", async () => {
    const driver = new DshDriver({
      dshBin: "dsh",
      dshHome: "/h",
      spawn: () => createFakeAcpAgent().child,
      logger,
    });
    await expect(driver.prompt("agt_nope", "x")).rejects.toThrow(/not running/);
  });
});
