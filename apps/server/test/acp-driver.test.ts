import * as acp from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";

import {
  engineSpecFor,
  type EngineBins,
} from "../src/agents/acp/engine-spec.js";
import {
  AcpDriver,
  type DriverEvent,
  type DriverLaunch,
} from "../src/agents/acp/driver.js";
import { selfCommand } from "../src/agents/acp/runtime.js";
import { createFakeAcpAgent } from "./helpers/fake-acp-agent.js";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

/** The fake is spawned in-process, so skip the PATH lookup. */
const resolveBinary = async (bin: string) => bin;

const bins: EngineBins = {
  claudeBin: "/home/u/.local/bin/claude",
  codexBin: "/home/u/.local/bin/codex",
};

function launch(
  overrides: Partial<DriverLaunch> = {},
  engine: Parameters<typeof engineSpecFor>[0] = "claude"
): DriverLaunch {
  return {
    agentId: "agt_1",
    cwd: "/tmp/w",
    engine: engineSpecFor(engine, bins),
    systemPromptAppend: engine === "claude" ? "Be brief." : null,
    mcp: { url: "http://127.0.0.1:1/api/mcp/agt_1", token: "tok" },
    sessionId: null,
    env: { PATH: "/usr/bin", HOME: "/home/u" },
    ...overrides,
  };
}

function driverWith(fake: ReturnType<typeof createFakeAcpAgent>) {
  const spawn = vi.fn(() => fake.child);
  return { spawn, driver: new AcpDriver({ spawn, resolveBinary, logger }) };
}

describe("AcpDriver", () => {
  it.each(["claude", "codex"] as const)(
    "%s: auth failures explain CLI login during startup and turns",
    async (engine) => {
      const command = engine === "claude" ? "claude auth login" : "codex login";
      const startup = driverWith(
        createFakeAcpAgent({ sessionError: acp.RequestError.authRequired() })
      );
      await expect(startup.driver.start(launch({}, engine))).rejects.toThrow(
        command
      );
      const { driver } = driverWith(
        createFakeAcpAgent({
          turn: async () => {
            throw acp.RequestError.authRequired();
          },
        })
      );
      const events: DriverEvent[] = [];
      driver.onEvent((event) => events.push(event));
      await driver.start(launch({}, engine));
      try {
        await expect(driver.prompt("agt_1", "hello")).rejects.toThrow(command);
        expect(events.at(-1)).toMatchObject({
          type: "turn",
          state: "settled",
          errorKind: "authentication_required",
          error: expect.stringContaining(
            "same OS account as the Dispatch server"
          ),
        });
      } finally {
        await driver.stop("agt_1");
      }
    }
  );

  it.each(["claude", "codex"] as const)(
    "%s: restricted mode is applied on resume and requests wait for a matching user choice",
    async (engine) => {
      let result: acp.RequestPermissionResponse | undefined;
      const fake = createFakeAcpAgent({
        turn: async (_text, _emit, ask) => {
          result = await ask({
            options: [
              { optionId: "deny", name: "Deny", kind: "reject_once" },
              { optionId: "allow", name: "Allow", kind: "allow_once" },
            ],
          });
          return "end_turn";
        },
      });
      const { driver } = driverWith(fake);
      await driver.start(
        launch(
          { sessionId: "existing", engine: engineSpecFor(engine, bins, false) },
          engine
        )
      );
      try {
        expect(fake.seen.setMode).toEqual([
          {
            sessionId: "existing",
            modeId: engine === "claude" ? "default" : "read-only",
          },
        ]);
        if (engine === "claude")
          expect(fake.seen.resumeSession[0]?._meta).toMatchObject({
            claudeCode: { options: { allowDangerouslySkipPermissions: false } },
          });
        const turn = driver.prompt("agt_1", "test");
        await vi.waitFor(() =>
          expect(driver.getPermissions("agt_1")).toHaveLength(1)
        );
        expect(result).toBeUndefined();
        const request = driver.getPermissions("agt_1")[0]!;
        expect(() =>
          driver.answerPermission("another-agent", request.id, "allow")
        ).toThrow(/no longer pending/);
        expect(() =>
          driver.answerPermission("agt_1", request.id, "unknown")
        ).toThrow(/did not offer/);
        driver.answerPermission("agt_1", request.id, "deny");
        await turn;
        expect(result).toEqual({
          outcome: { outcome: "selected", optionId: "deny" },
        });
        expect(driver.getPermissions("agt_1")).toEqual([]);
      } finally {
        await driver.stop("agt_1");
      }
    }
  );

  it("cancels pending permission requests when a turn is interrupted", async () => {
    let result: acp.RequestPermissionResponse | undefined;
    const fake = createFakeAcpAgent({
      turn: async (_text, _emit, ask) => {
        result = await ask({
          options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
        });
        return "cancelled";
      },
    });
    const { driver } = driverWith(fake);
    await driver.start(
      launch({ engine: engineSpecFor("claude", bins, false) })
    );
    try {
      const turn = driver.prompt("agt_1", "test");
      await vi.waitFor(() =>
        expect(driver.getPermissions("agt_1")).toHaveLength(1)
      );
      await driver.cancel("agt_1");
      await turn;
      expect(result).toEqual({ outcome: { outcome: "cancelled" } });
      expect(driver.getPermissions("agt_1")).toEqual([]);
    } finally {
      await driver.stop("agt_1");
    }
  });
  it.each([null, "existing-session"])(
    "preserves first-turn slash commands and defers guidance after launch/resume (%s)",
    async (sessionId) => {
      // No advertised commands: dispatch must also work before the adapter's
      // asynchronous command list arrives, and for adapter-specific commands.
      const fake = createFakeAcpAgent();
      const { driver } = driverWith(fake);
      const guidance = "Call rename_session once the topic is clear.";
      await driver.start(
        launch({ sessionId, firstPromptAppend: guidance }, "codex")
      );
      try {
        const commands = ["/review changes", " /compact ", "/plan", "/status"];
        for (const command of commands) await driver.prompt("agt_1", command);
        expect(fake.seen.prompts).toEqual(commands);
        await driver.prompt("agt_1", "Fix naming");
        await driver.prompt("agt_1", "Continue");
        expect(fake.seen.prompts.slice(commands.length)).toEqual([
          `${guidance}Fix naming`,
          "Continue",
        ]);
      } finally {
        await driver.stop("agt_1");
      }
    }
  );

  it.each([null, "existing-session"])(
    "delivers Codex guidance once with real work after launch/resume (%s)",
    async (sessionId) => {
      const fake = createFakeAcpAgent();
      const { driver } = driverWith(fake);
      const events: DriverEvent[] = [];
      driver.onEvent((event) => events.push(event));
      await driver.start(
        launch(
          {
            sessionId,
            firstPromptAppend: "Call rename_session once the topic is clear.",
          },
          "codex"
        )
      );
      expect(fake.seen.prompts).toEqual([]);
      await driver.prompt("agt_1", "Fix naming");
      await driver.prompt("agt_1", "Continue");
      expect(fake.seen.prompts[0]).toContain("rename_session");
      expect(fake.seen.prompts[0]).toContain("Fix naming");
      expect(fake.seen.prompts[1]).toBe("Continue");
      expect(
        events
          .filter((event) => event.type === "turn" && event.state === "started")
          .map((event) => ("text" in event ? event.text : null))
      ).toEqual(["Fix naming", "Continue"]);
      await driver.stop("agt_1");
    }
  );

  it("claude: spawns the adapter with its args and env, declares subagent transcripts, sends the persona in _meta", async () => {
    const fake = createFakeAcpAgent();
    const { spawn, driver } = driverWith(fake);
    const { sessionId } = await driver.start(launch());
    expect(sessionId).toBe("sess_1");
    // The adapter is a mode of this executable, not something on PATH.
    expect(spawn).toHaveBeenCalledWith(
      selfCommand("claude-acp")[0],
      [...selfCommand("claude-acp").slice(1), "--dangerously-skip-permissions"],
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
    await driver.start(launch({}, "codex"));
    expect(spawn).toHaveBeenCalledWith(
      selfCommand("codex-acp")[0],
      selfCommand("codex-acp").slice(1),
      expect.objectContaining({
        env: expect.objectContaining({
          INITIAL_AGENT_MODE: "agent-full-access",
          NO_BROWSER: "1",
          CODEX_PATH: "/home/u/.local/bin/codex",
        }),
      })
    );
    expect(fake.seen.initialize[0].clientCapabilities?._meta).toBeUndefined();
    expect(fake.seen.newSession[0]._meta).toBeUndefined();
    await driver.stop("agt_1");
  });

  it("keeps the commands the engine advertises", async () => {
    const fake = createFakeAcpAgent({
      commands: [
        { name: "review", description: "Review the branch", input: null },
        { name: "compact", description: "Compact", input: { hint: "focus" } },
      ],
    });
    const { driver } = driverWith(fake);
    await driver.start(launch({}, "codex"));
    await new Promise((r) => setTimeout(r, 10));
    expect(driver.getCommands("agt_1")?.map((c) => c.name)).toEqual([
      "review",
      "compact",
    ]);
    expect(driver.getCommands("agt_nope")).toBeNull();
    await driver.stop("agt_1");
  });

  it("reports the engine's config options when the session opens and when they change", async () => {
    const fake = createFakeAcpAgent({
      configOptions: [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "opus",
          options: [
            { value: "opus", name: "Opus" },
            { value: "sonnet", name: "Sonnet" },
          ],
        },
      ],
    });
    const { driver } = driverWith(fake);
    const events: DriverEvent[] = [];
    driver.onEvent((e) => events.push(e));
    await driver.start(launch());
    const configs = () =>
      events.filter(
        (e): e is Extract<DriverEvent, { type: "config" }> =>
          e.type === "config"
      );
    expect(configs()).toHaveLength(1);
    expect(configs()[0]?.options[0]).toMatchObject({
      id: "model",
      currentValue: "opus",
    });
    await driver.setConfigOption("agt_1", "model", "sonnet");
    expect(configs()).toHaveLength(2);
    expect(configs()[1]?.options[0]).toMatchObject({ currentValue: "sonnet" });
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
    const driver = new AcpDriver({
      spawn: () => fake.child,
      resolveBinary,
      logger,
    });
    const events: DriverEvent[] = [];
    driver.onEvent((e) => events.push(e));
    await driver.start(launch());
    await driver.prompt("agt_1", "hello");
    expect(fake.seen.prompts).toEqual(["hello"]);
    expect(events.map((e) => e.type)).toEqual([
      "config",
      "turn",
      "update",
      "turn",
    ]);
    expect(events[3]).toMatchObject({
      type: "turn",
      state: "settled",
      stopReason: "end_turn",
    });
    await driver.stop("agt_1");
  });

  it("stop closes the session and reaps the child", async () => {
    const fake = createFakeAcpAgent();
    const driver = new AcpDriver({
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
    const driver = new AcpDriver({
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
    const driver = new AcpDriver({
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

  it("a turn the adapter failed with an errorKind carries it apart from the message", async () => {
    const fake = createFakeAcpAgent({
      turn: async () => {
        throw acp.RequestError.internalError(
          { errorKind: "server_error" },
          "API Error: 500 Internal server error."
        );
      },
    });
    const driver = new AcpDriver({
      spawn: () => fake.child,
      resolveBinary,
      logger,
    });
    const events: DriverEvent[] = [];
    driver.onEvent((e) => events.push(e));
    await driver.start(launch());
    await expect(driver.prompt("agt_1", "x")).rejects.toThrow(/API Error: 500/);
    expect(events.at(-1)).toEqual({
      type: "turn",
      agentId: "agt_1",
      state: "settled",
      error: "API Error: 500 Internal server error.",
      errorKind: "server_error",
    });
    await driver.stop("agt_1");
  });

  it("prompting an agent that is not running throws", async () => {
    const driver = new AcpDriver({
      spawn: () => createFakeAcpAgent().child,
      resolveBinary,
      logger,
    });
    await expect(driver.prompt("agt_nope", "x")).rejects.toThrow(/not running/);
  });

  it("fails the start, not the process, when the binary cannot be spawned", async () => {
    const driver = new AcpDriver({ resolveBinary, logger });
    await expect(
      driver.start(
        launch({
          engine: {
            ...engineSpecFor("claude", bins),
            bin: "definitely-not-a-real-binary-xyz",
          },
        })
      )
    ).rejects.toThrow(
      /Agent connection failed: the agent could not be spawned/
    );
    expect(driver.isRunning("agt_1")).toBe(false);
  });

  it("names the missing binary before spawning", async () => {
    const driver = new AcpDriver({ logger });
    await expect(
      driver.start(
        launch({
          engine: {
            ...engineSpecFor("claude", bins),
            bin: "definitely-not-a-real-binary-xyz",
          },
        })
      )
    ).rejects.toThrow(/was not found on the server's PATH/);
  });

  it("falls back to a new session when the stored one cannot be resumed", async () => {
    const fake = createFakeAcpAgent({ resumeFails: true });
    const driver = new AcpDriver({
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
    const driver = new AcpDriver({
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
    const driver = new AcpDriver({
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

describe("ACP steering", () => {
  it("journals accepted input before a racing turn settlement, without cancellation", async () => {
    let endTurn!: () => void;
    let acceptSteer!: () => void;
    const turnGate = new Promise<void>((r) => {
      endTurn = r;
    });
    const steerGate = new Promise<void>((r) => {
      acceptSteer = r;
    });
    const fake = createFakeAcpAgent({
      turn: async () => {
        await turnGate;
        return "end_turn";
      },
      steer: async () => {
        await steerGate;
        return { outcome: "injected" };
      },
    });
    const { driver } = driverWith(fake);
    const events: DriverEvent[] = [];
    driver.onEvent((event) => events.push(event));
    await driver.start(launch());
    try {
      expect(driver.supportsSteering("agt_1")).toBe(true);
      const turn = driver.prompt("agt_1", "work");
      await vi.waitFor(() => expect(fake.seen.prompts).toHaveLength(1));
      const source = {
        source: "chat" as const,
        chatMessageId: "message-2",
        answerIn: "finding-1",
      };
      const steering = driver.steer("agt_1", "correction", source);
      await vi.waitFor(() => expect(fake.seen.steers).toHaveLength(1));
      expect(fake.seen.steers[0]).toMatchObject({
        _meta: { steering: { idleBehavior: "promptRequired" } },
      });
      endTurn();
      await new Promise((r) => setTimeout(r, 10));
      expect(
        events.some((e) => e.type === "turn" && e.state === "settled")
      ).toBe(false);
      acceptSteer();
      expect(await steering).toBe("injected");
      await turn;
      expect(
        events.filter((e) => e.type === "turn" || e.type === "steered")
      ).toEqual([
        expect.objectContaining({ type: "turn", state: "started" }),
        { type: "steered", agentId: "agt_1", text: "correction", source },
        expect.objectContaining({
          type: "turn",
          state: "settled",
          stopReason: "end_turn",
        }),
      ]);
      expect(fake.seen.cancels).toBe(0);
      expect(await driver.steer("agt_1", "too late")).toBe("promptRequired");
      expect(fake.seen.steers).toHaveLength(1);
    } finally {
      endTurn();
      acceptSteer();
      await driver.stop("agt_1");
    }
  });

  it("preserves an outstanding permission request when guidance arrives", async () => {
    const fake = createFakeAcpAgent({
      steer: async () => ({ outcome: "injected" }),
      turn: async (_text, _emit, ask) => {
        await ask({
          options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
        });
        return "end_turn";
      },
    });
    const { driver } = driverWith(fake);
    await driver.start(
      launch({ engine: engineSpecFor("claude", bins, false) })
    );
    try {
      const turn = driver.prompt("agt_1", "work");
      await vi.waitFor(() =>
        expect(driver.getPermissions("agt_1")).toHaveLength(1)
      );
      const permission = driver.getPermissions("agt_1")[0]!;
      await driver.steer("agt_1", "use the smaller change");
      expect(driver.getPermissions("agt_1")[0]!.id).toBe(permission.id);
      expect(fake.seen.cancels).toBe(0);
      driver.answerPermission("agt_1", permission.id, "allow");
      await turn;
    } finally {
      await driver.stop("agt_1");
    }
  });
});
