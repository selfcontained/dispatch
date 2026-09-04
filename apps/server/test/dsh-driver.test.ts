import { describe, expect, it, vi } from "vitest";

import { DshDriver, type DriverEvent } from "../src/agents/dsh/driver.js";
import { createFakeAcpAgent } from "./helpers/fake-acp-agent.js";

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

/** The fake is spawned in-process, so skip the PATH lookup. */
const resolveBinary = async (bin: string) => bin;

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
      resolveBinary,
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
      resolveBinary,
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
      resolveBinary,
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
      resolveBinary,
      logger,
    });
    const events: DriverEvent[] = [];
    driver.onEvent((e) => events.push(e));
    await driver.start(launch());
    await driver.stop("agt_1");
    expect(fake.seen.closes).toBe(1);
    expect(driver.isRunning("agt_1")).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: "exit",
      agentId: "agt_1",
      expected: true,
    });
  });

  it("refuses to start twice for one agent", async () => {
    const fake = createFakeAcpAgent();
    const driver = new DshDriver({
      dshBin: "dsh",
      dshHome: "/h",
      spawn: () => fake.child,
      resolveBinary,
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
      resolveBinary,
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
      resolveBinary,
      logger,
    });
    await expect(driver.prompt("agt_nope", "x")).rejects.toThrow(/not running/);
  });

  it("fails the start, not the process, when the binary cannot be spawned", async () => {
    const driver = new DshDriver({
      dshBin: "definitely-not-a-real-binary-dsh",
      dshHome: "/h",
      resolveBinary,
      logger,
    });
    await expect(driver.start(launch())).rejects.toThrow(
      /dsh start failed: dsh could not be spawned/
    );
    expect(driver.isRunning("agt_1")).toBe(false);
  });

  it("names the missing binary before spawning", async () => {
    const driver = new DshDriver({
      dshBin: "definitely-not-a-real-binary-dsh",
      dshHome: "/h",
      logger,
    });
    await expect(driver.start(launch())).rejects.toThrow(
      /dsh not found on the server's PATH/
    );
  });

  it("falls back to a new session when the stored one cannot be resumed", async () => {
    const fake = createFakeAcpAgent({ resumeFails: true });
    const driver = new DshDriver({
      dshBin: "dsh",
      dshHome: "/h",
      spawn: () => fake.child,
      resolveBinary,
      logger,
    });
    const result = await driver.start({ ...launch(), sessionId: "sess_gone" });
    expect(result).toEqual({ sessionId: "sess_1", resumed: false });
    expect(fake.seen.resumeSession).toHaveLength(1);
    expect(fake.seen.newSession).toHaveLength(1);
    await driver.stop("agt_1");
  });

  it("reports an unexpected child death as a crash", async () => {
    const fake = createFakeAcpAgent();
    const driver = new DshDriver({
      dshBin: "dsh",
      dshHome: "/h",
      spawn: () => fake.child,
      resolveBinary,
      logger,
    });
    const events: DriverEvent[] = [];
    driver.onEvent((e) => events.push(e));
    await driver.start(launch());
    fake.child.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 0));
    expect(events.at(-1)).toMatchObject({ type: "exit", expected: false });
    expect(driver.isRunning("agt_1")).toBe(false);
  });

  it("cancels a permission request that offers no allow option", async () => {
    const fake = createFakeAcpAgent({
      turn: async (_p, _emit, ask) => {
        const answer = await ask({
          options: [{ optionId: "no", name: "Reject", kind: "reject_once" }],
        });
        return answer.outcome.outcome === "cancelled"
          ? "cancelled"
          : "end_turn";
      },
    });
    const driver = new DshDriver({
      dshBin: "dsh",
      dshHome: "/h",
      spawn: () => fake.child,
      resolveBinary,
      logger,
    });
    const events: DriverEvent[] = [];
    driver.onEvent((e) => events.push(e));
    await driver.start(launch());
    await driver.prompt("agt_1", "x");
    expect(events.at(-1)).toMatchObject({
      state: "settled",
      stopReason: "cancelled",
    });
    await driver.stop("agt_1");
  });
});
