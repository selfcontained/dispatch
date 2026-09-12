import { describe, expect, it, vi } from "vitest";

import {
  engineSpecFor,
  type EngineBins,
} from "../src/agents/harness/agent-spec.js";
import {
  HarnessDriver,
  type DriverEvent,
  type DriverLaunch,
} from "../src/agents/harness/driver.js";
import { createFakeAcpAgent } from "./helpers/fake-acp-agent.js";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

/** The fake is spawned in-process, so skip the PATH lookup. */
const resolveBinary = async (bin: string) => bin;

const bins: EngineBins = {
  claudeHarnessBin: "/bin/claude-agent-acp",
  codexHarnessBin: "/bin/codex-acp",
  geminiBin: "/bin/gemini",
  opencodeBin: "/bin/opencode",
  claudeBin: "/home/u/.local/bin/claude",
  codexBin: null,
};

function launch(
  overrides: Partial<DriverLaunch> = {},
  engine: Parameters<typeof engineSpecFor>[0] = "claude",
  model = "default"
): DriverLaunch {
  return {
    agentId: "agt_1",
    cwd: "/tmp/w",
    engine: engineSpecFor(engine, model, bins),
    systemPromptAppend: engine === "claude" ? "Be brief." : null,
    mcp: { url: "http://127.0.0.1:1/api/mcp/agt_1", token: "tok" },
    sessionId: null,
    env: { PATH: "/usr/bin", HOME: "/home/u" },
    ...overrides,
  };
}

function driverWith(fake: ReturnType<typeof createFakeAcpAgent>) {
  const spawn = vi.fn(() => fake.child);
  return { spawn, driver: new HarnessDriver({ spawn, resolveBinary, logger }) };
}

describe("HarnessDriver", () => {
  it("claude: spawns the adapter with its args and env, declares subagent transcripts, sends the persona in _meta", async () => {
    const fake = createFakeAcpAgent();
    const { spawn, driver } = driverWith(fake);
    const { sessionId } = await driver.start(launch());
    expect(sessionId).toBe("sess_1");
    expect(spawn).toHaveBeenCalledWith(
      "/bin/claude-agent-acp",
      ["--dangerously-skip-permissions"],
      expect.objectContaining({
        cwd: "/tmp/w",
        env: expect.objectContaining({
          CLAUDE_CODE_EXECUTABLE: "/home/u/.local/bin/claude",
          HOME: "/home/u",
          PATH: "/usr/bin",
        }),
      })
    );
    expect(fake.seen.initialize[0].clientCapabilities?._meta).toEqual({
      "subagent-transcript": true,
    });
    const req = fake.seen.newSession[0];
    expect(req.cwd).toBe("/tmp/w");
    expect(req._meta).toEqual({ systemPrompt: { append: "Be brief." } });
    expect(req.mcpServers).toEqual([
      {
        type: "http",
        name: "dispatch",
        url: "http://127.0.0.1:1/api/mcp/agt_1",
        headers: [{ name: "Authorization", value: "Bearer tok" }],
      },
    ]);
    expect(fake.seen.setMode).toEqual([]);
    await driver.stop("agt_1");
  });

  it("codex: no _meta persona, no subagent capability, full access by env", async () => {
    const fake = createFakeAcpAgent();
    const { spawn, driver } = driverWith(fake);
    await driver.start(launch({}, "codex", "gpt-5.6-sol"));
    expect(spawn).toHaveBeenCalledWith(
      "/bin/codex-acp",
      [],
      expect.objectContaining({
        env: expect.objectContaining({
          INITIAL_AGENT_MODE: "agent-full-access",
          NO_BROWSER: "1",
        }),
      })
    );
    expect(fake.seen.initialize[0].clientCapabilities?._meta).toBeUndefined();
    expect(fake.seen.newSession[0]._meta).toBeUndefined();
    await driver.stop("agt_1");
  });

  it("gemini: sets the yolo mode right after the session opens, on new and on resume", async () => {
    const fake = createFakeAcpAgent();
    const { spawn, driver } = driverWith(fake);
    await driver.start(launch({}, "gemini", "gemini-2.5-pro"));
    expect(spawn.mock.calls[0][1]).toEqual([
      "--experimental-acp",
      "--model",
      "gemini-2.5-pro",
    ]);
    expect(fake.seen.setMode).toEqual([
      { sessionId: "sess_1", modeId: "yolo" },
    ]);
    await driver.stop("agt_1");
    const again = createFakeAcpAgent();
    const second = driverWith(again).driver;
    await second.start(launch({ sessionId: "sess_1" }, "gemini"));
    expect(again.seen.resumeSession).toHaveLength(1);
    expect(again.seen.setMode).toEqual([
      { sessionId: "sess_1", modeId: "yolo" },
    ]);
    await second.stop("agt_1");
  });

  it("keeps the commands the engine advertises", async () => {
    const fake = createFakeAcpAgent({
      commands: [
        { name: "review", description: "Review the branch", input: null },
        { name: "compact", description: "Compact", input: { hint: "focus" } },
      ],
    });
    const { driver } = driverWith(fake);
    await driver.start(launch({}, "opencode"));
    await new Promise((r) => setTimeout(r, 10));
    expect(driver.getCommands("agt_1")?.map((c) => c.name)).toEqual([
      "review",
      "compact",
    ]);
    expect(driver.getCommands("agt_nope")).toBeNull();
    await driver.stop("agt_1");
  });

  it("resumes over session/resume and sends the persona again for claude", async () => {
    const fake = createFakeAcpAgent();
    const { driver } = driverWith(fake);
    const { sessionId, resumed } = await driver.start(
      launch({ sessionId: "sess_prev" })
    );
    expect({ sessionId, resumed }).toEqual({
      sessionId: "sess_prev",
      resumed: true,
    });
    expect(fake.seen.newSession).toHaveLength(0);
    expect(fake.seen.resumeSession[0]).toMatchObject({
      sessionId: "sess_prev",
      cwd: "/tmp/w",
      _meta: { systemPrompt: { append: "Be brief." } },
    });
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
    const driver = new HarnessDriver({
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

  it("stop closes the session and reaps the child", async () => {
    const fake = createFakeAcpAgent();
    const driver = new HarnessDriver({
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
    const driver = new HarnessDriver({
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
    const driver = new HarnessDriver({
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
    const driver = new HarnessDriver({
      spawn: () => createFakeAcpAgent().child,
      resolveBinary,
      logger,
    });
    await expect(driver.prompt("agt_nope", "x")).rejects.toThrow(/not running/);
  });

  it("fails the start, not the process, when the binary cannot be spawned", async () => {
    const driver = new HarnessDriver({ resolveBinary, logger });
    await expect(
      driver.start(
        launch({
          engine: {
            ...engineSpecFor("claude", "default", bins),
            bin: "definitely-not-a-real-binary-xyz",
          },
        })
      )
    ).rejects.toThrow(/harness start failed: the harness could not be spawned/);
    expect(driver.isRunning("agt_1")).toBe(false);
  });

  it("names the missing binary before spawning", async () => {
    const driver = new HarnessDriver({ logger });
    await expect(
      driver.start(
        launch({
          engine: {
            ...engineSpecFor("claude", "default", bins),
            bin: "definitely-not-a-real-binary-xyz",
          },
        })
      )
    ).rejects.toThrow(/was not found on the server's PATH/);
  });

  it("falls back to a new session when the stored one cannot be resumed", async () => {
    const fake = createFakeAcpAgent({ resumeFails: true });
    const driver = new HarnessDriver({
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
    const driver = new HarnessDriver({
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
    const driver = new HarnessDriver({
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
