import { access, readFile, readdir } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { personaCatalog } from "../src/personas/catalog.js";
import { createPersonaHandlers } from "../src/server/mcp-persona-handlers.js";
import {
  resolveRepoRoot,
  resolveWorktreeRoot,
} from "../src/shared/git/git-context.js";
import { getBuiltInPersona } from "../src/personas/built-in.js";
import { runCommand } from "../src/shared/lib/run-command.js";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  access: vi.fn(() => {
    throw new Error("Unexpected checkout filesystem access");
  }),
  readFile: vi.fn(() => {
    throw new Error("Unexpected checkout filesystem read");
  }),
  readdir: vi.fn(() => {
    throw new Error("Unexpected checkout filesystem listing");
  }),
}));
vi.mock("../src/shared/git/git-context.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../src/shared/git/git-context.js")
  >()),
  resolveRepoRoot: vi.fn(async () => "/main-checkout"),
  resolveWorktreeRoot: vi.fn(async () => "/worktree"),
}));
vi.mock("../src/shared/lib/run-command.js", () => ({
  runCommand: vi.fn(() => {
    throw new Error("Unexpected local process");
  }),
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

const modernOwnersPath = ".agents/owners.json";
const legacyOwnersPath = ".dispatch/codeowners.json";
const personaFile = (slug: string) => `.agents/personas/${slug}.md`;
const ownersMap = (...personas: string[]) =>
  JSON.stringify({ version: 1, rules: [{ paths: ["src/**"], personas }] });
type Query = Parameters<
  import("../src/agents/manager.js").AgentManager["inspectCheckout"]
>[1];

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
    projectId: "project",
    fullAccess: false,
    ...parentChanges,
  };
  const checkout = {
    files: ["src/a.ts"],
    baseRef: "origin/acp-runtime",
    head: "a".repeat(40),
    stateId: "1".repeat(64),
    content: new Map([
      [modernOwnersPath, ownersMap("owner-one", "owner-two")],
      [personaFile("owner-one"), "Verify subsystem contracts"],
      [personaFile("owner-two"), "Verify other contracts"],
    ]),
  };
  const agentManager = {
    getAgent: vi.fn(async (_id?: string) => parent),
    inspectCheckout: vi.fn(async (_agent: typeof parent, query: Query) =>
      query.kind === "changes"
        ? {
            kind: "changes" as const,
            baseRef: checkout.baseRef,
            head: checkout.head,
            stateId: checkout.stateId,
            files: checkout.files,
          }
        : {
            kind: "readFile" as const,
            content: checkout.content.get(query.path) ?? null,
          }
    ),
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
  return { parent, agentManager, handlers, checkout };
}

beforeEach(() => vi.clearAllMocks());

describe("code owner launches through the checkout boundary", () => {
  it.each([
    { cwd: "/checkout", baseBranch: "acp-runtime" },
    { cwd: "runner://linux/@session", baseBranch: null },
  ])(
    "plans and launches using only runner checkout facts for $cwd",
    async ({ cwd, baseBranch }) => {
      const { handlers, agentManager, parent, checkout } = setup({
        cwd,
        parentAgentId: "launcher",
        fullAccess: true,
        reviewAgentType: "claude",
      });
      checkout.baseRef = "origin/review-target";
      checkout.files = [
        "src/unstaged.ts",
        "src/staged.ts",
        "src/committed.ts",
        "src/untracked.ts",
        "src/renamed-from.ts",
        "renamed-to.ts",
      ];
      checkout.content.set(legacyOwnersPath, ownersMap("legacy-owner"));
      checkout.content.set(
        ".dispatch/personas/owner-one.md",
        "Stale legacy instructions"
      );
      const context = "Changed routing";
      const preview = await handlers.launchOwnerReviews(parent.id, {
        context,
        dryRun: true,
      });
      expect(preview).toEqual({
        baseRef: checkout.baseRef,
        reviewedState: { head: checkout.head, stateId: checkout.stateId },
        changedFiles: [...checkout.files].sort(),
        owners: ["owner-one", "owner-two"].map((persona) => ({
          persona,
          files: checkout.files
            .filter((path) => path.startsWith("src/"))
            .sort(),
        })),
        uncoveredFiles: ["renamed-to.ts"],
        launched: [],
        failures: [],
      });
      expect(agentManager.createAgent).not.toHaveBeenCalled();

      const result = await handlers.launchOwnerReviews(parent.id, {
        context,
        agentType: "codex",
      });
      expect(result).toEqual({
        ...preview,
        launched: preview.owners.map((owner) => ({
          ...owner,
          agentId: `agent-${owner.persona}-parent`,
        })),
      });
      expect(agentManager.inspectCheckout.mock.calls).toEqual([
        [parent, { kind: "changes", baseBranch }],
        [parent, { kind: "readFile", path: modernOwnersPath }],
        [parent, { kind: "changes", baseBranch }],
        [parent, { kind: "changes", baseBranch }],
        [parent, { kind: "readFile", path: modernOwnersPath }],
        [parent, { kind: "readFile", path: personaFile("owner-one") }],
        [parent, { kind: "readFile", path: personaFile("owner-two") }],
        [parent, { kind: "changes", baseBranch }],
      ]);
      expect(agentManager.createAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd,
          type: "codex",
          persona: "owner-one",
          projectId: "project",
          parentAgentId: "launcher",
          launchedByAgentId: "parent",
          useWorktree: false,
          fullAccess: false,
          initialPrompt: expect.stringContaining('to: "parent"'),
          agentArgs: expect.arrayContaining([
            expect.stringContaining("Verify subsystem contracts"),
            expect.stringContaining('post with to: "parent"'),
            expect.stringContaining(
              `HEAD ${checkout.head}, state ID ${checkout.stateId}`
            ),
          ]),
          personaContext: expect.stringContaining(
            "Inspect the shared checkout without modifying it."
          ),
        }),
        { detachLaunch: true, useWorktreeOf: "parent" }
      );
      // These spies also catch checkout access hidden inside a helper. The source
      // locator may be opaque, and neither placement may consult the server host.
      for (const forbidden of [
        access,
        readFile,
        readdir,
        runCommand,
        resolveRepoRoot,
        resolveWorktreeRoot,
      ])
        expect(forbidden).not.toHaveBeenCalled();
    }
  );

  it.each([
    { cwd: "/checkout", path: modernOwnersPath, dryRun: true },
    {
      cwd: "runner://linux/@session",
      path: personaFile("owner-two"),
      dryRun: false,
    },
  ])(
    "rejects a changed dirty state during $path inspection",
    async ({ cwd, path, dryRun }) => {
      const { handlers, agentManager, checkout } = setup({ cwd });
      const inspect = agentManager.inspectCheckout.getMockImplementation()!;
      agentManager.inspectCheckout.mockImplementation((agent, query) => {
        if (query.kind === "readFile" && query.path === path)
          checkout.stateId = "2".repeat(64);
        return inspect(agent, query);
      });
      await expect(
        handlers.launchOwnerReviews("parent", { context: "Review", dryRun })
      ).rejects.toThrow(/checkout changed.*retry launch_owner_reviews/i);
      expect(agentManager.createAgent).not.toHaveBeenCalled();
    }
  );

  it.each(["explicit", "saved"])(
    "blocks restricted OpenCode owner reviews selected by %s runtime",
    async (selection) => {
      const { handlers, agentManager } = setup(
        selection === "saved" ? { reviewAgentType: "opencode" } : {}
      );
      const result = await handlers.launchOwnerReviews("parent", {
        context: "review",
        ...(selection === "explicit" ? { agentType: "opencode" as const } : {}),
      });
      expect(result.launched).toHaveLength(0);
      expect(result.failures.length).toBeGreaterThan(0);
      expect(
        result.failures.every((f) =>
          JSON.stringify(f).includes(
            "restricted agent cannot launch full-access OpenCode"
          )
        )
      ).toBe(true);
      expect(agentManager.createAgent).not.toHaveBeenCalled();
    }
  );
  it("blocks restricted direct personas using a saved OpenCode reviewer", async () => {
    const { handlers, agentManager } = setup({ reviewAgentType: "opencode" });
    await expect(
      handlers.launchPersonaAgent("parent", {
        persona: "owner-one",
        context: "review",
      })
    ).rejects.toThrow(/restricted agent cannot launch full-access OpenCode/);
    expect(agentManager.createAgent).not.toHaveBeenCalled();
  });

  it("keeps owner reviews restricted when a full-access author chooses OpenCode", async () => {
    const { handlers, agentManager } = setup({ fullAccess: true });
    const result = await handlers.launchOwnerReviews("parent", {
      context: "Review",
      agentType: "opencode",
    });
    expect(result.failures[0]?.error).toMatch(/requires full access/i);
    expect(agentManager.createAgent).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "selects and deduplicates a subset (dryRun=%s)",
    async (dryRun) => {
      const { handlers, agentManager, checkout } = setup();
      checkout.files.push("unowned.txt");
      const result = await handlers.launchOwnerReviews("parent", {
        context: "Subset review",
        personas: ["owner-two", "owner-two"],
        dryRun,
      });
      expect(result.owners).toEqual([
        { persona: "owner-two", files: ["src/a.ts"] },
      ]);
      expect(result.omittedOwners).toEqual([
        { persona: "owner-one", files: ["src/a.ts"] },
      ]);
      expect(result.uncoveredFiles).toEqual(["unowned.txt"]);
      expect(result.launched.map((owner) => owner.persona)).toEqual(
        dryRun ? [] : ["owner-two"]
      );
      expect(agentManager.createAgent).toHaveBeenCalledTimes(dryRun ? 0 : 1);
      if (!dryRun)
        expect(agentManager.createAgent).toHaveBeenCalledWith(
          expect.objectContaining({
            personaContext: expect.stringContaining(
              'Matched changed paths:\n"src/a.ts"'
            ),
          }),
          { detachLaunch: true, useWorktreeOf: "parent" }
        );
    }
  );

  it.each(
    [[], ["owner-one", "typo"], ["unrelated-persona"]].map((personas) => ({
      personas,
    }))
  )("rejects invalid selection %j before launching", async ({ personas }) => {
    const { handlers, agentManager } = setup();
    for (const dryRun of [false, true])
      await expect(
        handlers.launchOwnerReviews("parent", {
          context: "Review",
          personas,
          dryRun,
        })
      ).rejects.toThrow(/at least one|not in the resolved owner plan/);
    expect(agentManager.createAgent).not.toHaveBeenCalled();
  });

  it("validates all selected definitions before launching, including dry runs", async () => {
    const { handlers, agentManager, checkout } = setup();
    checkout.content.delete(personaFile("owner-two"));
    for (const dryRun of [false, true])
      await expect(
        handlers.launchOwnerReviews("parent", {
          context: "Review",
          personas: ["owner-one", "owner-two"],
          dryRun,
        })
      ).rejects.toThrow('Owner persona "owner-two" not found');
    expect(agentManager.createAgent).not.toHaveBeenCalled();
  });

  it.each([
    [
      { workspacePath: "/moved", workspaceBaseBranch: "feature-base" },
      "feature-base",
    ],
    [{ workspacePath: "/moved", workspaceBaseBranch: null }, null],
    [
      { baseBranch: null, worktreePath: "/managed", worktreeBranch: "feature" },
      "main",
    ],
    [{ baseBranch: null }, null],
  ] as const)(
    "preserves the local base choice for %j",
    async (overrides, baseBranch) => {
      const { handlers, agentManager, parent } = setup(overrides);
      await handlers.launchOwnerReviews("parent", {
        context: "Review",
        dryRun: true,
      });
      expect(agentManager.inspectCheckout).toHaveBeenCalledWith(parent, {
        kind: "changes",
        baseBranch,
      });
    }
  );

  it("loads legacy rules and personas when modern paths are missing", async () => {
    const { handlers, agentManager, checkout } = setup();
    checkout.content.delete(modernOwnersPath);
    checkout.content.set(legacyOwnersPath, ownersMap("legacy-owner"));
    checkout.content.set(
      ".dispatch/personas/legacy-owner.md",
      "Legacy review instructions"
    );
    const result = await handlers.launchOwnerReviews("parent", {
      context: "Review",
    });
    expect(result.launched.map(({ persona }) => persona)).toEqual([
      "legacy-owner",
    ]);
    expect(agentManager.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentArgs: expect.arrayContaining([
          expect.stringContaining("Legacy review instructions"),
        ]),
      }),
      { detachLaunch: true, useWorktreeOf: "parent" }
    );
  });

  it("reports a missing map", async () => {
    const { handlers, checkout } = setup();
    checkout.content.delete(modernOwnersPath);
    await expect(
      handlers.launchOwnerReviews("parent", { context: "Review" })
    ).rejects.toThrow("No .agents/owners.json found");
  });

  it("rejects an invalid modern map even when a legacy map is present", async () => {
    const { handlers, agentManager, checkout } = setup();
    checkout.content.set(modernOwnersPath, "");
    checkout.content.set(legacyOwnersPath, ownersMap("owner-one"));
    await expect(
      handlers.launchOwnerReviews("parent", { context: "Review" })
    ).rejects.toThrow("Invalid .agents/owners.json");
    expect(agentManager.createAgent).not.toHaveBeenCalled();
  });

  it("rejects an invalid modern persona even when a legacy persona is present", async () => {
    const { handlers, agentManager, checkout } = setup();
    checkout.content.set(
      personaFile("owner-one"),
      "---\ntype: other\n---\nInvalid"
    );
    checkout.content.set(
      ".dispatch/personas/owner-one.md",
      "Legacy instructions"
    );
    await expect(
      handlers.launchOwnerReviews("parent", { context: "Review" })
    ).rejects.toThrow("Invalid persona type");
    expect(agentManager.createAgent).not.toHaveBeenCalled();
  });

  it("uses the built-in for owner review and allows catalog overrides for manual review", async () => {
    const { handlers, agentManager, parent, checkout } = setup({
      fullAccess: true,
    });
    checkout.content.set(modernOwnersPath, ownersMap("code-review"));
    const builtin = getBuiltInPersona("code-review")!;
    const override = {
      ...builtin,
      body: "Conflicting main checkout instructions",
    };
    const catalog = vi.spyOn(personaCatalog, "get").mockResolvedValueOnce({
      personas: [override],
      warnings: [],
      refreshing: false,
      updatedAt: null,
    });
    try {
      await handlers.launchOwnerReviews("parent", { context: "Review" });
      expect(catalog).not.toHaveBeenCalled();
      expect(agentManager.createAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          fullAccess: false,
          agentArgs: expect.arrayContaining([
            expect.stringContaining(builtin.body.trimEnd()),
          ]),
        }),
        { detachLaunch: true, useWorktreeOf: "parent" }
      );
      const absent = Object.assign(new Error("Persona file absent"), {
        code: "ENOENT",
      });
      vi.mocked(readFile)
        .mockRejectedValueOnce(absent)
        .mockRejectedValueOnce(absent);
      await handlers.launchPersonaAgent(parent.id, {
        persona: "code-review",
        context: "Manual review",
      });
      expect(agentManager.createAgent).toHaveBeenLastCalledWith(
        expect.objectContaining({
          fullAccess: true,
          agentArgs: expect.arrayContaining([
            "--dangerously-bypass-approvals-and-sandbox",
            expect.stringContaining(override.body),
          ]),
        }),
        { detachLaunch: true }
      );
    } finally {
      catalog.mockRestore();
    }
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

  it("surfaces unavailable shared-checkout launch on a runner that can inspect", async () => {
    const { handlers, agentManager } = setup({
      cwd: "runner://older/@session",
      reviewAgentType: "claude",
    });
    agentManager.createAgent.mockRejectedValueOnce(
      new Error("Runner does not support sharing checkouts")
    );
    const result = await handlers.launchOwnerReviews("parent", {
      context: "Review",
      personas: ["owner-one"],
    });
    expect(result.launched).toEqual([]);
    expect(result.failures).toEqual([
      {
        persona: "owner-one",
        files: ["src/a.ts"],
        error: "Runner does not support sharing checkouts",
      },
    ]);
    expect(agentManager.createAgent).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        cwd: "runner://older/@session",
        type: "claude",
        fullAccess: false,
      }),
      { detachLaunch: true, useWorktreeOf: "parent" }
    );
  });

  it("rejects cross-project display parents for both owner and manual launch", async () => {
    const { handlers, agentManager, parent } = setup({
      parentAgentId: "launcher",
    });
    agentManager.getAgent.mockImplementation(async (id?: string) =>
      id === "launcher" ? { ...parent, projectId: "other-project" } : parent
    );
    const result = await handlers.launchOwnerReviews("parent", {
      context: "Review",
    });
    expect(result.launched).toEqual([]);
    expect(result.failures.map(({ error }) => error)).toEqual(
      Array(2).fill(
        "Review display parent must belong to the requester's project."
      )
    );
    await expect(
      handlers.launchPersonaAgent("parent", {
        persona: "owner-one",
        context: "Review",
      })
    ).rejects.toThrow("requester's project");
    expect(agentManager.createAgent).not.toHaveBeenCalled();
  });

  it.each([
    { cwd: "/checkout", reason: "Cannot read diff" },
    {
      cwd: "runner://old/@session",
      reason: "Runner does not support checkout inspection",
    },
  ])("surfaces checkout failure for $cwd", async ({ cwd, reason }) => {
    const { handlers, agentManager } = setup({ cwd });
    agentManager.inspectCheckout.mockRejectedValue(new Error(reason));
    for (const dryRun of [false, true])
      await expect(
        handlers.launchOwnerReviews("parent", { context: "Review", dryRun })
      ).rejects.toThrow(reason);
    expect(agentManager.createAgent).not.toHaveBeenCalled();
    expect(runCommand).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
  });
});
