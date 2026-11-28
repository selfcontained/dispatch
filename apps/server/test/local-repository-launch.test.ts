import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  resolveSavedTarget,
  savedLaunchTarget,
  normalizeSavedDirectory,
  storedLocation,
} from "../src/runners/saved-location.js";
import { AgentManager } from "../src/agents/manager.js";
import {
  controllerPlacement,
  placementForRunner,
} from "../src/runners/placement.js";
import {
  archiveRunner,
  withRepositorySource,
} from "../src/agents/archive-checkout.js";
import { prepareRecordedWorkspace } from "../src/agents/workspace-launch.js";

it.each(["local", "runner_fixture"])(
  "retains dependency diagnostics in %s startup progress",
  async (runner) => {
    const recordStartupStep = vi.fn().mockResolvedValue(null);
    const manager = Object.assign(Object.create(AgentManager.prototype), {
      launchContextRecorder: { recordStartupStep },
      setSetupPhase: vi.fn().mockResolvedValue(undefined),
      logger: { warn: vi.fn() },
    });
    const progress = manager.runnerWorkspaceProgress(
      { id: "agent", type: "codex", placement: placementForRunner(runner) },
      true
    );
    const detail =
      "pnpm install failed; continuing launch; dependencies may be incomplete. Command timed out (pnpm install), timeoutMs=120000";
    progress.onEvent({ phase: "dependencies" });
    progress.onEvent({ phase: "dependencies", status: "failed", detail });
    progress.onEvent({ phase: "ready" });
    await progress.settled();
    expect(recordStartupStep).toHaveBeenCalledWith({
      agentId: "agent",
      phase: "deps",
      label: "Installing dependencies",
      status: "failed",
      detail,
    });
    expect(recordStartupStep).toHaveBeenLastCalledWith({
      agentId: "agent",
      phase: "session",
      label: "Starting Codex",
    });
  }
);

it("records a Local repository-only project as a repository-source preparation without resolving a folder", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-repository-launch-"));
  const recorded = new Error("recorded");
  const insertAgentRecord = vi.fn().mockRejectedValue(recorded);
  const resolveLaunchPath = vi.fn(() => {
    throw new Error("must not resolve a folder");
  });
  const manager = Object.assign(Object.create(AgentManager.prototype), {
    config: { agentRuntime: "acp" },
    pool: {
      query: vi.fn().mockResolvedValue({
        rows: [{ repo_root: null, repository: "https://github.com/org/repo" }],
      }),
    },
    resolveLaunchPath,
    prepareCreateInputs: vi.fn(async (_input, cwd, context) => {
      expect(cwd).toBe("");
      expect(await context.repository()).toBe("https://github.com/org/repo");
      return {
        id: "agt_repo",
        type: "codex",
        name: "Repo",
        filesDir: join(root, "files"),
        originalCwd: "",
        checkout: {
          source: "new",
          createNewBranch: true,
          branch: "feature/local",
          base: "main",
        },
      };
    }),
    insertAgentRecord,
  }) as AgentManager;
  try {
    await expect(
      manager.createAgent({ cwd: "", projectId: "project", type: "codex" })
    ).rejects.toBe(recorded);
    expect(resolveLaunchPath).not.toHaveBeenCalled();
    expect(insertAgentRecord).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      controllerPlacement,
      {
        url: "https://github.com/org/repo",
        checkout: { kind: "new", branch: "feature/local", base: "main" },
      },
      expect.objectContaining({
        source: {
          repository: "https://github.com/org/repo",
          checkout: { kind: "new", branch: "feature/local", base: "main" },
        },
      }),
      undefined,
      null
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("replays the recorded repository request through the same local runner protocol and makes archive retryable", async () => {
  const request = {
    source: {
      repository: "https://github.com/org/repo",
      checkout: { kind: "default" },
    },
    copyIgnored: [],
    installDependencies: true,
  };
  const pool = {
    query: vi.fn(async (sql: string) => ({
      rows: sql.includes('AS "repositorySource"')
        ? [{ repositorySource: true }]
        : [{ runner_preparation: { ...request, pending: true } }],
    })),
  };
  const manager = Object.assign(Object.create(AgentManager.prototype), {
    pool,
  });
  const replay = await manager.localPreparation("repo");
  expect(replay).toEqual(request);
  const call = vi.fn().mockResolvedValue({
    path: "/runner/cache/repo-main",
    worktree: {
      path: "/runner/cache/repo-main",
      branch: "main",
      base: "main",
    },
    git: null,
  });
  const child = { call } as never;
  await prepareRecordedWorkspace(child, "repo", replay, async () => {});
  expect(call).toHaveBeenCalledWith(
    "workspace.prepare",
    { ...request, session: "repo" },
    expect.objectContaining({ timeoutMs: null })
  );
  const agent = await withRepositorySource(pool as never, {
    id: "repo",
    cwd: "",
    worktreePath: null,
    baseBranch: null,
    worktreeBranch: null,
  });
  const runner = archiveRunner(
    { child: () => child },
    agent,
    controllerPlacement
  );
  expect(runner.archive.failure).toBe("pending");
  expect(runner.archive.coOwner).toBe("observed");
  call.mockResolvedValue({ removed: true });
  await runner.call("workspace.release", {
    session: "repo",
    deleteBranch: false,
    originalBranch: null,
  } as never);
  expect(call).toHaveBeenLastCalledWith(
    "workspace.release",
    { session: "repo", deleteBranch: false, originalBranch: null },
    undefined
  );
});

it("releases a prepared checkout if archive deleted the row while preparation was in flight", async () => {
  const call = vi.fn(async (op: string) =>
    op === "workspace.prepare"
      ? {
          path: "/cache/repo-local",
          worktree: {
            path: "/cache/repo-local",
            branch: "feature/local",
            base: "main",
          },
          git: null,
        }
      : { removed: true }
  );
  const manager = Object.assign(Object.create(AgentManager.prototype), {
    pool: { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) },
    checkoutReadRunners: () => ({ child: () => ({ call }) }),
  });
  await expect(
    manager.prepareRunnerWorkspace(
      { id: "archived", cwd: "", placement: controllerPlacement },
      {
        source: {
          repository: "https://github.com/org/repo",
          checkout: { kind: "default" },
        },
        copyIgnored: [],
        installDependencies: false,
      },
      false
    )
  ).rejects.toThrow("archived during workspace preparation");
  expect(call).toHaveBeenLastCalledWith(
    "workspace.release",
    {
      session: "archived",
      deleteBranch: true,
      originalBranch: "feature/local",
    },
    undefined
  );
});

it("keeps a saved Local repository project pathless and leaves folder-backed targets unchanged", () => {
  const repository = resolveSavedTarget("", {
    runner: "local",
    projectId: "repo",
  });
  expect(repository.directory).toBe("");
  expect(
    normalizeSavedDirectory(repository.directory, repository[storedLocation])
  ).toBe("");
  expect(savedLaunchTarget({ ...repository, useWorktree: true })).toEqual({
    cwd: "",
    placement: controllerPlacement,
    projectId: "repo",
    repository: {},
  });
  const folder = resolveSavedTarget("/existing", {
    runner: "local",
    projectId: "folder",
    projectRoot: "/existing",
  });
  expect(savedLaunchTarget({ ...folder, useWorktree: true })).toEqual({
    cwd: "/existing",
    placement: controllerPlacement,
  });
});

it("does not begin a repository preparation after archive has claimed the row", async () => {
  const prepareRunnerWorkspace = vi.fn();
  const manager = Object.assign(Object.create(AgentManager.prototype), {
    preparingRepositories: new Set(),
    serializeLifecycle: (_id, action) => action(),
    getRequiredAgent: async () => ({ status: "archiving" }),
    prepareRunnerWorkspace,
    failLaunch: async (_id, error) => {
      throw error;
    },
  });
  await expect(
    manager.launchAgent({
      id: "archived",
      directory: null,
      preparation: {
        source: {
          repository: "https://github.com/org/repo",
          checkout: { kind: "default" },
        },
      },
    })
  ).rejects.toThrow("archived before workspace preparation");
  expect(prepareRunnerWorkspace).not.toHaveBeenCalled();
  expect(manager.preparingRepositories.size).toBe(0);
});

it("waits for in-flight repository preparation before claiming archive", async () => {
  const manager = Object.assign(Object.create(AgentManager.prototype), {
    preparingRepositories: new Set(["repo"]),
    lifecycleOperations: new Map(),
    stoppingOrArchiving: new Map(),
    hasRunnerDrainReceipt: () => false,
  });
  let finish!: () => void;
  const preparing = manager.serializeLifecycle(
    "repo",
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      })
  );
  const claim = vi.fn(async () => true);
  const archive = manager.terminateLifecycle("repo", claim, false);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(claim).not.toHaveBeenCalled();
  finish();
  await preparing;
  await archive;
  expect(claim).toHaveBeenCalledTimes(1);
});

it.each(["child", "independent", "review", "descendant"] as const)(
  "records a Local repository-source %s through its launcher's session binding",
  async (kind) => {
    const root = await mkdtemp(join(tmpdir(), "local-borrowed-launch-"));
    const recorded = new Error("recorded");
    const parent = {
      id: "agt_parent",
      cwd: "/managed/feature",
      worktreePath: "/managed/feature",
      projectId: "project",
      placement: controllerPlacement,
      role: "standard",
      fullAccess: false,
    };
    const insertAgentRecord = vi.fn().mockRejectedValue(recorded);
    const prepareCreateInputs = vi.fn(async (input, cwd) => ({
      id: "agt_borrower",
      type: "codex",
      name: "Borrower",
      filesDir: join(root, "files"),
      originalCwd: cwd,
      checkout: null,
    }));
    const manager = Object.assign(Object.create(AgentManager.prototype), {
      config: { agentRuntime: "acp" },
      getAgent: vi.fn(async () => parent),
      pool: {
        query: vi.fn(async (sql: string) => ({
          rows: sql.includes("runner_preparation")
            ? [
                {
                  runner_preparation: {
                    source:
                      kind === "descendant"
                        ? { session: "agt_root" }
                        : {
                            repository: "https://github.com/org/repo",
                            checkout: { kind: "default" },
                          },
                    copyIgnored: [],
                    installDependencies: false,
                  },
                },
              ]
            : [{ repo_root: null, repository: "https://github.com/org/repo" }],
        })),
      },
      launchDirectory: vi.fn(() => {
        throw new Error("must use session source");
      }),
      prepareCreateInputs,
      insertAgentRecord,
    }) as AgentManager;
    try {
      await expect(
        manager.createAgent(
          {
            cwd: parent.cwd,
            type: "codex",
            useWorktree: false,
            launchedByAgentId: parent.id,
            ...(kind !== "independent" && { parentAgentId: parent.id }),
            ...(kind === "review" && {
              role: "review",
              persona: "code-review",
            }),
          },
          kind === "review" ? { useWorktreeOf: parent.id } : {}
        )
      ).rejects.toBe(recorded);
      expect(insertAgentRecord).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ projectId: "project" }),
        controllerPlacement,
        null,
        expect.objectContaining({ source: { session: parent.id } }),
        parent.id,
        null
      );
      expect(prepareCreateInputs).toHaveBeenCalledWith(
        expect.anything(),
        parent.cwd,
        expect.anything(),
        true
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
);

it("leaves a Local external-folder launcher on the existing directory preparation path", async () => {
  const parent = {
    id: "agt_external",
    cwd: "/external",
    projectId: null,
    placement: controllerPlacement,
  };
  const manager = Object.assign(Object.create(AgentManager.prototype), {
    getAgent: vi.fn(async () => parent),
    pool: {
      query: vi.fn(async () => ({
        rows: [{ runner_preparation: { source: { directory: "/external" } } }],
      })),
    },
  });
  const target = await manager.resolveCreateTarget(
    {
      cwd: parent.cwd,
      type: "codex",
      parentAgentId: parent.id,
      launchedByAgentId: parent.id,
      useWorktree: false,
    },
    {}
  );
  expect(target).toMatchObject({
    repositorySource: false,
    checkoutOwner: null,
    directory: undefined,
  });
});

it.each([undefined, "/other"])(
  "preserves a different Local folder named by a repository-source launcher (marker: %s)",
  async (launcherFolder) => {
    const parent = {
      id: "owner",
      cwd: "/managed",
      projectId: null,
      placement: controllerPlacement,
    };
    const query = vi.fn(async () => ({
      rows: [{ runner_preparation: { source: { repository: "/origin.git" } } }],
    }));
    const manager = Object.assign(Object.create(AgentManager.prototype), {
      getAgent: async () => parent,
      pool: { query },
    });
    const input = {
      cwd: "/other",
      type: "codex",
      parentAgentId: parent.id,
      launchedByAgentId: parent.id,
      useWorktree: false,
      ...(launcherFolder && { launcherFolder }),
    };
    const target = await manager.resolveCreateTarget(input, {});
    expect(input.cwd).toBe("/other");
    expect(target).toMatchObject({
      checkoutOwner: null,
      repositorySource: false,
      directory: undefined,
    });
    expect(query).not.toHaveBeenCalled();
  }
);
