import { describe, expect, it } from "vitest";

import { createAgentRuntime } from "../src/agents/runtime.js";
import type { AppConfig } from "../src/config.js";

const noopLogger = (() => {
  const logger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    fatal: () => {},
    trace: () => {},
    silent: () => {},
    level: "silent",
    child: () => logger,
  };
  return logger as unknown as import("fastify").FastifyBaseLogger;
})();

const inertConfig: AppConfig = {
  host: "127.0.0.1",
  port: 6767,
  databaseUrl: "",
  authToken: "test-token",
  mediaRoot: "/tmp/dispatch-test-media",
  dispatchBinDir: "/usr/local/bin/dispatch",
  codexBin: "/opt/codex",
  claudeBin: "/opt/claude",
  opencodeBin: "/opt/opencode",
  agentRuntime: "inert",
  sessionPrefix: "dispatch",
  tls: null,
};

describe("InertRuntime (createAgentRuntime with agentRuntime=inert)", () => {
  // The inert runtime is what test code and headless environments get.
  // Most operations are no-ops; the few that need to return something
  // return a "soft default" that matches the historical AgentManager
  // behaviour the manager's reconciliation logic relies on.

  it("launch() resolves without doing anything", async () => {
    const runtime = createAgentRuntime(inertConfig, noopLogger);
    await expect(
      runtime.launch({
        sessionName: "dispatch_agt_x",
        cwd: "/tmp",
        agentId: "agt_x",
        payload: {
          kind: "agent-command",
          command: "echo hi",
          exitFile: "/tmp/exit",
        },
      })
    ).resolves.toBeUndefined();
  });

  it("ensureNoExistingSession() and stopSession() are no-ops", async () => {
    const runtime = createAgentRuntime(inertConfig, noopLogger);
    await expect(
      runtime.ensureNoExistingSession("dispatch_agt_x")
    ).resolves.toBeUndefined();
    await expect(
      runtime.stopSession("dispatch_agt_x", false)
    ).resolves.toBeUndefined();
    await expect(
      runtime.stopSession("dispatch_agt_x", true)
    ).resolves.toBeUndefined();
  });

  it("hasSession() returns true for any non-empty name (legacy contract)", async () => {
    // The reconciler relies on this: in inert mode every "registered"
    // agent is treated as live, so the missing-session branch in
    // reconcileAgentStatuses doesn't fire spuriously.
    const runtime = createAgentRuntime(inertConfig, noopLogger);
    expect(await runtime.hasSession("dispatch_agt_x")).toBe(true);
    expect(await runtime.hasSession("anything-non-empty")).toBe(true);
  });

  it("hasSession() returns false for empty/whitespace names", async () => {
    const runtime = createAgentRuntime(inertConfig, noopLogger);
    expect(await runtime.hasSession("")).toBe(false);
    expect(await runtime.hasSession("   ")).toBe(false);
  });

  it("getCurrentCwd() returns the supplied fallback unconditionally", async () => {
    // No process to introspect — return whatever the caller already had.
    const runtime = createAgentRuntime(inertConfig, noopLogger);
    expect(
      await runtime.getCurrentCwd({
        sessionName: "dispatch_agt_x",
        agentId: "agt_x",
        fallback: "/projects/foo",
      })
    ).toBe("/projects/foo");
  });

  it("listSessions() returns an empty array (nothing to list)", async () => {
    const runtime = createAgentRuntime(inertConfig, noopLogger);
    expect(await runtime.listSessions("dispatch_agt_")).toEqual([]);
  });

  it("killSession() resolves without doing anything", async () => {
    const runtime = createAgentRuntime(inertConfig, noopLogger);
    await expect(
      runtime.killSession("dispatch_agt_x")
    ).resolves.toBeUndefined();
  });

  it("readExitInfo() returns null (no exit-file recording in inert mode)", async () => {
    const runtime = createAgentRuntime(inertConfig, noopLogger);
    expect(await runtime.readExitInfo("dispatch_agt_x")).toBeNull();
  });

  it("readSetupLogTail() returns the empty string (no log file in inert mode)", async () => {
    const runtime = createAgentRuntime(inertConfig, noopLogger);
    expect(await runtime.readSetupLogTail("agt_x")).toBe("");
  });

  it("createAgentRuntime dispatches to inert when config.agentRuntime is 'inert'", () => {
    // Smoke check that the factory wiring is correct — we should get an
    // object whose method shapes match the AgentRuntime interface.
    const runtime = createAgentRuntime(inertConfig, noopLogger);
    expect(typeof runtime.launch).toBe("function");
    expect(typeof runtime.hasSession).toBe("function");
    expect(typeof runtime.stopSession).toBe("function");
    expect(typeof runtime.ensureNoExistingSession).toBe("function");
    expect(typeof runtime.getCurrentCwd).toBe("function");
    expect(typeof runtime.listSessions).toBe("function");
    expect(typeof runtime.killSession).toBe("function");
    expect(typeof runtime.readExitInfo).toBe("function");
    expect(typeof runtime.readSetupLogTail).toBe("function");
  });
});
