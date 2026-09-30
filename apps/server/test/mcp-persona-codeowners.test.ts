import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPersonaHandlers } from "../src/server/mcp-persona-handlers.js";
import { loadCodeowners } from "../src/personas/codeowners.js";
import {
  loadPersonaBySlug,
  assemblePersonaPrompt,
} from "../src/personas/loader.js";
import {
  refreshRemoteBaseRef,
  resolveBaseRef,
} from "../src/shared/git/base-ref.js";
import { runCommand } from "../src/shared/lib/run-command.js";

vi.mock("../src/shared/git/git-context.js", () => ({
  resolveRepoRoot: vi.fn(async (cwd: string) => cwd),
  resolveWorktreeRoot: vi.fn(async (cwd: string) => cwd),
}));
vi.mock("../src/shared/git/base-ref.js", () => ({
  refreshRemoteBaseRef: vi.fn(async () => {}),
  resolveBaseRef: vi.fn(async () => "origin/acp-runtime"),
}));
vi.mock("../src/shared/github/pr.js", () => ({
  getPrStatus: vi.fn(async () => ({ baseRefName: "acp-runtime" })),
}));
vi.mock("../src/shared/lib/run-command.js", () => ({
  runCommand: vi.fn(async () => ({
    exitCode: 0,
    stdout: "src/a.ts\0",
    stderr: "",
  })),
}));
vi.mock("../src/personas/loader.js", () => ({
  loadPersonas: vi.fn(async () => []),
  loadPersonaBySlug: vi.fn(),
  assemblePersonaPrompt: vi.fn(() => "assembled-prompt"),
}));
vi.mock("../src/personas/review-diff.js", () => ({
  buildPersonaReviewDiff: vi.fn(async () => ({ hasChanges: true })),
}));
vi.mock("../src/agent-type-settings.js", () => ({
  CLI_AGENT_TYPES: ["codex", "claude", "opencode", "cursor"],
  getEnabledAgentTypes: vi.fn(async () => [
    "codex",
    "claude",
    "opencode",
    "cursor",
  ]),
  isCliAgentType: (type: string) =>
    ["codex", "claude", "opencode", "cursor"].includes(type),
}));
vi.mock("../src/personas/codeowners.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/personas/codeowners.js")>()),
  loadCodeowners: vi.fn(),
}));

function setup(parentChanges: Record<string, unknown> = {}) {
  const parent = {
    id: "parent",
    cwd: "/checkout",
    workspacePath: null,
    workspaceBaseBranch: null,
    worktreePath: null,
    worktreeBranch: null,
    baseBranch: "acp-runtime",
    type: "codex",
    parentAgentId: null,
    fullAccess: false,
    ...parentChanges,
  };
  const agentManager = {
    getAgent: vi.fn(async () => parent),
    createAgent: vi.fn(async (input: { name: string }) => ({
      id: `agent-${input.name}`,
      name: input.name,
    })),
  };
  const handlers = createPersonaHandlers({
    pool: {} as any,
    agentManager: agentManager as any,
    publishUiEvent: vi.fn(),
    withStreamFlag: (agent: any) => ({ ...agent, hasStream: false }),
  });
  return { parent, agentManager, handlers };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadCodeowners).mockResolvedValue({
    version: 1,
    rules: [{ paths: ["src/**"], personas: ["owner-one", "owner-two"] }],
  });
  vi.mocked(loadPersonaBySlug).mockImplementation(async (_root, slug) => ({
    slug,
    name: slug,
    description: "Owner",
    feedbackFormat: "findings",
    body: "Verify subsystem contracts",
  }));
  vi.mocked(runCommand).mockResolvedValue({
    exitCode: 0,
    stdout: "src/a.ts\0",
    stderr: "",
  });
});

describe("ACP code owner launches", () => {
  it("previews selected owners without launching", async () => {
    const { handlers, agentManager } = setup();
    const result = await handlers.launchOwnerReviews("parent", {
      context: "Changed routing",
      dryRun: true,
    });
    expect(result.owners).toEqual([
      { persona: "owner-one", files: ["src/a.ts"] },
      { persona: "owner-two", files: ["src/a.ts"] },
    ]);
    expect(result.launched).toEqual([]);
    expect(agentManager.createAgent).not.toHaveBeenCalled();
  });
  it("launches ordinary ACP persona agents with the briefing and one resolved base", async () => {
    const { handlers, agentManager } = setup();
    const result = await handlers.launchOwnerReviews("parent", {
      context: "Changed routing",
      agentType: "codex",
    });
    expect(result.launched.map((owner) => owner.persona)).toEqual([
      "owner-one",
      "owner-two",
    ]);
    expect(agentManager.createAgent).toHaveBeenCalledTimes(2);
    expect(resolveBaseRef).toHaveBeenCalledTimes(1);
    expect(assemblePersonaPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ slug: "owner-one" }),
      expect.stringContaining("Changed routing"),
      expect.anything(),
      expect.objectContaining({ parentAgentId: "parent" })
    );
    expect(agentManager.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        persona: "owner-one",
        parentAgentId: "parent",
        launchedByAgentId: "parent",
        useWorktree: false,
        cwd: "/checkout",
      }),
      { detachLaunch: true }
    );
  });
  it("routes against a moved workspace and its base, not the original checkout", async () => {
    const { handlers, agentManager } = setup({
      workspacePath: "/moved",
      workspaceBaseBranch: "feature-base",
    });
    await handlers.launchOwnerReviews("parent", {
      context: "Changed moved workspace",
    });
    expect(loadCodeowners).toHaveBeenCalledWith("/moved");
    expect(refreshRemoteBaseRef).toHaveBeenCalledWith(
      "/moved",
      "feature-base",
      expect.objectContaining({ allowUpstreamFallback: false })
    );
    expect(runCommand).toHaveBeenCalledWith(
      "git",
      expect.anything(),
      expect.objectContaining({ cwd: "/moved" })
    );
    expect(agentManager.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/moved" }),
      expect.anything()
    );
  });
  it("rejects unknown owners before creating any agents", async () => {
    const { handlers, agentManager } = setup();
    vi.mocked(loadPersonaBySlug).mockImplementation(async (_root, slug) =>
      slug === "owner-two"
        ? null
        : {
            slug,
            name: slug,
            description: "Owner",
            feedbackFormat: "findings",
            body: "Instructions",
          }
    );
    await expect(
      handlers.launchOwnerReviews("parent", { context: "Review" })
    ).rejects.toThrow('Owner persona "owner-two" not found');
    expect(agentManager.createAgent).not.toHaveBeenCalled();
  });
  it("reports a partial launch without hiding successful agents", async () => {
    const { handlers, agentManager } = setup();
    agentManager.createAgent.mockRejectedValueOnce(
      new Error("Engine unavailable")
    );
    const result = await handlers.launchOwnerReviews("parent", {
      context: "Review",
    });
    expect(result.launched.map((owner) => owner.persona)).toEqual([
      "owner-two",
    ]);
    expect(result.failures).toEqual([
      {
        persona: "owner-one",
        files: ["src/a.ts"],
        error: "Engine unavailable",
      },
    ]);
  });
  it("rejects children before selecting owners", async () => {
    const { handlers, agentManager } = setup({ parentAgentId: "launcher" });
    await expect(
      handlers.launchOwnerReviews("parent", { context: "Review" })
    ).rejects.toThrow("Child agents cannot launch owner reviews");
    expect(loadCodeowners).not.toHaveBeenCalled();
    expect(agentManager.createAgent).not.toHaveBeenCalled();
  });
  it("propagates git failures instead of treating them as empty changes", async () => {
    const { handlers, agentManager } = setup();
    vi.mocked(runCommand).mockRejectedValue(new Error("Cannot read diff"));
    await expect(
      handlers.launchOwnerReviews("parent", { context: "Review" })
    ).rejects.toThrow("Cannot read diff");
    expect(agentManager.createAgent).not.toHaveBeenCalled();
  });
});
