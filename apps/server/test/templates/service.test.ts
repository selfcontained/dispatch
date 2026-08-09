import { describe, expect, it, vi } from "vitest";

import type { AgentRecord } from "../../src/agents/types.js";
import { TemplateService } from "../../src/templates/service.js";
import type { TemplateRecord } from "../../src/templates/store.js";

function buildTemplate(
  overrides: Partial<TemplateRecord> = {}
): TemplateRecord {
  return {
    id: "tmpl_123",
    directory: "/tmp/repo",
    name: "Template Launch",
    description: null,
    prompt: "Review {{D:Target}}",
    agentType: "claude",
    model: null,
    useWorktree: false,
    baseBranch: null,
    branchName: null,
    fullAccess: false,
    callable: true,
    allowMedia: true,
    selfImprove: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function buildAgent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  const timestamp = new Date().toISOString();
  return {
    id: "agt_123",
    name: "template-launch",
    type: "codex",
    role: "standard",
    status: "running",
    cwd: "/tmp/repo",
    worktreePath: null,
    worktreeBranch: null,
    tmuxSession: null,
    simulatorUdid: null,
    mediaDir: null,
    agentArgs: [],
    fullAccess: false,
    setupPhase: null,
    archivePhase: null,
    archiveCleanupMode: null,
    lastError: null,
    latestEvent: null,
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
    templateId: "tmpl_123",
    autoReview: false,
    cliSessionId: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

describe("TemplateService.launchTemplate", () => {
  it("uses the requested agent type override when launching", async () => {
    const createAgent = vi.fn(async () => buildAgent());
    const service = new TemplateService(
      {} as never,
      { createAgent } as never,
      { info: vi.fn() } as never
    );

    vi.spyOn(service.store, "getTemplate").mockResolvedValue(buildTemplate());

    await service.launchTemplate({
      templateId: "tmpl_123",
      agentType: "codex",
      args: { target: "src/app.tsx" },
    });

    expect(createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "codex",
        initialPrompt: "Review src/app.tsx",
      })
    );
  });

  it("allows optional template arguments to be omitted", async () => {
    const createAgent = vi.fn(async () => buildAgent());
    const service = new TemplateService(
      {} as never,
      { createAgent } as never,
      { info: vi.fn() } as never
    );

    vi.spyOn(service.store, "getTemplate").mockResolvedValue(
      buildTemplate({
        prompt: "Review {{D:Target}} with {{D:Notes|multiline}}",
      })
    );

    await service.launchTemplate({
      templateId: "tmpl_123",
      agentType: "codex",
      args: {},
    });

    expect(createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        initialPrompt: "Review  with ",
      })
    );
  });

  it("adds runtime-only self-improvement guidance when enabled", async () => {
    const createAgent = vi.fn(async () => buildAgent());
    const service = new TemplateService(
      {} as never,
      { createAgent } as never,
      { info: vi.fn() } as never
    );
    vi.spyOn(service.store, "getTemplate").mockResolvedValue(
      buildTemplate({ selfImprove: true, prompt: "Review the change." })
    );

    await service.launchTemplate({
      templateId: "tmpl_123",
      agentType: "codex",
    });

    expect(createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        initialPrompt: expect.stringContaining(
          'update_template with templateId "tmpl_123"'
        ),
      })
    );
    expect(createAgent.mock.calls[0][0].initialPrompt).toContain(
      "Review the change."
    );
  });
});

describe("TemplateService.launchTemplate model resolution", () => {
  function setup(template: TemplateRecord) {
    const createAgent = vi.fn(async () => buildAgent());
    const service = new TemplateService(
      {} as never,
      { createAgent } as never,
      { info: vi.fn() } as never
    );
    vi.spyOn(service.store, "getTemplate").mockResolvedValue(template);
    return { createAgent, service };
  }

  it("keeps the template's saved model when no override is sent", async () => {
    const { createAgent, service } = setup(buildTemplate({ model: "sonnet" }));

    await service.launchTemplate({ templateId: "tmpl_123" });

    expect(createAgent).toHaveBeenCalledWith(
      expect.objectContaining({ model: "sonnet" })
    );
  });

  it("uses the per-launch model override", async () => {
    const { createAgent, service } = setup(buildTemplate({ model: "sonnet" }));

    await service.launchTemplate({ templateId: "tmpl_123", model: "opus" });

    expect(createAgent).toHaveBeenCalledWith(
      expect.objectContaining({ model: "opus" })
    );
  });

  it("falls back to the CLI default when the override is null", async () => {
    const { createAgent, service } = setup(buildTemplate({ model: "sonnet" }));

    await service.launchTemplate({ templateId: "tmpl_123", model: null });

    expect(createAgent).toHaveBeenCalledWith(
      expect.objectContaining({ model: undefined })
    );
  });

  it("validates the override against the launched agent type", async () => {
    const { createAgent, service } = setup(buildTemplate());

    await expect(
      service.launchTemplate({
        templateId: "tmpl_123",
        agentType: "codex",
        model: "sonnet",
      })
    ).rejects.toThrow(/not supported for codex/);
    expect(createAgent).not.toHaveBeenCalled();
  });

  it("drops the saved model when launching under a different agent type", async () => {
    const { createAgent, service } = setup(buildTemplate({ model: "sonnet" }));

    await service.launchTemplate({
      templateId: "tmpl_123",
      agentType: "codex",
    });

    expect(createAgent).toHaveBeenCalledWith(
      expect.objectContaining({ model: undefined })
    );
  });
});
