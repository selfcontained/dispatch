import { describe, expect, it, vi } from "vitest";

import {
  createAutoRenamePrompter,
  RENAME_PROMPT,
} from "../src/agents/auto-rename-prompter.js";
import type { AgentRecord } from "../src/agents/types.js";

const fakeLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  trace: vi.fn(),
  child: () => fakeLogger,
  level: "info",
  silent: vi.fn(),
} as unknown as import("fastify").FastifyBaseLogger;

function makeAgent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  const id = overrides.id ?? "agt_aabbccddeeff";
  return {
    id,
    name: `agent-${id.slice(-6)}`,
    type: "claude",
    role: "primary",
    status: "running",
    cwd: "/tmp/repo",
    worktreePath: null,
    worktreeBranch: null,
    tmuxSession: null,
    simulatorUdid: null,
    mediaDir: null,
    agentArgs: [],
    fullAccess: false,
    setupPhase: "done",
    archivePhase: "none",
    archiveCleanupMode: null,
    lastError: null,
    latestEvent: {
      type: "working",
      message: "doing work",
      updatedAt: new Date().toISOString(),
    },
    pins: [],
    gitContext: null,
    gitContextStale: false,
    gitContextUpdatedAt: null,
    persona: null,
    parentAgentId: null,
    personaContext: null,
    reviewAgentType: null,
    review: null,
    baseBranch: null,
    templateId: null,
    autoReview: false,
    cliSessionId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as AgentRecord;
}

describe("createAutoRenamePrompter", () => {
  it("injects the rename prompt on first working event with default name", async () => {
    const inject = vi.fn().mockResolvedValue(undefined);
    const handler = createAutoRenamePrompter({
      injectAgentPrompt: inject,
      log: fakeLogger,
    });

    handler(makeAgent());

    await vi.waitFor(() => expect(inject).toHaveBeenCalledOnce());
    expect(inject).toHaveBeenCalledWith("agt_aabbccddeeff", RENAME_PROMPT);
  });

  it("does not inject when event type is not working", () => {
    const inject = vi.fn().mockResolvedValue(undefined);
    const handler = createAutoRenamePrompter({
      injectAgentPrompt: inject,
      log: fakeLogger,
    });

    handler(
      makeAgent({
        latestEvent: {
          type: "idle",
          message: "idle",
          updatedAt: new Date().toISOString(),
        },
      })
    );

    expect(inject).not.toHaveBeenCalled();
  });

  it("does not inject for terminal-type agents", () => {
    const inject = vi.fn().mockResolvedValue(undefined);
    const handler = createAutoRenamePrompter({
      injectAgentPrompt: inject,
      log: fakeLogger,
    });

    handler(makeAgent({ type: "terminal" }));

    expect(inject).not.toHaveBeenCalled();
  });

  it("does not inject for persona agents", () => {
    const inject = vi.fn().mockResolvedValue(undefined);
    const handler = createAutoRenamePrompter({
      injectAgentPrompt: inject,
      log: fakeLogger,
    });

    handler(makeAgent({ persona: "security-review" }));

    expect(inject).not.toHaveBeenCalled();
  });

  it("does not inject when agent already has a custom name", () => {
    const inject = vi.fn().mockResolvedValue(undefined);
    const handler = createAutoRenamePrompter({
      injectAgentPrompt: inject,
      log: fakeLogger,
    });

    handler(makeAgent({ name: "my-custom-agent" }));

    expect(inject).not.toHaveBeenCalled();
  });

  it("only injects once per agent (one-shot)", async () => {
    const inject = vi.fn().mockResolvedValue(undefined);
    const handler = createAutoRenamePrompter({
      injectAgentPrompt: inject,
      log: fakeLogger,
    });

    const agent = makeAgent();
    handler(agent);
    handler(agent);
    handler(agent);

    await vi.waitFor(() => expect(inject).toHaveBeenCalledOnce());
  });

  it("does not inject for a template-launched agent carrying the template name", () => {
    const inject = vi.fn().mockResolvedValue(undefined);
    const handler = createAutoRenamePrompter({
      injectAgentPrompt: inject,
      log: fakeLogger,
    });

    handler(makeAgent({ name: "Idea Inbox", templateId: "tmpl_123" }));

    expect(inject).not.toHaveBeenCalled();
  });

  // The repeat-forever case: a long-lived templated agent used to be re-nagged
  // on its next working event after every server restart (fresh process, empty
  // dedupe set). The name check has to hold on its own, with no prior state.
  it("does not inject for a named templated agent even on a fresh process", () => {
    const inject = vi.fn().mockResolvedValue(undefined);
    const agent = makeAgent({ name: "Idea Inbox", templateId: "tmpl_123" });

    for (let restart = 0; restart < 3; restart++) {
      createAutoRenamePrompter({ injectAgentPrompt: inject, log: fakeLogger })(
        agent
      );
    }

    expect(inject).not.toHaveBeenCalled();
  });

  it("still injects for a template launch left on the placeholder name", async () => {
    const inject = vi.fn().mockResolvedValue(undefined);
    const handler = createAutoRenamePrompter({
      injectAgentPrompt: inject,
      log: fakeLogger,
    });

    handler(makeAgent({ templateId: "tmpl_123" }));

    await vi.waitFor(() => expect(inject).toHaveBeenCalledOnce());
  });

  it("logs warning when injection fails", async () => {
    const warnSpy = vi.fn();
    const failLogger = {
      ...fakeLogger,
      warn: warnSpy,
    } as unknown as import("fastify").FastifyBaseLogger;
    const inject = vi.fn().mockRejectedValue(new Error("tmux down"));
    const handler = createAutoRenamePrompter({
      injectAgentPrompt: inject,
      log: failLogger,
    });

    handler(makeAgent());

    await vi.waitFor(() => expect(warnSpy).toHaveBeenCalled());
    expect(warnSpy.mock.calls[0][1]).toContain(
      "Auto rename-prompt injection failed"
    );
  });
});
