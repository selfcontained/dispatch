import { placementForRunner } from "../src/runners/placement.js";
import { validationCatalogFixture } from "./helpers/model-catalog-validation.js";
const validationFixtures: ReturnType<typeof validationCatalogFixture>[] = [];
import {
  setLearnedAgentModels,
  getLearnedAgentModels,
  forgetLearnedAgentModels,
} from "../src/shared/agent-models.js";
import { afterEach } from "vitest";
afterEach(() => {
  for (const fixture of validationFixtures.splice(0)) fixture.close();
  forgetLearnedAgentModels();
});
import { access, readFile, readdir } from "node:fs/promises";
import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerPersonaRoutes } from "../src/routes/personas.js";
import { createPersonaHandlers } from "../src/server/mcp-persona-handlers.js";
import {
  resolveRepoRoot,
  resolveWorktreeRoot,
} from "../../../packages/runner/src/workload/shared/git/git-context.js";
import { getBuiltInPersona } from "../src/personas/built-in.js";
import { agentComparisonBase } from "../src/agents/effective-base.js";
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
vi.mock(
  "../../../packages/runner/src/workload/shared/git/git-context.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../../packages/runner/src/workload/shared/git/git-context.js")
    >()),
    resolveRepoRoot: vi.fn(async () => "/main-checkout"),
    resolveWorktreeRoot: vi.fn(async () => "/worktree"),
  })
);
vi.mock(
  "../../../packages/runner/src/workload/shared/lib/run-command.js",
  () => import("../src/shared/lib/run-command.js")
);
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
    placement: placementForRunner(
      parentChanges.cwd === "/srv/linux"
        ? "linux"
        : parentChanges.cwd === "/srv/ubu"
          ? "ubu"
          : "local"
    ),
    ...parentChanges,
  };
  const checkout = {
    files: ["src/a.ts"],
    baseRef: "origin/acp-runtime",
    head: "a".repeat(40),
    stateId: "1".repeat(64),
    defaultFiles: [] as { path: string; content: string }[],
    content: new Map([
      [modernOwnersPath, ownersMap("owner-one", "owner-two")],
      [personaFile("owner-one"), "Verify subsystem contracts"],
      [personaFile("owner-two"), "Verify other contracts"],
    ]),
  };
  const agentManager = {
    getAgent: vi.fn(async (_id?: string) => parent),
    comparisonBase: vi.fn(async (agent: typeof parent) =>
      agentComparisonBase(agent, "review")
    ),
    inspectCheckout: vi.fn(async (_agent: typeof parent, query: Query) => {
      if (query.kind === "changes")
        return {
          kind: "changes" as const,
          baseRef: checkout.baseRef,
          head: checkout.head,
          stateId: checkout.stateId,
          files: checkout.files,
        };
      if (query.kind === "defaultBranchFiles")
        return {
          kind: "defaultBranchFiles" as const,
          hasOrigin: true,
          files: checkout.defaultFiles,
          warnings: [],
          refreshing: false,
          updatedAt: null,
          truncated: false,
        };
      if (query.kind !== "readFile")
        throw new Error("Unexpected checkout query");
      return {
        kind: "readFile" as const,
        content: checkout.content.get(query.path) ?? null,
      };
    }),
    createAgent: vi.fn(
      async (
        input: Parameters<
          import("../src/agents/manager.js").AgentManager["createAgent"]
        >[0]
      ) => ({
        id: `agent-${input.name}`,
        name: input.name,
      })
    ),
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
    { cwd: "/srv/linux", baseBranch: null },
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
        [parent, { kind: "readFile", path: modernOwnersPath }],
        [parent, { kind: "readFile", path: personaFile("owner-one") }],
        [parent, { kind: "readFile", path: personaFile("owner-two") }],
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
          fullAccess: true,
          initialPrompt: expect.stringContaining('to: "parent"'),
          agentArgs: expect.arrayContaining([
            expect.stringContaining("Verify subsystem contracts"),
            expect.stringContaining('post with to: "parent"'),
          ]),
          personaContext: expect.stringContaining(context),
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

  it.each(["/checkout", "/srv/linux"])(
    "keeps both Claude review paths restricted for a restricted author in %s",
    async (cwd) => {
      const { handlers, agentManager } = setup({ cwd, type: "claude" });
      await handlers.launchPersonaAgent("parent", {
        persona: "owner-one",
        context: "Review",
      });
      const result = await handlers.launchOwnerReviews("parent", {
        context: "Review",
        personas: ["owner-one"],
      });
      expect(result.failures).toEqual([]);
      expect(agentManager.createAgent).toHaveBeenCalledTimes(2);
      for (const [launch] of agentManager.createAgent.mock.calls) {
        expect(launch).toMatchObject({
          cwd,
          type: "claude",
          role: "review",
          fullAccess: false,
        });
        expect(launch.agentArgs).not.toContain(
          "--dangerously-skip-permissions"
        );
      }
    }
  );

  it.each(["taught", "first refresh", "failed refresh"] as const)(
    "creates direct and owner reviewers with the available catalog and effort (%s)",
    async (source) => {
      if (source === "taught")
        setLearnedAgentModels(
          "claude",
          [
            {
              id: "runner-custom/review",
              label: "Runner Review",
              effort: [{ value: "runner-effort", name: "Runner effort" }],
            },
          ],
          "runner-custom/review",
          "linux"
        );
      else
        validationFixtures.push(
          validationCatalogFixture(
            "linux",
            "claude",
            [
              {
                id: "runner-custom/review",
                label: "Runner Review",
                effort: [{ value: "runner-effort", name: "Runner effort" }],
              },
            ],
            source === "failed refresh"
          )
        );
      const { handlers, agentManager } = setup({
        cwd: "/srv/linux",
      });
      const options = {
        context: "Review",
        agentType: "claude" as const,
        model: source === "failed refresh" ? "opus" : "runner-custom/review",
        effort: "runner-effort",
      };
      if (source === "failed refresh")
        await expect(
          handlers.launchPersonaAgent("parent", {
            ...options,
            model: "runner-custom/review",
            persona: "owner-one",
          })
        ).rejects.toThrow(
          'Model "runner-custom/review" is not supported for claude. Choose a configured model or omit model for the CLI default.'
        );
      await handlers.launchPersonaAgent("parent", {
        ...options,
        persona: "owner-one",
      });
      const review = await handlers.launchOwnerReviews("parent", {
        ...options,
        personas: ["owner-one"],
      });
      expect(review.failures).toEqual([]);
      expect(agentManager.createAgent).toHaveBeenCalledTimes(2);
      for (const [launch] of agentManager.createAgent.mock.calls) {
        expect(launch).toMatchObject({
          cwd: "/srv/linux",
          model: options.model,
          effort: options.effort,
        });
      }
      if (source !== "taught") {
        expect(
          validationFixtures[0]!.call.mock.calls.filter(
            ([op]) => op === "engine.models"
          )
        ).toHaveLength(1);
        const learned = getLearnedAgentModels("claude", "linux");
        if (source === "first refresh")
          expect(learned?.[0]?.id).toBe("runner-custom/review");
        else expect(learned).toBeUndefined();
      }
    }
  );

  it.each(["/checkout", "/srv/linux"])(
    "inherits full engine access for direct and owner reviews in %s",
    async (cwd) => {
      const { handlers, agentManager } = setup({ cwd, fullAccess: true });
      await handlers.launchPersonaAgent("parent", {
        persona: "owner-one",
        context: "Direct review",
      });
      await handlers.launchOwnerReviews("parent", {
        context: "Owner review",
        personas: ["owner-one"],
      });
      const [direct, owner] = agentManager.createAgent.mock.calls.map(
        ([args]) => args
      );
      expect(direct?.fullAccess).toBe(true);
      expect(direct?.agentArgs).toContain(
        "--dangerously-bypass-approvals-and-sandbox"
      );
      expect(owner?.fullAccess).toBe(true);
      expect(owner?.agentArgs).toContain(
        "--dangerously-bypass-approvals-and-sandbox"
      );
    }
  );

  it.each([
    { cwd: "/checkout", fullAccess: false },
    { cwd: "/checkout", fullAccess: true },
    { cwd: "/srv/ubu", fullAccess: false },
    { cwd: "/srv/ubu", fullAccess: true },
  ])(
    "produces the same launch config for UI kickoff and tool requests (%j)",
    async (author) => {
      const { checkout, handlers, agentManager } = setup(author);
      checkout.content.set(modernOwnersPath, ownersMap("owner-one"));
      const options = { agentType: "codex" as const, context: "Review" };
      const launchDirect = (id: string) =>
        handlers.launchPersonaAgent(id, { ...options, persona: "owner-one" });
      const launchOwners = (id: string) =>
        handlers.launchOwnerReviews(id, options);
      // The UI enqueues a kickoff. Substitute a deterministic tool caller for
      // the author engine so the route and review service run without launching it.
      const app = Fastify();
      await registerPersonaRoutes(app, {
        agentManager: agentManager as never,
        projects: { get: async () => null },
        streams: {
          async promptAgent(id, { text }) {
            if (text.includes('launch_owner_reviews({ agentType: "codex"')) {
              await launchOwners(id);
            } else {
              expect(text).toContain(
                'launch_agent({ persona: "owner-one", type: "codex"'
              );
              await launchDirect(id);
            }
            return { held: false } as never;
          },
        },
        handleAgentError: (reply) => reply.code(500).send(),
      });
      try {
        for (const [payload, callTool] of [
          [{ personas: ["owner-one"] }, launchDirect],
          [{ codeowners: true }, launchOwners],
        ] as const) {
          const response = await app.inject({
            method: "POST",
            url: "/api/v1/agents/parent/launch-persona",
            payload: { ...payload, agentType: "codex" },
          });
          expect(response.statusCode).toBe(200);
          const ui = agentManager.createAgent.mock.calls.at(-1)?.[0];
          await callTool("parent");
          const tool = agentManager.createAgent.mock.calls.at(-1)?.[0];
          expect(tool).toBeDefined();
          expect(ui).toEqual(tool);
          expect(tool?.fullAccess).toBe(author.fullAccess);
        }
      } finally {
        await app.close();
      }
    }
  );

  it.each(["/checkout", "/srv/linux"])(
    "rejects a saved OpenCode reviewer that would elevate a restricted author in %s",
    async (cwd) => {
      const { handlers, agentManager } = setup({
        cwd,
        reviewAgentType: "opencode",
      });
      await expect(
        handlers.launchPersonaAgent("parent", {
          persona: "owner-one",
          context: "Review",
        })
      ).rejects.toThrow(/restricted agent cannot launch full-access OpenCode/);
      const result = await handlers.launchOwnerReviews("parent", {
        context: "Review",
        personas: ["owner-one"],
      });
      expect(result.failures[0]?.error).toMatch(
        /restricted agent cannot launch full-access OpenCode/
      );
      expect(agentManager.createAgent).not.toHaveBeenCalled();
    }
  );

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
    const instructions = "Conflicting default-branch instructions";
    checkout.defaultFiles.push({
      path: personaFile("code-review"),
      content: instructions,
    });
    await handlers.launchOwnerReviews("parent", { context: "Review" });
    expect(agentManager.inspectCheckout).not.toHaveBeenCalledWith(
      parent,
      expect.objectContaining({ kind: "defaultBranchFiles" })
    );
    expect(agentManager.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        fullAccess: true,
        agentArgs: expect.arrayContaining([
          expect.stringContaining(builtin.body.trimEnd()),
        ]),
      }),
      { detachLaunch: true, useWorktreeOf: "parent" }
    );
    await handlers.launchPersonaAgent(parent.id, {
      persona: "code-review",
      context: "Manual review",
    });
    expect(agentManager.createAgent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        fullAccess: true,
        agentArgs: expect.arrayContaining([
          "--dangerously-bypass-approvals-and-sandbox",
          expect.stringContaining(instructions),
        ]),
      }),
      { detachLaunch: true }
    );
    expect(readFile).not.toHaveBeenCalled();
    expect(runCommand).not.toHaveBeenCalled();
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
      cwd: "/srv/older",
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
        cwd: "/srv/older",
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
      cwd: "/srv/old",
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
