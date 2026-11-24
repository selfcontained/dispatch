import { describe, expect, it, vi } from "vitest";

import { AgentManager } from "../src/agents/manager.js";
import { checkoutReadPlacement } from "../src/runners/placement.js";

type Launch = Parameters<AgentManager["createAgent"]>[0];
type Options = NonNullable<Parameters<AgentManager["createAgent"]>[1]>;

const folder = "/repo";
const managed = "runner://test/@session";
const configured = "runner://test/workspace";
const ownerId = "owner";
const projectId = "project";
const templateId = "template";

const shared = "Invalid shared checkout binding.";
const childBinding = "Invalid child checkout binding.";

const callers: {
  caller: string;
  input: Partial<Launch>;
  options?: Options;
  expected: [
    folder: string | null,
    managed: string | null,
    configured: string | null,
    borrowed: string | null,
  ];
}[] = [
  {
    caller: "Create Agent/API",
    input: {},
    expected: [null, null, null, shared],
  },
  {
    caller: "MCP child",
    input: {
      parentAgentId: ownerId,
      launchedByAgentId: ownerId,
      useWorktree: false,
    },
    options: { independentCheckoutOf: ownerId },
    expected: [null, null, null, null],
  },
  {
    caller: "MCP independent",
    input: { launchedByAgentId: ownerId, useWorktree: false },
    options: { independentCheckoutOf: ownerId },
    // Borrows the launcher's checkout, as it runs in the launcher's folder locally.
    expected: [null, null, null, null],
  },
  {
    caller: "task with template",
    input: { templateId, projectId },
    expected: [null, null, null, shared],
  },
  {
    caller: "job",
    input: { jobRunId: "run" },
    expected: [null, null, null, shared],
  },
  {
    caller: "template",
    input: { templateId },
    expected: [null, null, null, shared],
  },
  {
    caller: "persona review",
    input: {
      role: "review",
      persona: "code-review",
      parentAgentId: ownerId,
      launchedByAgentId: ownerId,
      useWorktree: false,
    },
    expected: [null, null, null, null],
  },
];

async function checkAdmission(
  input: Launch,
  options: Options = {},
  flags: {
    available?: boolean;
    sessionFiles?: boolean;
    sharedWorktree?: boolean;
    ownerCwd?: string;
  } = {}
): Promise<string | null> {
  // Stop at the first launch/lookup step after admission. No session or DB
  // is needed, and a different exception still fails the corresponding row.
  const admitted = new Error("admitted");
  const stop = vi.fn(() => {
    throw admitted;
  });
  const owner = {
    id: ownerId,
    cwd: flags.ownerCwd ?? input.cwd,
    placement: checkoutReadPlacement(flags.ownerCwd ?? input.cwd),
    projectId: null,
    fullAccess: false,
  };
  const manager = Object.assign(Object.create(AgentManager.prototype), {
    getAgent: vi.fn(async (id) => (id === owner.id ? owner : null)),
    remote: {
      available: () => flags.available ?? true,
      isManagedWorkspace: () =>
        input.cwd === managed && (flags.available ?? true),
      supportsSessionFiles: () => flags.sessionFiles ?? true,
      supportsSharedWorktree: () => flags.sharedWorktree ?? true,
    },
    config: { agentRuntime: "acp" },
    pool: {
      query: vi.fn(async (sql: string) => ({
        rows: sql.includes("FROM templates")
          ? [{ project_id: null }]
          : sql.includes("WHERE id=$1")
            ? [{ repo_root: folder, repository: "https://example.test/repo" }]
            : [],
      })),
    },
    // The launch folder is resolved through the agent's runner (path.resolve).
    launchDirectory: stop,
    resolveLaunchPath: stop,
    prepareCreate: stop,
  }) as AgentManager;
  try {
    await AgentManager.prototype.createAgent.call(manager, input, options);
  } catch (error) {
    if (error === admitted) return null;
    if (error instanceof Error) return error.message;
    throw error;
  }
  throw new Error("Launch test must stop before creating an agent");
}

describe("launch admission compatibility", () => {
  const targets = [
    { target: "local folder", cwd: folder, borrowed: false },
    { target: "managed runner", cwd: managed, borrowed: false },
    { target: "configured runner", cwd: configured, borrowed: false },
    { target: "borrowed runner checkout", cwd: managed, borrowed: true },
  ];
  it.each(
    callers.flatMap(({ expected, ...row }) =>
      targets.map((target, i) => ({ ...row, ...target, expected: expected[i] }))
    )
  )(
    "$caller → $target",
    async ({ cwd, input, options, borrowed, expected }) => {
      expect(
        await checkAdmission(
          { cwd, ...input },
          borrowed ? { useWorktreeOf: ownerId } : cwd === folder ? {} : options
        )
      ).toBe(expected);
    }
  );

  it("admits a standalone task persona on a managed runner", async () => {
    const input = { cwd: managed, persona: "task-persona" };
    expect(await checkAdmission({ ...input, projectId })).toBeNull();
    expect(await checkAdmission(input)).toBeNull();
  });

  it.each([
    {
      cwd: configured,
      input: { repository: {} },
      expected:
        "Enter a repository URL or select a project with a repository origin.",
    },
    {
      cwd: managed,
      input: { initialFiles: [{}] as Launch["initialFiles"] },
      flags: { sessionFiles: false },
      expected: "Update the runner to launch with startup files.",
    },
    {
      cwd: managed,
      flags: { available: false },
      expected: "The enrolled runner workspace is unavailable.",
    },
    {
      cwd: managed,
      input: { parentAgentId: ownerId, launchedByAgentId: ownerId },
      options: { useWorktreeOf: ownerId },
      flags: { sharedWorktree: false },
      expected: "Update the runner to launch an agent in an existing checkout.",
    },
    {
      cwd: folder,
      input: { parentAgentId: ownerId, launchedByAgentId: ownerId },
      options: { useWorktreeOf: ownerId },
      expected: childBinding,
    },
    {
      cwd: managed,
      input: { launchedByAgentId: ownerId },
      options: { useWorktreeOf: ownerId },
      flags: { sharedWorktree: false },
      expected: "Update the runner to launch an agent in an existing checkout.",
    },
    {
      cwd: folder,
      input: { launchedByAgentId: ownerId },
      options: { useWorktreeOf: ownerId },
      expected: childBinding,
    },
    {
      cwd: managed,
      input: { launchedByAgentId: ownerId, fullAccess: true },
      options: { useWorktreeOf: ownerId },
      expected: childBinding,
    },
    {
      cwd: managed,
      input: {
        launchedByAgentId: ownerId,
        role: "review" as const,
        persona: "code-review",
      },
      options: { useWorktreeOf: ownerId },
      expected: shared,
    },
  ])(
    "preserves rejection $expected",
    async ({ cwd, input, options, flags, expected }) => {
      expect(await checkAdmission({ cwd, ...input }, options, flags)).toBe(
        expected
      );
    }
  );
});
