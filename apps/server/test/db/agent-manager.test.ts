import { sessionFromWire } from "@dispatch/runner-protocol/contract";
import { withTestWorkspaceRunner } from "../helpers/test-workspace-runner.js";
import * as checkoutIntent from "../../src/agents/checkout-intent.js";
import { createMcpHandlers } from "../../src/server/mcp-handlers.js";
import { sessionFilesWorkload } from "../../src/agents/checkout-worker.js";
import { TemplateService } from "../../src/templates/service.js";
import { personaCatalog } from "../../src/personas/catalog.js";
import * as gitContext from "../../src/shared/git/git-context.js";
import { upsertPersona } from "../helpers/native-persona-authoring.js";
import { execFileSync } from "node:child_process";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { observeGitCheckout } from "../../src/agents/checkout-inspection.js";
import os from "node:os";
import path from "node:path";

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import type { Pool } from "pg";
import type { SessionOperation } from "@dispatch/runner-protocol";
import type { RemoteRunnerService } from "../../src/agents/remote/service.js";

import { setupTestDb, teardownTestDb, runTestMigrations } from "./setup.js";
import type {
  AgentRuntime,
  RuntimeEventListener,
  RuntimeLaunch,
} from "../../src/agents/runtime.js";

// Git context and lifecycle hooks shell out; keep them off the host.
vi.mock("../../src/shared/lib/run-command.js", () => ({
  runCommand: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
}));

// Worktree creation is mocked per test; the rest of the module is real.
vi.mock("../../src/shared/git/worktree.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/shared/git/worktree.js")
  >("../../src/shared/git/worktree.js");
  return { ...actual, createGitWorktree: vi.fn() };
});

vi.mock("../../src/agents/workspace-prep.js", () => ({
  installWorkspaceDependencies: vi.fn(async () => {}),
}));

// We need to dynamically import AgentManager AFTER the mocks are in place
const {
  AgentManager: HostAgentManager,
  AgentError,
  LAUNCH_CONTEXT_RESOLVE_TIMEOUT_MS,
  LAUNCH_CONTEXT_WRITE_TIMEOUT_MS,
  UPDATE_RESUME_MESSAGE,
} = await import("../../src/agents/manager.js");
const AgentManager = withTestWorkspaceRunner(HostAgentManager);
const { StreamService, launchBlockId } =
  await import("../../src/chat/service.js");
const { createAgentMcpToken } = await import("../../src/auth.js");
const { JobService } = await import("../../src/jobs/service.js");
const { JobStore } = await import("../../src/jobs/store.js");
const { createInertRuntime } = await import("../../src/agents/runtime.js");
const { forgetLearnedAgentModels } =
  await import("../../src/shared/agent-models.js");
const { createGitWorktree, GitWorktreeError } =
  await import("../../src/shared/git/worktree.js");

let pool: Pool;

// Minimal logger that satisfies FastifyBaseLogger shape
const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  fatal: () => {},
  trace: () => {},
  child: () => noopLogger,
  silent: () => {},
  level: "silent",
} as unknown as import("fastify").FastifyBaseLogger;

const testConfig = {
  host: "127.0.0.1",
  port: 6767,
  databaseUrl: "",
  authToken: "test-token",
  filesRoot: "/tmp/dispatch-test-files",
  dispatchBinDir: "/tmp/dispatch-test-bin",
  codexBin: "/bin/echo",
  claudeBin: "/bin/echo",
  opencodeBin: "/bin/opencode",
  agentStateRoot: "/tmp/dispatch-test-agents",
  agentRuntime: "acp",
  tls: null,
} satisfies import("../../src/config.js").AppConfig;

const inertTestConfig = {
  ...testConfig,
  agentRuntime: "inert",
} satisfies import("../../src/config.js").AppConfig;

/**
 * A runtime that records what the manager asks of it. It tracks processes
 * (so liveness matters), every host is alive, and a launch mints a session
 * id, the way AcpRuntime reports a fresh ACP session.
 */
type SpyRuntime = AgentRuntime & {
  launch: ReturnType<typeof vi.fn<AgentRuntime["launch"]>>;
  attach: ReturnType<typeof vi.fn<AgentRuntime["attach"]>>;
  isAlive: ReturnType<typeof vi.fn<AgentRuntime["isAlive"]>>;
  prompt: ReturnType<typeof vi.fn<AgentRuntime["prompt"]>>;
  isBusy: ReturnType<typeof vi.fn<AgentRuntime["isBusy"]>>;
  hasOpenTurn: ReturnType<typeof vi.fn<AgentRuntime["hasOpenTurn"]>>;
  cancel: ReturnType<typeof vi.fn<AgentRuntime["cancel"]>>;
  stop: ReturnType<typeof vi.fn<AgentRuntime["stop"]>>;
  listHosted: ReturnType<typeof vi.fn<AgentRuntime["listHosted"]>>;
  readLogTail: ReturnType<typeof vi.fn<AgentRuntime["readLogTail"]>>;
  /** Deliver an event as the host would. */
  emit: RuntimeEventListener;
};

function createSpyRuntime(): SpyRuntime {
  const listeners: RuntimeEventListener[] = [];
  let sessions = 0;
  return {
    ...createInertRuntime(),
    tracksProcesses: () => true,
    launch: vi.fn(async (input: RuntimeLaunch) => ({
      sessionId: input.resumeSessionId ?? `sess_${++sessions}`,
      resumed: input.resumeSessionId !== null,
    })),
    attach: vi.fn(async () => false),
    isAlive: vi.fn(async () => true),
    prompt: vi.fn(() => ({
      accepted: Promise.resolve(),
      settled: Promise.resolve(),
    })),
    isBusy: vi.fn(() => false),
    hasOpenTurn: vi.fn(() => false),
    cancel: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    listHosted: vi.fn(async () => []),
    readLogTail: vi.fn(async () => ""),
    onEvent(listener) {
      listeners.push(listener);
      return () => {};
    },
    async emit(agentId, event, seq) {
      for (const listener of listeners) await listener(agentId, event, seq);
    },
  };
}

let runtime: SpyRuntime;
let manager: InstanceType<typeof AgentManager>;

let chatEvents: unknown[] = [];

/**
 * The published stream entries that carry a launch briefing. Every launch
 * writes its card (its startup steps and instructions land on it); these
 * tests are about the briefing: the prompt, files and links it was given.
 */
function launchChatEvents(): unknown[] {
  return chatEvents.filter((event) => {
    const block = (
      event as {
        entry?: {
          block?: { kind?: string; text?: string; attachments?: unknown[] };
        };
      }
    ).entry?.block;
    return (
      block?.kind === "launch" &&
      (!!block.text || (block.attachments?.length ?? 0) > 0)
    );
  });
}

/** A manager on its own spy runtime, for tests that need a logger or recorder of their own. */
function managerWith(
  opts: {
    warn?: ReturnType<typeof vi.fn>;
    runtime?: AgentRuntime;
  } = {}
) {
  const logger = opts.warn
    ? ({ ...noopLogger, warn: opts.warn, child: () => noopLogger } as never)
    : noopLogger;
  return new AgentManager(pool, logger, testConfig, {
    runtime: opts.runtime ?? createSpyRuntime(),
  });
}

/** The single launch the runtime was handed. */
function lastLaunch(spy: SpyRuntime = runtime): RuntimeLaunch {
  const calls = spy.launch.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1]![0];
}

/** Every prompt the runtime was handed for one agent. */
function promptsFor(agentId: string, spy: SpyRuntime = runtime): string[] {
  return spy.prompt.mock.calls
    .filter(([id]) => id === agentId)
    .map(([, text]) => text);
}

beforeAll(async () => {
  testConfig.agentStateRoot = await mkdtemp(
    path.join(os.tmpdir(), "dispatch-agent-manager-")
  );
  inertTestConfig.agentStateRoot = testConfig.agentStateRoot;
  pool = await setupTestDb();
  await runTestMigrations();
});

afterAll(async () => {
  await rm(testConfig.agentStateRoot, { recursive: true, force: true });
  await teardownTestDb();
});

beforeEach(async () => {
  chatEvents = [];
  await pool.query("DELETE FROM blocks");
  await pool.query("DELETE FROM files_seen");
  await pool.query("DELETE FROM files");
  await pool.query("DELETE FROM agents");
  vi.mocked(createGitWorktree).mockReset();
  vi.mocked(createGitWorktree).mockImplementation(
    async (input) =>
      ({
        worktreePath: "/tmp",
        branchName: input.branchName ?? input.baseBranch ?? "main",
      }) as never
  );

  runtime = createSpyRuntime();
  manager = new AgentManager(pool, noopLogger, testConfig, { runtime });
  // The Chat feed's launch-context recorder, wired the way server.ts does.
  manager.attachLaunchContextRecorder(
    new StreamService({
      pool,
      publishUiEvent: (event) => chatEvents.push(event),
      getAgent: (id) => manager.getAgent(id),
      filesRoot: testConfig.filesRoot,
    })
  );
});

describe("AgentManager", () => {
  it.each([
    { name: "another agent's file", source: null },
    { name: "a hard link", source: "linked.txt", hardLink: true },
    { name: "a 21 MiB file", source: "large.txt", size: 21 * 1024 * 1024 },
    { name: "a path with dot-dot", source: "files/../note.txt" },
    { name: "a backslash name", source: "back\\slash.txt" },
    { name: "a file under the state root", source: "hosts/note.txt" },
  ])("collects $name from the local filesystem", async (fixture) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dispatch-local-file-"));
    const filesRoot = path.join(root, "files");
    const agentStateRoot = path.join(root, "hosts");
    const localManager = new AgentManager(
      pool,
      noopLogger,
      { ...testConfig, filesRoot, agentStateRoot },
      { runtime }
    );
    try {
      const agent = await localManager.createAgent({
        cwd: root,
        useWorktree: false,
      });
      await mkdir(agentStateRoot, { recursive: true });

      // Keep the original path so the dot-dot case reaches the filesystem.
      let source: string;
      if (fixture.source === null) {
        const other = await localManager.createAgent({
          cwd: root,
          useWorktree: false,
        });
        source = path.join(other.filesDir!, "note.txt");
      } else {
        source = `${root}/${fixture.source}`;
      }
      const bytes = Buffer.alloc(fixture.size ?? 32, "a");
      if (fixture.hardLink) {
        const original = path.join(root, "original.txt");
        await writeFile(original, bytes);
        await link(original, source);
      } else {
        await writeFile(source, bytes);
      }

      const collected = await localManager.collectSessionFile(agent, source);
      expect(collected.equals(bytes)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("collects a local session file with one read and no copy, as main", async () => {
    const agent = await manager.createAgent({
      cwd: "/tmp",
      useWorktree: false,
    });
    const file = path.join(testConfig.agentStateRoot, "collect-once.bin");
    await writeFile(file, Buffer.from([0, 1, 2, 255]));
    const read = vi.spyOn(sessionFilesWorkload, "get");
    read.mockClear();
    try {
      const collected = await manager.collectSessionFile(agent, file);
      expect(read).toHaveBeenCalledExactlyOnceWith(file);
      // The very Buffer the read returned: never encoded and decoded.
      expect(collected).toBe(await read.mock.results[0]!.value);
    } finally {
      read.mockRestore();
      await rm(file, { force: true });
    }
  });

  it("delivers a registered native composer text file through the built-in runner", async () => {
    const agent = await manager.createAgent({
      cwd: "/tmp",
      useWorktree: false,
    });
    const file = path.join(agent.filesDir!, "composer.txt");
    const deliver = vi.spyOn(sessionFilesWorkload, "put");
    deliver.mockClear();
    const submitted = vi.fn();
    const chat = new StreamService({
      pool,
      publishUiEvent: () => {},
      getAgent: (id) => manager.getAgent(id),
      filesRoot: testConfig.filesRoot,
      delivery: {
        access: async () => ({ mode: "live" }),
        held: () => false,
        activeTurn: () => false,
        cancel: async () => {},
        inject: async (id, text, opts) => {
          const prepared = await manager["preparePromptFiles"](
            id,
            opts?.images ?? [],
            text
          );
          submitted(prepared.text, prepared.images);
        },
      },
    });
    try {
      await writeFile(file, "composer text");
      const {
        rows: [attachment],
      } = await pool.query<{ id: number }>(
        `INSERT INTO files (agent_id, file_name, source, size_bytes, mime_type)
         VALUES ($1, 'composer.txt', 'user', 13, 'text/plain') RETURNING id`,
        [agent.id]
      );
      await chat.sendUserPost(agent.id, {
        text: "Read the attachment",
        attachments: [{ type: "file", fileId: attachment.id }],
      });
      await chat.waitForInFlightDeliveries(2_000);
      expect(deliver).toHaveBeenCalledExactlyOnceWith(file, "prompt");
      expect(submitted).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining(`- file: ${file} (text/plain,`),
        []
      );
    } finally {
      await rm(file, { force: true });
    }
  });

  describe("createAgent", () => {
    it("uses the project folder for direct and template launches and retains the child's folder", async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "dispatch-project-"));
      try {
        const projectId = "local-create-project";
        const childCwd = path.join(root, "child");
        await mkdir(childCwd);
        await pool.query(
          "INSERT INTO projects (id, name, repo_root) VALUES ($1, 'Local', $2)",
          [projectId, root]
        );
        const parent = await manager.createAgent({ cwd: childCwd, projectId });
        expect(parent).toMatchObject({
          cwd: root,
          projectId,
          worktreePath: null,
        });
        const child = await manager.createAgent({
          cwd: childCwd,
          parentAgentId: parent.id,
          useWorktree: false,
        });
        expect(child).toMatchObject({ cwd: childCwd, projectId });
        const templateId = "local-create-template";
        await pool.query(
          "INSERT INTO templates (id, name, directory, project_id) VALUES ($1, 'Local', $2, $3)",
          [templateId, root, projectId]
        );
        const templated = await manager.createAgent({
          cwd: childCwd,
          templateId,
        });
        expect(templated).toMatchObject({ cwd: root, projectId, templateId });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it.each([
      [{ templateId: "missing" }, 404, "Template not found."],
      [{ projectId: "missing" }, 404, "Project not found."],
      [{}, 400, "Working directory must be an absolute path."],
    ] as const)(
      "validates local launch inputs in main's order (%j)",
      async (input, statusCode, message) => {
        await expect(
          manager.createAgent({ cwd: "relative", ...input })
        ).rejects.toMatchObject({ statusCode, message });
        expect(runtime.launch).not.toHaveBeenCalled();
        expect(await manager.listAgents()).toEqual([]);
      }
    );

    it("publishes the creating row before preparing an existing branch", async () => {
      const created = vi.fn();
      manager.onAgentCreated(created);
      vi.mocked(createGitWorktree).mockImplementationOnce(async () => {
        expect(created).toHaveBeenCalledWith(
          expect.objectContaining({
            status: "creating",
            setupPhase: "worktree",
          })
        );
        expect(runtime.launch).not.toHaveBeenCalled();
        return { worktreePath: "/tmp", branchName: "develop" } as never;
      });
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: true,
        createNewBranch: false,
        baseBranch: "develop",
      });
      expect(createGitWorktree).toHaveBeenCalledWith(
        expect.objectContaining({
          baseBranch: "develop",
          createNewBranch: false,
        })
      );
      expect(agent).toMatchObject({
        status: "running",
        setupPhase: null,
        worktreeBranch: "develop",
      });
    });

    it("persists managed placement across restart and retries archive when the original runner returns", async () => {
      const available = vi.fn(() => true);
      const stateId = "2".repeat(64);
      const requestSession = vi.fn(
        async (_placement: unknown, operation: SessionOperation) => {
          if (!available()) throw new Error("offline");
          if (operation.kind !== "checkoutRelease")
            throw new Error("Unexpected request");
          return {
            value:
              operation.operation.kind === "release"
                ? "released"
                : JSON.stringify({
                    ownership: "owned",
                    owner: "test-owner",
                    borrowers: [],
                    checkout: {
                      path: "/runner/checkout",
                      branch: "agent-work",
                      stateId,
                      unmerged: false,
                      changedFiles: [],
                      uncommittedFiles: [],
                    },
                  }),
          };
        }
      );
      const remote = {
        available,
        requestSession,
        isManagedWorkspace: available,
        originFor: () => "https://example.test",
      } as unknown as RemoteRunnerService;
      const first = new AgentManager(pool, noopLogger, testConfig, {
        runtime,
        remote,
      });
      const cwd = "runner://runner-test/@session";
      const projectId = "managed-runner-project";
      await pool.query(
        "INSERT INTO projects (id, name, repo_root) VALUES ($1, 'Runner', '/tmp/remote-project')",
        [projectId]
      );
      const repository = {
        url: "https://example.test/fixture.git",
        checkout: { kind: "new", branch: "agent-work", base: "develop" },
      };
      const agent = await first.createAgent({ cwd, projectId, repository });
      expect(agent).toMatchObject({ cwd, projectId });
      expect(runtime.launch).toHaveBeenLastCalledWith(
        expect.objectContaining({
          placement: { runner: "runner-test", workspace: "@session" },
          repository,
        })
      );

      const resumedRuntime = createSpyRuntime();
      const discard = vi.fn(async () => {});
      const resumed = new AgentManager(pool, noopLogger, testConfig, {
        runtime: { ...resumedRuntime, discard },
        remote,
      });
      await resumed.stopAgent(agent.id);
      await resumed.startAgent(agent.id);
      expect(resumedRuntime.launch).toHaveBeenCalledWith(
        expect.objectContaining({ repository })
      );
      const observed = await resumed.checkWorktreeStatus(agent.id);
      expect(observed).toMatchObject({
        ownership: "owned",
        checkoutState: stateId,
      });
      await resumed.beginArchive(agent.id, "auto", stateId);
      // Simulate a row created before runner_managed was populated.
      await pool.query(
        "UPDATE agents SET runner_managed = false WHERE id = $1",
        [agent.id]
      );
      available.mockReturnValue(false);
      await expect(resumed.checkWorktreeStatus(agent.id)).rejects.toMatchObject(
        { statusCode: 503 }
      );
      resumedRuntime.stop.mockRejectedValueOnce(new Error("offline"));
      await resumed.executeArchive(agent.id, {
        onPhaseChange: vi.fn(),
        onComplete: vi.fn(),
        onError: vi.fn(),
      });
      const pending = async () =>
        (
          await pool.query(
            "SELECT runner_cleanup_pending FROM agents WHERE id = $1 AND deleted_at IS NOT NULL",
            [agent.id]
          )
        ).rows[0]?.runner_cleanup_pending;
      expect(await pending()).toBe(true);
      const placement = { runner: "runner-test", workspace: "@session" };
      requestSession.mockClear();
      await resumed.reconcileAgentStatuses();
      await vi.waitFor(() =>
        expect(requestSession).toHaveBeenCalledWith(placement, {
          kind: "checkoutRelease",
          agentId: agent.id,
          operation: { kind: "observe" },
        })
      );
      expect(await pending()).toBe(true);
      const reconnected = new AgentManager(pool, noopLogger, testConfig, {
        runtime: { ...createSpyRuntime(), discard },
        remote,
      });
      available.mockReturnValue(true);
      await reconnected.reconcileAgentStatuses();
      await vi.waitFor(async () => expect(await pending()).toBe(false));
      expect(requestSession).toHaveBeenLastCalledWith(placement, {
        kind: "checkoutRelease",
        agentId: agent.id,
        operation: { kind: "release", expectedState: stateId },
      });
      expect(discard).not.toHaveBeenCalled();
    });

    it("retries an offline archive in a configured runner workspace until the host is stopped and released (audit #17)", async () => {
      const available = vi.fn(() => false);
      const requestSession = vi.fn(
        async (_placement: unknown, operation: SessionOperation) => {
          if (!available()) throw new Error("offline");
          if (operation.kind !== "checkoutRelease")
            throw new Error("Unexpected request");
          return {
            value:
              operation.operation.kind === "release"
                ? "released"
                : JSON.stringify({
                    ownership: "external",
                    owner: null,
                    borrowers: [],
                    checkout: null,
                  }),
          };
        }
      );
      const remote = {
        available,
        requestSession,
        isManagedWorkspace: () => false,
        originFor: () => "https://example.test",
      } as unknown as RemoteRunnerService;
      const cwd = "runner://runner-test/configured";
      const placement = { runner: "runner-test", workspace: "configured" };
      // The runner the locator names, as every launch records it (0065).
      await pool.query(
        `INSERT INTO agents (id, name, cwd, status, runner_id)
         VALUES ('configured-runner', 'Configured', $1, 'running', 'runner-test')`,
        [cwd]
      );
      const offlineRuntime = createSpyRuntime();
      offlineRuntime.stop.mockRejectedValue(new Error("offline"));
      const offline = new AgentManager(pool, noopLogger, testConfig, {
        runtime: offlineRuntime,
        remote,
      });
      await offline.beginArchive("configured-runner", "auto");
      const onComplete = vi.fn();
      await offline.executeArchive("configured-runner", {
        onPhaseChange: vi.fn(),
        onComplete,
        onError: vi.fn(),
      });
      expect(onComplete).toHaveBeenCalledWith(["configured-runner"]);
      const pending = async () =>
        (
          await pool.query(
            "SELECT runner_cleanup_pending FROM agents WHERE id = 'configured-runner' AND deleted_at IS NOT NULL"
          )
        ).rows[0]?.runner_cleanup_pending;
      expect(await pending()).toBe(true);

      // Still offline: the retry stays pending.
      await offline.reconcileAgentStatuses();
      await vi.waitFor(() =>
        expect(offlineRuntime.stop).toHaveBeenCalledTimes(2)
      );
      expect(await pending()).toBe(true);
      const releases = () =>
        requestSession.mock.calls.filter(
          ([, request]) => request.kind === "checkoutRelease"
        );
      expect(releases()).toEqual([]);

      // The runner reconnects: the retry stops the host, then releases it.
      available.mockReturnValue(true);
      const onlineRuntime = createSpyRuntime();
      const reconnected = new AgentManager(pool, noopLogger, testConfig, {
        runtime: onlineRuntime,
        remote,
      });
      await reconnected.reconcileAgentStatuses();
      await vi.waitFor(async () => expect(await pending()).toBe(false));
      expect(onlineRuntime.stop).toHaveBeenCalledWith(
        "configured-runner",
        true
      );
      expect(releases().at(-1)).toEqual([
        placement,
        {
          kind: "checkoutRelease",
          agentId: "configured-runner",
          operation: { kind: "release", expectedState: null },
        },
      ]);
    });

    it("refreshes a runner branch after a turn and keeps the last context if the probe fails", async () => {
      const root = "/runner/checkout";
      const requestSession = vi.fn(
        async (_placement: unknown, request: SessionOperation) => {
          if (
            request.kind !== "sessionCheckout" ||
            request.operation.kind !== "context"
          )
            throw new Error("Unexpected request");
          return {
            value: JSON.stringify({
              repoRoot: root,
              worktreePath: root,
              worktreeName: "checkout",
              isWorktree: false,
              branch,
              repoIconPath: "favicon.svg",
            }),
          };
        }
      );
      let branch = "main";
      const remote = {
        available: () => true,
        isManagedWorkspace: () => true,
        requestSession,
        originFor: () => "https://example.test",
      } as unknown as RemoteRunnerService;
      const first = new AgentManager(pool, noopLogger, testConfig, {
        runtime,
        remote,
      });
      const agent = await first.createAgent({
        cwd: "runner://runner-test/@session",
      });
      expect(agent.gitContext).toMatchObject({
        branch,
        repoIconPath: "favicon.svg",
      });

      const settle = () =>
        runtime.emit(
          agent.id,
          {
            type: "turn",
            agentId: agent.id,
            state: "settled",
          },
          0
        );

      branch = "after-turn";
      await settle();
      await vi.waitFor(async () => {
        expect(await first.getAgent(agent.id)).toMatchObject({
          gitContext: { branch },
          gitContextStale: false,
        });
      });

      requestSession.mockRejectedValueOnce(new Error("runner offline"));
      await settle();
      await vi.waitFor(async () => {
        expect(await first.getAgent(agent.id)).toMatchObject({
          gitContext: { branch },
          gitContextStale: true,
        });
      });
    });

    it("records a runner selection only after acknowledgement and binds independent children to the selected origin", async () => {
      const cwd = "runner://runner-test/@session";
      const projectId = "managed-runner-project";
      await pool.query(
        "INSERT INTO projects (id, name, repo_root) VALUES ($1, 'Runner', '/tmp/remote-project') ON CONFLICT DO NOTHING",
        [projectId]
      );
      const requestSession = vi.fn(async () => ({
        value: JSON.stringify({
          path: "/workload/moved",
          moved: true,
          origin: "https://example.test/moved.git",
        }),
      }));
      const remote = {
        available: () => true,
        isManagedWorkspace: () => true,
        requestSession,
        originFor: () => "https://example.test",
      } as unknown as RemoteRunnerService;
      const first = new AgentManager(pool, noopLogger, testConfig, {
        runtime,
        remote,
      });
      const parent = await first.createAgent({ cwd, projectId });
      expect(parent).toMatchObject({ cwd, projectId, workspacePath: null });
      requestSession.mockClear();
      const move = { path: "/workload/moved/src", baseBranch: "develop" };
      requestSession.mockRejectedValueOnce(new Error("runner offline"));
      await expect(first.setWorkspace(parent.id, move)).rejects.toThrow(
        "runner offline"
      );
      expect(await first.getAgent(parent.id)).toMatchObject({
        workspacePath: null,
      });
      await expect(
        first.setWorkspace(parent.id, { path: "runner://other/@session" })
      ).rejects.toThrow("Workspace path must be absolute.");
      expect(requestSession).toHaveBeenCalledTimes(1);
      await expect(first.setWorkspace(parent.id, move)).resolves.toMatchObject({
        cwd,
        projectId,
        workspacePath: "/workload/moved",
        workspaceBaseBranch: "develop",
      });
      expect(requestSession).toHaveBeenCalledWith(
        { runner: "runner-test", workspace: "@session" },
        {
          agentId: parent.id,
          kind: "sessionCheckout",
          operation: { kind: "select", path: move.path },
          workspace: "@session",
        },
        undefined,
        undefined
      );

      const childInput = {
        cwd,
        launchedByAgentId: parent.id,
        parentAgentId: parent.id,
        useWorktree: true,
        baseBranch: "develop",
      };
      // The launcher's folder is its session's (T36): no binding option.
      const child = await first.createAgent(childInput);
      expect(child).toMatchObject({ cwd, projectId, parentAgentId: parent.id });
      const launch = expect.objectContaining({
        agentId: child.id,
        repository: {
          url: "https://example.test/moved.git",
          checkout: {
            kind: "new",
            branch: expect.stringContaining(child.id),
            base: "develop",
          },
        },
      });
      expect(runtime.launch).toHaveBeenLastCalledWith(launch);
      expect(
        runtime.launch.mock.calls.at(-1)?.[0].useWorktreeOf
      ).toBeUndefined();
      const restarted = new AgentManager(pool, noopLogger, testConfig, {
        runtime,
        remote,
      });
      await restarted.stopAgent(child.id);
      await restarted.startAgent(child.id);
      expect(runtime.launch).toHaveBeenLastCalledWith(launch);
      expect(await restarted.getAgent(parent.id)).toMatchObject({
        cwd,
        projectId,
        workspacePath: "/workload/moved",
      });
    });

    it("records the branch from a runner's prepared worktree and resumes it on restart", async () => {
      const cwd = "runner://runner-test/@session";
      const projectId = "capable-runner-project";
      const repository = "https://example.test/project";
      await pool.query(
        "INSERT INTO projects (id, name, repo_root, repository) VALUES ($1, 'Runner', '/tmp/capable-runner-project', $2)",
        [projectId, repository]
      );
      const requestSession = vi.fn(
        async (_placement: unknown, _command: { kind: string }) => ({
          value: JSON.stringify({
            data: {
              path: "/workload/prepared",
              moved: false,
              origin: repository,
              worktree: {
                path: "/workload/prepared",
                branch: "prepared-feature",
                base: "trunk",
              },
            },
          }),
        })
      );
      const remote = {
        available: () => true,
        isManagedWorkspace: () => true,
        supportsPreparedLaunch: () => true,
        originFor: () => "https://example.test",
        requestSession,
      } as unknown as RemoteRunnerService;
      const manager = new AgentManager(pool, noopLogger, testConfig, {
        runtime,
        remote,
      });
      await expect(manager.createAgent({ cwd })).rejects.toThrow(
        "Choose a project to launch on this runner."
      );
      const agent = await manager.createAgent({
        cwd,
        projectId,
        repository: { url: "https://other.test/ignored" },
        baseBranch: "trunk",
        worktreeBranch: "feature",
      });
      expect(agent.worktreeBranch).toBe("prepared-feature");
      expect(requestSession).toHaveBeenCalledWith(
        { runner: "runner-test", workspace: "@session" },
        expect.objectContaining({
          agentId: agent.id,
          kind: "workspacePrepare",
          operation: expect.objectContaining({
            source: {
              repository,
              checkout: { kind: "new", branch: "feature", base: "trunk" },
            },
          }),
        }),
        expect.any(Function),
        undefined
      );
      expect(runtime.launch.mock.calls.at(-1)?.[0].repository).toBeUndefined();
      await manager.stopAgent(agent.id);
      requestSession.mockClear();
      expect(await manager.startAgent(agent.id)).toMatchObject({
        worktreeBranch: "prepared-feature",
      });
      expect(requestSession).toHaveBeenCalledWith(
        { runner: "runner-test", workspace: "@session" },
        expect.objectContaining({ kind: "workspaceResume", agentId: agent.id }),
        undefined,
        undefined
      );
      expect(
        requestSession.mock.calls.some(
          ([, command]) =>
            (command as { kind: string }).kind === "workspacePrepare"
        )
      ).toBe(false);
    });

    describe("a runner launch from a bare repository URL", () => {
      const cwd = "runner://runner-test/@session";
      const joined = "https://example.test/joined";
      const runnerManager = (prepared: boolean) =>
        new AgentManager(pool, noopLogger, testConfig, {
          runtime,
          remote: {
            available: () => true,
            isManagedWorkspace: () => true,
            supportsPreparedLaunch: () => prepared,
            originFor: () => "https://example.test",
            requestSession: vi.fn(
              async (_p: unknown, command: { kind: string }) => {
                const checkout = {
                  path: "/workload/prepared",
                  moved: false,
                  origin: "https://example.test/explicit",
                };
                return {
                  value: JSON.stringify(
                    command.kind === "sessionCheckout"
                      ? checkout
                      : { data: checkout }
                  ),
                };
              }
            ),
          } as unknown as RemoteRunnerService,
        });
      beforeAll(async () => {
        await pool.query(
          `INSERT INTO projects (id, name, repository) VALUES
             ('url-joined', 'Joined', $1), ('url-explicit', 'Explicit', 'https://example.test/explicit')
           ON CONFLICT DO NOTHING`,
          [joined]
        );
      });

      it("keeps today's outcome for a URL no project has", async () => {
        const repository = { url: "https://example.test/nomatch" };
        await expect(
          runnerManager(true).createAgent({ cwd, repository })
        ).rejects.toThrow("Choose a project to launch on this runner.");
        const older = await runnerManager(false).createAgent({
          cwd,
          repository,
        });
        expect(older.projectId).toBeNull();
      });

      it("starts in the project for its repository", async () => {
        for (const prepared of [true, false]) {
          const agent = await runnerManager(prepared).createAgent({
            cwd,
            repository: { url: `${joined}.git` },
          });
          expect(agent.projectId).toBe("url-joined");
        }
      });

      it("keeps an explicit project and a parent's project", async () => {
        const repository = { url: `${joined}.git` };
        const manager = runnerManager(true);
        const explicit = await manager.createAgent({
          cwd,
          projectId: "url-explicit",
          repository,
        });
        expect(explicit.projectId).toBe("url-explicit");
        const child = await manager.createAgent({
          cwd,
          parentAgentId: explicit.id,
          launchedByAgentId: explicit.id,
          repository,
        });
        expect(child.projectId).toBe("url-explicit");
      });

      it("leaves a local launch to main's folder matching", async () => {
        const folder = await mkdtemp(path.join(os.tmpdir(), "url-local-"));
        const local = await runnerManager(true).createAgent({
          cwd: folder,
          repository: { url: joined },
        });
        expect(local.projectId).toBeNull();
      });
    });

    it("shows a runner's prepared checkout on the row, keeping its locator and its worktree status", async () => {
      const cwd = "runner://runner-test/@session";
      const projectId = "displayed-runner-project";
      const repository = "https://example.test/displayed";
      await pool.query(
        "INSERT INTO projects (id, name, repository) VALUES ($1, 'Runner', $2)",
        [projectId, repository]
      );
      let observed: unknown = null;
      const requestSession = vi.fn(
        async (_placement: unknown, command: { kind: string }) => ({
          value: JSON.stringify(
            command.kind === "checkoutRelease"
              ? observed
              : {
                  data: {
                    path: "/workload/displayed",
                    moved: false,
                    origin: repository,
                    worktree: {
                      path: "/workload/displayed",
                      branch: "displayed",
                      base: "main",
                    },
                  },
                }
          ),
        })
      );
      const remote = {
        available: () => true,
        isManagedWorkspace: () => true,
        supportsPreparedLaunch: () => true,
        originFor: () => "https://example.test",
        requestSession,
      } as unknown as RemoteRunnerService;
      const manager = new AgentManager(pool, noopLogger, testConfig, {
        runtime,
        remote,
      });
      const agent = await manager.createAgent({
        cwd,
        projectId,
        worktreeBranch: "displayed",
      });
      expect(await manager.getAgent(agent.id)).toMatchObject({
        cwd,
        worktreePath: "/workload/displayed",
        worktreeBranch: "displayed",
        workspacePath: null,
      });

      // The archive dialog answers as it did when the row had no path.
      const status = async (worktreePath: string | null) => {
        await pool.query("UPDATE agents SET worktree_path = $2 WHERE id = $1", [
          agent.id,
          worktreePath,
        ]);
        return manager.checkWorktreeStatus(agent.id).then(
          (value) => ({ value }),
          (error: { statusCode?: number; message: string }) => ({
            error: [error.statusCode, error.message],
          })
        );
      };
      observed = {
        ownership: "owned",
        owner: agent.id,
        borrowers: [],
        checkout: {
          path: "/workload/displayed",
          branch: "displayed",
          stateId: "3".repeat(64),
          unmerged: false,
          changedFiles: [],
          uncommittedFiles: [],
        },
      };
      expect(await status("/workload/displayed")).toEqual(await status(null));
      // A gone checkout answers as main does: the recorded worktree, or no
      // worktree when the row records none.
      observed = { ...observed, checkout: null };
      expect(await status("/workload/displayed")).toMatchObject({
        value: { hasWorktree: true, worktreePath: "/workload/displayed" },
      });
      expect(await status(null)).toMatchObject({
        value: { hasWorktree: false, worktreePath: null },
      });
      observed = {
        ...observed,
        checkout: {
          path: "/workload/displayed",
          branch: "displayed",
          stateId: "3".repeat(64),
          unmerged: false,
          changedFiles: [],
          uncommittedFiles: [],
        },
      };
      expect(await status("/workload/displayed")).toMatchObject({
        value: { hasWorktree: true, worktreePath: "/workload/displayed" },
      });
    });

    it("passes the parent session for both remote checkout modes", async () => {
      const cwd = "runner://runner-test/@session";
      const projectId = "session-source-project";
      await pool.query(
        "INSERT INTO projects (id, name, repository) VALUES ($1, 'Runner', 'https://example.test/session-source')",
        [projectId]
      );
      const requestSession = vi.fn(async () => ({
        value: JSON.stringify({
          data: { path: "/runner/current", moved: false, origin: null },
        }),
      }));
      const remote = {
        available: () => true,
        isManagedWorkspace: () => true,
        supportsPreparedLaunch: () => true,
        supportsSessionWorkspaceSource: () => true,
        originFor: () => "https://example.test",
        requestSession,
      } as unknown as RemoteRunnerService;
      const manager = new AgentManager(pool, noopLogger, testConfig, {
        runtime,
        remote,
      });
      const parent = await manager.createAgent({
        cwd,
        projectId,
        useWorktree: false,
      });

      for (const useWorktree of [false, true]) {
        requestSession.mockClear();
        const child = await manager.createAgent({
          cwd,
          parentAgentId: parent.id,
          useWorktree,
          ...(useWorktree && { baseBranch: "develop", createNewBranch: false }),
        });
        expect(child).toMatchObject({
          projectId,
          parentAgentId: parent.id,
          status: "running",
        });
        expect(requestSession).toHaveBeenCalledWith(
          { runner: "runner-test", workspace: "@session" },
          expect.objectContaining({
            agentId: child.id,
            kind: "workspacePrepare",
            operation: {
              source: { session: parent.id },
              ...(useWorktree && {
                worktree: expect.objectContaining({
                  base: "develop",
                  create: false,
                }),
              }),
              copyIgnored: expect.any(Array),
              installDependencies: true,
            },
          }),
          expect.any(Function),
          undefined
        );
        expect(lastLaunch().agentId).toBe(child.id);
        expect(lastLaunch().useWorktreeOf).toBe(
          useWorktree ? undefined : parent.id
        );
      }
    });

    it("launches a runner caller's child in a folder it names on that runner (D7)", async () => {
      const cwd = "runner://runner-test/@session";
      const projectId = "named-folder-project";
      await pool.query(
        "INSERT INTO projects (id, name, repository) VALUES ($1, 'Runner', 'https://example.test/named-folder')",
        [projectId]
      );
      let prepareError: object | null = null;
      const requestSession = vi.fn(
        async (_location: unknown, { kind }: { kind: string }) => ({
          value: JSON.stringify(
            kind === "workspacePrepare" && prepareError
              ? { error: prepareError }
              : {
                  data: { path: "/srv/other", moved: false, origin: null },
                }
          ),
        })
      );
      // The runner's own answer, as its workload worker resolves the path.
      const resolveRunnerPath = vi.fn(
        async (_runner: string, { path: raw }: { path: string }) => ({
          resolvedPath: raw,
          canonicalPath: raw === "/srv/missing" ? null : raw,
          exists: raw !== "/srv/missing",
          isDirectory: raw !== "/srv/missing",
          isGitRepo: false,
          privacyRestricted: false,
          projectRoot: null,
          git: null,
        })
      );
      const remote = {
        available: () => true,
        isManagedWorkspace: () => true,
        supportsPreparedLaunch: () => true,
        supportsSessionWorkspaceSource: () => true,
        originFor: () => "https://example.test",
        requestSession,
        resolveRunnerPath,
      } as unknown as RemoteRunnerService;
      const manager = new AgentManager(pool, noopLogger, testConfig, {
        runtime,
        remote,
      });
      const parent = await manager.createAgent({
        cwd,
        projectId,
        useWorktree: false,
      });
      const named = (folder: string, more: object = {}) =>
        manager.createAgent({
          cwd: folder,
          launcherFolder: folder,
          parentAgentId: parent.id,
          launchedByAgentId: parent.id,
          useWorktree: false,
          ...more,
        });

      for (const useWorktree of [false, true]) {
        requestSession.mockClear();
        resolveRunnerPath.mockClear();
        const child = await named("/srv/other", {
          useWorktree,
          ...(useWorktree && { baseBranch: "develop", createNewBranch: false }),
        });
        // Resolved on the caller's runner, never on this machine.
        expect(resolveRunnerPath).toHaveBeenCalledWith("runner-test", {
          path: "/srv/other",
        });
        expect(child).toMatchObject({
          cwd,
          projectId,
          parentAgentId: parent.id,
          status: "running",
        });
        expect(requestSession).toHaveBeenCalledWith(
          { runner: "runner-test", workspace: "@session" },
          expect.objectContaining({
            agentId: child.id,
            kind: "workspacePrepare",
            operation: {
              source: { directory: "/srv/other" },
              ...(useWorktree && {
                worktree: expect.objectContaining({
                  base: "develop",
                  create: false,
                }),
              }),
              copyIgnored: expect.any(Array),
              installDependencies: true,
            },
          }),
          expect.any(Function),
          undefined
        );
        // Its own session: it borrows nothing of its launcher's.
        expect(lastLaunch().agentId).toBe(child.id);
        expect(lastLaunch().useWorktreeOf).toBeUndefined();
        const { rows } = await pool.query(
          "SELECT runner_id, runner_worktree_owner, runner_preparation FROM agents WHERE id = $1",
          [child.id]
        );
        expect(rows[0]).toMatchObject({
          runner_id: "runner-test",
          runner_worktree_owner: null,
          runner_preparation: { source: { directory: "/srv/other" } },
        });
      }

      // A folder that does not exist there: main's 400, before any record.
      requestSession.mockClear();
      const before = (await pool.query("SELECT count(*) FROM agents")).rows[0]
        .count;
      await expect(named("/srv/missing")).rejects.toMatchObject({
        statusCode: 400,
        message: "Working directory does not exist or is not a directory.",
      });
      expect(
        (await pool.query("SELECT count(*) FROM agents")).rows[0].count
      ).toBe(before);
      expect(requestSession).not.toHaveBeenCalled();

      // A preparation the runner refuses fails the launch; the launcher's
      // checkout is never asked for or released.
      requestSession.mockClear();
      prepareError = {
        code: "not_found",
        message: "Working directory does not exist or is not a directory.",
      };
      const failed = await named("/srv/other").catch((error) => error);
      const sessions = requestSession.mock.calls.map(
        ([, request]) => (request as { agentId: string }).agentId
      );
      expect(sessions).not.toContain(parent.id);
      const failedId =
        failed?.id ??
        (
          await pool.query(
            "SELECT id FROM agents WHERE parent_agent_id = $1 ORDER BY created_at DESC LIMIT 1",
            [parent.id]
          )
        ).rows[0].id;
      expect((await manager.getAgent(failedId))?.status).not.toBe("running");
      expect(await manager.getAgent(parent.id)).toMatchObject({
        cwd,
        status: "running",
      });
    });

    it("settles an unattempted remote launch while offline and prepares once on Start", async () => {
      const cwd = "runner://runner-test/@session";
      const projectId = "remote-create-crash-project";
      await pool.query(
        "INSERT INTO projects (id, name, repo_root, repository) VALUES ($1, 'Runner', '/tmp/remote-crash-root', 'https://example.test/create-crash')",
        [projectId]
      );
      let online = true;
      const requestSession = vi.fn(
        async (_location: unknown, { kind }: { kind: string }) => ({
          value: JSON.stringify({
            data:
              kind === "workspaceResume"
                ? null
                : { path: "/runner/checkout", moved: false, origin: null },
          }),
        })
      );
      const remote = {
        available: () => online,
        isManagedWorkspace: () => true,
        supportsPreparedLaunch: () => true,
        originFor: () => "https://example.test",
        requestSession,
      } as unknown as RemoteRunnerService;
      const first = new AgentManager(pool, noopLogger, testConfig, {
        runtime,
        remote,
      });
      const catalog = vi
        .spyOn(personaCatalog, "get")
        .mockImplementationOnce(() => new Promise(() => {}));
      try {
        const created = await first.createAgent(
          {
            cwd,
            projectId,
            persona: "builder",
            useWorktree: true,
            worktreeBranch: "recover/remote",
          },
          { detachLaunch: true }
        );
        expect(created.status).toBe("creating");
        await vi.waitFor(() => expect(catalog).toHaveBeenCalled());
        expect(requestSession).not.toHaveBeenCalled();
        expect(runtime.launch).not.toHaveBeenCalled();

        online = false;
        const retryRuntime = createSpyRuntime();
        retryRuntime.isAlive.mockResolvedValue(true);
        const restarted = new AgentManager(pool, noopLogger, testConfig, {
          runtime: retryRuntime,
          remote,
        });
        expect(await restarted.restoreRunningAgents()).toMatchObject({
          lost: [created.id],
        });
        expect(await restarted.getAgent(created.id)).toMatchObject({
          status: "stopped",
        });
        expect(retryRuntime.isAlive).not.toHaveBeenCalled();
        expect(requestSession).not.toHaveBeenCalled();

        online = true;
        expect(await restarted.startAgent(created.id)).toMatchObject({
          status: "running",
        });
        expect(
          requestSession.mock.calls.map(([, command]) => command.kind)
        ).toContain("workspaceResume");
        expect(
          requestSession.mock.calls.filter(
            ([, command]) => command.kind === "workspacePrepare"
          )
        ).toHaveLength(1);
        expect(retryRuntime.launch).toHaveBeenCalledTimes(1);
      } finally {
        catalog.mockRestore();
      }
    });

    it("carries MCP new and existing checkout intent to the runner launch request", async ({
      onTestFinished,
    }) => {
      const remote = {
        available: () => true,
        isManagedWorkspace: () => true,
        originFor: () => "https://example.test",
        requestSession: vi.fn(async () => ({
          value: JSON.stringify({
            path: "/workload/source",
            moved: false,
            origin: "https://example.test/source.git",
          }),
        })),
      } as unknown as RemoteRunnerService;
      const manager = new AgentManager(pool, noopLogger, testConfig, {
        runtime,
        remote,
      });
      const parent = await manager.createAgent({
        cwd: "runner://runner-test/@session",
      });
      const mcp = createMcpHandlers({
        pool,
        agentManager: manager,
        publishUiEvent: vi.fn(),
        withStreamFlag: (agent) => ({ ...agent, hasStream: false }),
      } as Parameters<typeof createMcpHandlers>[0]);
      const convert = vi.spyOn(checkoutIntent, "toRunnerCheckout");
      onTestFinished(() => {
        convert.mockRestore();
      });
      const input = {
        name: "existing",
        prompt: "Work independently",
        useWorktree: true,
      };
      for (const [refs, checkout] of [
        [
          { baseBranch: "origin/feature/x" },
          { kind: "branch", branch: "feature/x", allowDefault: true },
        ],
        [
          { baseBranch: "origin/feature/x", worktreeBranch: "ignored" },
          { kind: "branch", branch: "feature/x", allowDefault: true },
        ],
        [
          { baseBranch: "main" },
          { kind: "branch", branch: "main", allowDefault: true },
        ],
        [{}, { kind: "default" }],
        [
          {
            createNewBranch: true,
            worktreeBranch: "origin/new-topic",
            baseBranch: "origin/develop",
          },
          { kind: "new", branch: "origin/new-topic", base: "develop" },
        ],
        [
          { createNewBranch: true },
          { kind: "new", branch: expect.stringMatching(/^agt_.+\/existing$/) },
        ],
      ] as const) {
        convert.mockClear();
        const child = await mcp.launchAgent(parent.id, { ...input, ...refs });
        expect(convert).toHaveReturnedWith(expect.objectContaining(checkout));
        expect(runtime.launch).toHaveBeenLastCalledWith(
          expect.objectContaining({
            agentId: child.agentId,
            repository: {
              url: "https://example.test/source.git",
              checkout,
            },
          })
        );
      }
    });

    it("resolves a web repository launch from worktree intent like the old raw checkout", async () => {
      const remote = {
        available: () => true,
        isManagedWorkspace: () => true,
        listGitHubBranches: vi.fn(async () => ({
          branches: ["main", "trunk"],
          defaultBranch: "trunk",
        })),
        originFor: () => "https://example.test",
      } as unknown as RemoteRunnerService;
      const manager = new AgentManager(pool, noopLogger, testConfig, {
        runtime,
        remote,
      });
      const cwd = "runner://runner-test/@session";
      const url = "https://example.test/r.git";
      const launched = async (input: Record<string, unknown>) => {
        const agent = await manager.createAgent({
          cwd,
          name: "Web Topic",
          ...input,
        });
        const call = runtime.launch.mock.calls.at(-1)?.[0];
        expect(call?.agentId).toBe(agent.id);
        return { agent, repository: call?.repository };
      };
      for (const [raw, intent, checkout] of [
        [
          { kind: "new", branch: "topic", base: "develop" },
          {
            createNewBranch: true,
            worktreeBranch: "topic",
            baseBranch: "develop",
          },
          { kind: "new", branch: "topic", base: "develop" },
        ],
        [
          { kind: "new", branch: "topic" },
          { createNewBranch: true, worktreeBranch: "topic" },
          { kind: "new", branch: "topic" },
        ],
        // The shared resolver also lets an existing branch be the default
        // branch, as MCP and local launches already do.
        [
          { kind: "branch", branch: "feature/x" },
          { createNewBranch: false, baseBranch: "feature/x" },
          { kind: "branch", branch: "feature/x", allowDefault: true },
        ],
      ] as const) {
        // An older client's raw checkout is still launched unchanged.
        expect(
          (await launched({ repository: { url, checkout: raw } })).repository
        ).toEqual({ url, checkout: raw });
        expect(
          (
            await launched({
              repository: { url },
              useWorktree: true,
              ...intent,
            })
          ).repository
        ).toEqual({ url, checkout });
      }
      // A blank new-branch name gets the same auto name as MCP launches.
      const auto = await launched({
        repository: { url },
        useWorktree: true,
        createNewBranch: true,
      });
      expect(auto.repository).toEqual({
        url,
        checkout: { kind: "new", branch: `${auto.agent.id}/web-topic` },
      });
      const known = await launched({
        repository: { url: "https://github.com/owner/repo.git" },
      });
      expect(known.agent.baseBranch).toBe("trunk");
      expect(known.repository?.checkout).toMatchObject({
        kind: "new",
        base: "trunk",
      });
      expect(remote.listGitHubBranches).toHaveBeenCalledWith(
        "runner-test",
        "owner",
        "repo"
      );
      await expect(
        manager.comparisonBase(known.agent, "changes")
      ).resolves.toBe("trunk");
      await expect(manager.comparisonBase(known.agent, "review")).resolves.toBe(
        "trunk"
      );

      await expect(
        manager.createAgent({ cwd, repository: {}, useWorktree: true })
      ).rejects.toThrow("Enter a repository URL");
      await expect(
        manager.createAgent({
          cwd,
          repository: { url },
          createNewBranch: true,
          worktreeBranch: "bad..name",
        })
      ).rejects.toThrow();
    });

    it.each([false, true])(
      "places project templates and scheduled jobs on their saved runner (prepared=%s)",
      async (prepared) => {
        const cwd = "runner://runner-test/@session";
        const projectId = `repository-only-runner-project-${prepared}`;
        const repository = `https://example.test/owner/repo-${prepared}`;
        await pool.query(
          "INSERT INTO projects (id, name, repository) VALUES ($1, 'Runner', $2)",
          [projectId, repository]
        );
        const requestSession = vi.fn(async () => ({
          value: JSON.stringify({
            data: { path: "/runner/project", moved: false, origin: repository },
          }),
        }));
        const remote = {
          available: () => true,
          isManagedWorkspace: () => true,
          originFor: () => "https://example.test",
          supportsPreparedLaunch: () => prepared,
          requestSession,
        } as unknown as RemoteRunnerService;
        const manager = new AgentManager(pool, noopLogger, testConfig, {
          runtime,
          remote,
        });
        const templates = new TemplateService(pool, manager, noopLogger);
        const template = await templates.addTemplate({
          name: `Run remote template (prepared=${prepared})`,
          projectId,
          directory: cwd,
          prompt: "Work",
          useWorktree: false,
        });
        const { agent } = await templates.launchTemplate({
          templateId: template.id,
        });
        expect(agent).toMatchObject({
          cwd,
          projectId,
          templateId: template.id,
        });
        const jobs = new JobService(pool, manager, noopLogger, testConfig);
        try {
          const job = await jobs.addJob({
            name: `Run remote job (prepared=${prepared})`,
            projectId,
            directory: cwd,
            prompt: "Work on the schedule",
            schedule: "0 * * * *",
            enabled: true,
            useWorktree: false,
          });
          const run = await jobs.runJob({
            jobId: job.id,
            triggerSource: "scheduled",
            wait: false,
          });
          expect(await manager.getAgent(run.agentId!)).toMatchObject({
            cwd,
            projectId,
          });
          if (prepared)
            for (const agentId of [agent.id, run.agentId])
              expect(requestSession).toHaveBeenCalledWith(
                expect.anything(),
                expect.objectContaining({
                  agentId,
                  kind: "workspacePrepare",
                  operation: expect.objectContaining({
                    source: { repository, checkout: { kind: "default" } },
                  }),
                }),
                expect.any(Function),
                undefined
              );
          expect(runtime.launch).toHaveBeenLastCalledWith(
            expect.objectContaining({
              agentId: run.agentId,
              placement: { runner: "runner-test", workspace: "@session" },
              mcp: expect.objectContaining({
                url: `https://example.test/api/mcp/jobs/${run.runId}/${run.agentId}`,
              }),
            })
          );
        } finally {
          await jobs.shutdown();
        }
      }
    );

    it("persists the actual reviewer checkout owner on the same runner and reuses it on restart", async () => {
      const supportsSharedWorktree = vi.fn(() => true);
      const requestSession = vi.fn(async () => ({
        value: JSON.stringify({
          kind: "changes",
          head: "a".repeat(40),
          baseRef: "origin/develop",
          stateId: "b".repeat(64),
          files: ["src/test.ts"],
        }),
      }));
      const remote = {
        available: () => true,
        isManagedWorkspace: () => true,
        supportsSharedWorktree,
        requestSession,
        originFor: () => "https://example.test",
      } as unknown as RemoteRunnerService;
      const first = new AgentManager(pool, noopLogger, testConfig, {
        runtime,
        remote,
      });
      const cwd = "runner://runner-test/@session";
      const parent = await first.createAgent({
        cwd,
        repository: {
          url: "https://example.test/r.git",
          checkout: { kind: "new", branch: "topic", base: "develop" },
        },
      });
      const launch = {
        cwd,
        role: "review" as const,
        parentAgentId: parent.id,
        launchedByAgentId: parent.id,
        useWorktree: false,
        persona: "code-review",
      };
      await expect(
        first.createAgent(
          { ...launch, cwd: "runner://unrelated/@session" },
          { useWorktreeOf: parent.id }
        )
      ).rejects.toThrow("Invalid shared checkout binding");
      await expect(
        first.createAgent(
          {
            cwd,
            parentAgentId: parent.id,
            launchedByAgentId: parent.id,
            fullAccess: true,
          },
          { useWorktreeOf: parent.id }
        )
      ).rejects.toThrow("Invalid child checkout binding");
      supportsSharedWorktree.mockReturnValueOnce(false);
      await expect(
        first.createAgent(launch, { useWorktreeOf: parent.id })
      ).rejects.toThrow("Update the runner");
      const child = await first.createAgent(launch, {
        useWorktreeOf: parent.id,
      });
      const expected = expect.objectContaining({
        agentId: child.id,
        useWorktreeOf: parent.id,
        placement: { runner: "runner-test", workspace: "@session" },
      });
      expect(runtime.launch).toHaveBeenLastCalledWith(expected);
      await first.stopAgent(child.id);
      const resumed = new AgentManager(pool, noopLogger, testConfig, {
        runtime,
        remote,
      });
      await resumed.startAgent(child.id);
      expect(runtime.launch).toHaveBeenLastCalledWith(expected);
      await resumed.inspectCheckout(child, {
        kind: "changes",
        baseBranch: null,
      });
      expect(requestSession).toHaveBeenCalledWith(
        { runner: "runner-test", workspace: "@session" },
        {
          kind: "inspectCheckout",
          agentId: child.id,
          query: { kind: "changes", baseBranch: "develop" },
        }
      );
      // Changes and stats use the same launch base as review (old runner).
      await resumed
        .viewCheckout(child, {
          kind: "stats",
          baseBranch: null,
          includeUncommitted: true,
        })
        .catch(() => null);
      expect(requestSession).toHaveBeenLastCalledWith(
        { runner: "runner-test", workspace: "@session" },
        {
          kind: "viewCheckout",
          agentId: child.id,
          query: {
            kind: "stats",
            baseBranch: "develop",
            includeUncommitted: true,
          },
        }
      );
    });

    it("binds a child:false launch without a worktree to its launcher's runner checkout", async () => {
      const supportsSharedWorktree = vi.fn(() => true);
      const remote = {
        available: () => true,
        isManagedWorkspace: () => true,
        supportsSharedWorktree,
        requestSession: vi.fn(),
        originFor: () => "https://example.test",
      } as unknown as RemoteRunnerService;
      const first = new AgentManager(pool, noopLogger, testConfig, {
        runtime,
        remote,
      });
      const cwd = "runner://runner-test/@session";
      const launcher = await first.createAgent({
        cwd,
        repository: {
          url: "https://example.test/r.git",
          checkout: { kind: "new", branch: "topic", base: "develop" },
        },
      });
      // What MCP launch_agent sends for child:false with no worktree.
      const launch = {
        cwd,
        launchedByAgentId: launcher.id,
        useWorktree: false,
      };
      supportsSharedWorktree.mockReturnValueOnce(false);
      await expect(
        first.createAgent(launch, { useWorktreeOf: launcher.id })
      ).rejects.toThrow(
        "Update the runner to launch an agent in an existing checkout."
      );
      const independent = await first.createAgent(launch, {
        useWorktreeOf: launcher.id,
      });
      expect(independent).toMatchObject({
        cwd,
        parentAgentId: null,
        launchedByAgentId: launcher.id,
      });
      const expected = expect.objectContaining({
        agentId: independent.id,
        useWorktreeOf: launcher.id,
        placement: { runner: "runner-test", workspace: "@session" },
      });
      expect(runtime.launch).toHaveBeenLastCalledWith(expected);
      expect(runtime.launch.mock.calls.at(-1)?.[0].repository).toBeUndefined();
      const { rows } = await pool.query(
        "SELECT runner_worktree_owner, runner_repository FROM agents WHERE id = $1",
        [independent.id]
      );
      expect(rows[0]).toEqual({
        runner_worktree_owner: launcher.id,
        runner_repository: null,
      });
      await first.stopAgent(independent.id);
      const resumed = new AgentManager(pool, noopLogger, testConfig, {
        runtime,
        remote,
      });
      await resumed.startAgent(independent.id);
      expect(runtime.launch).toHaveBeenLastCalledWith(expected);
    });

    it.each([null, "project-b"])(
      "inherits parent membership with template project %s",
      async (templateProject) => {
        await pool.query(
          "INSERT INTO projects (id, name, repo_root) VALUES ('project-a', 'A', '/tmp'), ('project-b', 'B', '/var/tmp') ON CONFLICT DO NOTHING"
        );
        await pool.query(
          "INSERT INTO templates (id, name, directory, project_id) VALUES ('child-template', 'Child', '/var/tmp', $1) ON CONFLICT (id) DO UPDATE SET project_id=$1",
          [templateProject]
        );
        const parent = await manager.createAgent({
          cwd: "/tmp",
          projectId: "project-a",
          useWorktree: false,
        });
        const child = await manager.createAgent({
          cwd: parent.cwd,
          parentAgentId: parent.id,
          templateId: "child-template",
          useWorktree: false,
        });
        expect(child.projectId).toBe("project-a");
        expect(child.cwd).toBe(parent.cwd);
        expect(child.templateId).toBe("child-template");
        const standalone = await manager.createAgent({
          cwd: "/tmp",
          templateId: "child-template",
          useWorktree: false,
        });
        expect(standalone.projectId).toBe(templateProject ?? "project-a");
      }
    );

    it("should launch the host, go running, and record the ACP session id", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });

      expect(agent.id).toMatch(/^agt_/);
      expect(agent.status).toBe("running");
      expect(agent.setupPhase).toBeNull();
      expect(agent.cwd).toBe("/tmp");
      expect(agent.type).toBe("claude");
      expect(agent.role).toBe("standard");
      expect(agent.cliSessionId).toBe("sess_1");
      expect(agent.filesDir).toBeTruthy();
      expect(agent.createdAt).toBeTruthy();
      expect(runtime.launch).toHaveBeenCalledTimes(1);
    });

    it("should hand the runtime the engine, cwd and an agent-scoped MCP endpoint", async () => {
      const agent = await manager.createAgent({
        type: "claude",
        cwd: "/tmp",
        useWorktree: false,
      });

      const launch = lastLaunch();
      expect(launch).toMatchObject({
        agentId: agent.id,
        cwd: "/tmp",
        engine: "claude",
        mcp: {
          url: `http://127.0.0.1:6767/api/mcp/${agent.id}`,
          token: createAgentMcpToken("test-token", agent.id),
        },
        resumeSessionId: null,
      });
      expect(launch.env).toEqual({
        DISPATCH_FILES_DIR: path.join(testConfig.filesRoot, agent.id),
      });
      expect(launch.systemPrompt).toContain(agent.id);
    });

    it("should use the job MCP route and token for job runs", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
        jobRunId: "run_1",
      });
      expect(lastLaunch().mcp?.url).toBe(
        `http://127.0.0.1:6767/api/mcp/jobs/run_1/${agent.id}`
      );
      expect(lastLaunch().mcp?.token).toEqual(expect.any(String));
      expect(lastLaunch().mcp?.token).not.toBe(
        createAgentMcpToken("test-token", agent.id)
      );
    });

    it.each(["claude", "codex"] as const)(
      "starts a %s job whose task is supplied through appended instructions",
      async (type) => {
        const agent = await manager.createAgent({
          cwd: "/tmp",
          useWorktree: false,
          type,
          jobRunId: "run_startup",
          agentArgs: [
            "--append-system-prompt",
            "Audit the nightly build and call job_complete with the report.",
          ],
        });
        expect(lastLaunch().systemPrompt).toContain("Audit the nightly build");
        expect(lastLaunch().systemPrompt).toContain("job_needs_input");
        expect(lastLaunch().systemPrompt).not.toContain("No task, no work");
        expect(promptsFor(agent.id)).toEqual([
          "Run the Dispatch job described in your instructions. Follow its lifecycle requirements and report the outcome with a job terminal tool.",
        ]);
      }
    );

    it("should hand the first prompt to runtime.prompt after the agent is running", async () => {
      let statusAtPrompt: string | undefined;
      runtime.prompt.mockImplementation((id) => {
        void manager.getAgent(id).then((a) => {
          statusAtPrompt = a?.status;
        });
        return { accepted: Promise.resolve(), settled: Promise.resolve() };
      });

      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
        initialPrompt: "  Fix the flaky test  ",
      });

      expect(promptsFor(agent.id)).toEqual(["Fix the flaky test"]);
      await vi.waitFor(() => expect(statusAtPrompt).toBe("running"));
    });

    it("should not prompt when there is nothing to say", async () => {
      await manager.createAgent({ cwd: "/tmp", useWorktree: false });
      expect(runtime.prompt).not.toHaveBeenCalled();
    });

    it("links a job before tool discovery and lets its first turn immediately complete it", async () => {
      await pool.query(`INSERT INTO jobs (id, directory, name, prompt, enabled, agent_type, use_worktree, full_access, timeout_ms, needs_input_timeout_ms, auto_archive)
        VALUES ('job_order', '/tmp', 'Launch ordering', 'Report success immediately.', false, 'codex', false, false, 1800000, 1800000, false)`);
      const service = new JobService(pool, manager, noopLogger, testConfig);
      const store = new JobStore(pool);
      let completion:
        | ReturnType<InstanceType<typeof JobService>["completeRunForAgent"]>
        | undefined;
      runtime.launch.mockImplementationOnce(async (input) => {
        expect(await store.getActiveRunForAgent(input.agentId)).toMatchObject({
          jobId: "job_order",
          status: "running",
        });
        return { sessionId: "sess_order", resumed: false };
      });
      runtime.prompt.mockImplementation((id) => {
        completion = service.completeRunForAgent(id, {
          status: "completed",
          summary: "Immediate success",
          tasks: [],
        });
        return {
          accepted: Promise.resolve(),
          settled: completion.then(() => {}),
        };
      });
      try {
        const result = await service.runJob({
          jobId:
            (await service.getJobByName("/tmp", "Launch ordering"))?.id ??
            "missing-job",
          wait: false,
        });
        expect(completion).toBeDefined();
        await expect(completion).resolves.toMatchObject({
          status: "completed",
        });
        expect(await store.getRun(result.runId)).toMatchObject({
          status: "completed",
          agentId: result.agentId,
        });
        expect(runtime.prompt).toHaveBeenCalledTimes(1);
      } finally {
        await service.shutdown();
      }
    });

    it("does not launch or prompt if owner attachment fails", async () => {
      await expect(
        manager.createAgent(
          { cwd: "/tmp", useWorktree: false, jobRunId: "run_not_attached" },
          {
            beforeLaunch: async () => {
              throw new Error("attachment failed");
            },
          }
        )
      ).rejects.toThrow("attachment failed");
      expect(runtime.launch).not.toHaveBeenCalled();
      expect(runtime.prompt).not.toHaveBeenCalled();
    });

    it("should keep the agent running when the first prompt is refused", async () => {
      runtime.prompt.mockImplementation(() => ({
        accepted: Promise.reject(new Error("busy")),
        settled: Promise.reject(new Error("busy")),
      }));
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
        initialPrompt: "Go",
      });
      expect(agent.status).toBe("running");
    });

    it("should mark the agent error and rethrow when the launch fails", async () => {
      runtime.launch.mockRejectedValueOnce(new Error("adapter not found"));

      await expect(
        manager.createAgent({ cwd: "/tmp", useWorktree: false })
      ).rejects.toThrow("Failed to create agent: adapter not found");

      const [failed] = await manager.listAgents();
      expect(failed!.status).toBe("error");
      expect(failed!.lastError).toBe("adapter not found");
      expect(failed!.setupPhase).toBeNull();
    });

    it("should reject engines the ACP runtime cannot drive without launching", async () => {
      await expect(
        manager.createAgent({ cwd: "/tmp", type: "cursor", useWorktree: false })
      ).rejects.toThrow(/not supported by the ACP runtime/);
      expect(runtime.launch).not.toHaveBeenCalled();
      const [failed] = await manager.listAgents();
      expect(failed!.status).toBe("error");
    });

    it("should create a worktree and launch the host inside it", async () => {
      vi.mocked(createGitWorktree).mockResolvedValueOnce({
        worktreePath: "/tmp",
        branchName: "agt_x/work",
      } as never);

      const agent = await manager.createAgent({
        name: "Work",
        cwd: "/tmp",
        baseBranch: "develop",
      });

      expect(createGitWorktree).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: "/tmp",
          baseBranch: "develop",
          createNewBranch: true,
          branchName: expect.stringMatching(/^agt_[a-z0-9]+\/work$/),
        })
      );
      expect(agent.status).toBe("running");
      expect(agent.worktreePath).toBe("/tmp");
      expect(agent.worktreeBranch).toBe("agt_x/work");
      expect(lastLaunch().cwd).toBe("/tmp");
    });

    it("should stop the agent without launching when the worktree cannot be created", async () => {
      vi.mocked(createGitWorktree).mockRejectedValueOnce(
        new GitWorktreeError("branch is already checked out", 409)
      );

      await expect(
        manager.createAgent({ cwd: "/tmp", worktreeBranch: "feat/x" })
      ).rejects.toMatchObject({ statusCode: 409 });

      expect(runtime.launch).not.toHaveBeenCalled();
      const [failed] = await manager.listAgents();
      expect(failed!.status).toBe("stopped");
      expect(failed!.lastError).toContain("Worktree creation failed");
      const card = await pool.query(
        "SELECT state->'startup' AS startup FROM blocks WHERE to_agent_id = $1 AND kind = 'launch'",
        [failed!.id]
      );
      expect(card.rows[0].startup).toMatchObject({
        failed: failed!.lastError,
        steps: [
          { phase: "worktree", status: "failed", detail: failed!.lastError },
        ],
      });
    });

    it("should use a custom name when provided", async () => {
      const agent = await manager.createAgent({
        name: "my-agent",
        cwd: "/tmp",
        useWorktree: false,
      });
      expect(agent.name).toBe("my-agent");
    });

    it("should generate a default name from ID suffix", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });
      expect(agent.name).toMatch(/^agent-/);
    });

    it("should support claude agent type", async () => {
      const agent = await manager.createAgent({
        type: "claude",
        cwd: "/tmp",
        useWorktree: false,
      });
      expect(agent.type).toBe("claude");
    });

    it("should persist reviewAgentType when provided", async () => {
      const agent = await manager.createAgent({
        type: "codex",
        reviewAgentType: "claude",
        cwd: "/tmp",
        useWorktree: false,
      });
      expect(agent.reviewAgentType).toBe("claude");
    });

    it("should store agentArgs", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        agentArgs: ["--model", "o3"],
        useWorktree: false,
      });
      expect(agent.agentArgs).toEqual(["--model", "o3"]);
    });

    describe("launch context in the Chat feed", () => {
      type CardRow = {
        id: string;
        author_kind: string;
        kind: string;
        text: string;
        delivered: boolean | null;
        origin: string | null;
        thread_id: string | null;
        launched_by_agent_id: string | null;
        state: Record<string, unknown> | null;
        attachments: Array<Record<string, unknown>>;
      };

      /** Every launch card written for the agent (there should be one). */
      async function launchCards(agentId: string): Promise<CardRow[]> {
        const result = await pool.query(
          `SELECT * FROM blocks WHERE to_agent_id = $1 AND kind = 'launch' ORDER BY created_at`,
          [agentId]
        );
        return result.rows as CardRow[];
      }

      /** The cards that carry a briefing: a prompt, files or links. */
      async function launchPosts(agentId: string): Promise<CardRow[]> {
        return (await launchCards(agentId)).filter(
          (card) => card.text !== "" || card.attachments.length > 0
        );
      }

      it("records the prompt, startup file and link as one delivered user post", async () => {
        const agent = await manager.createAgent({
          cwd: "/tmp",
          useWorktree: false,
          initialPrompt: "Build the widget",
          launchContext: {
            prompt: "Build the widget",
            links: ["https://example.com/spec"],
          },
          initialFiles: [
            {
              fileName: "brief.md",
              originalName: "brief.md",
              buffer: Buffer.from("# brief"),
              source: "text",
              mimeType: "text/markdown",
            },
          ],
        });
        const posts = await launchPosts(agent.id);
        expect(posts).toHaveLength(1);
        const seeded = await pool.query<{ id: number; file_name: string }>(
          `SELECT id, file_name FROM files WHERE agent_id = $1`,
          [agent.id]
        );
        // The briefing is on the agent's one card, with the startup and
        // instructions its launch wrote there too.
        expect(await launchCards(agent.id)).toHaveLength(1);
        expect(posts[0]).toMatchObject({
          id: launchBlockId(agent.id),
          author_kind: "user",
          kind: "launch",
          to_agent_id: agent.id,
          text: "Build the widget",
          delivered: true,
          origin: null,
          thread_id: null,
          launched_by_agent_id: null,
          attachments: [
            {
              type: "file",
              fileId: seeded.rows[0].id,
              fileName: seeded.rows[0].file_name,
              sizeBytes: 7,
            },
            { type: "link", url: "https://example.com/spec" },
          ],
        });
        expect(posts[0]!.state).toMatchObject({
          instructions: expect.any(String),
          startup: expect.objectContaining({ steps: expect.any(Array) }),
        });
        // The card is republished as the startup goes on; every copy that
        // carries the briefing is the one card, with the briefing on it.
        const published = launchChatEvents();
        expect(published.length).toBeGreaterThan(0);
        for (const event of published) {
          expect(event).toEqual(
            expect.objectContaining({
              type: "stream.entry",
              agentId: agent.id,
              entry: expect.objectContaining({
                type: "block",
                block: expect.objectContaining({
                  id: launchBlockId(agent.id),
                  kind: "launch",
                  text: "Build the widget",
                }),
              }),
            })
          );
        }
      });

      it("records no briefing for a bare launch, only its card", async () => {
        const bare = await manager.createAgent({
          cwd: "/tmp",
          useWorktree: false,
        });
        expect(await launchPosts(bare.id)).toEqual([]);
        expect(launchChatEvents()).toEqual([]);
        // The card is still there: the instructions and the startup it ran.
        const [card, ...rest] = await launchCards(bare.id);
        expect(rest).toEqual([]);
        expect(card).toMatchObject({
          id: launchBlockId(bare.id),
          author_kind: "user",
          text: "",
          attachments: [],
          delivered: true,
        });
        expect(card!.state).toMatchObject({ instructions: expect.any(String) });
      });

      it("attributes an agent-launched post to the launcher and uses the unwrapped prompt", async () => {
        const parent = await manager.createAgent({
          cwd: "/tmp",
          useWorktree: false,
        });
        const child = await manager.createAgent({
          cwd: "/tmp",
          useWorktree: false,
          parentAgentId: parent.id,
          launchedByAgentId: parent.id,
          initialPrompt: `You were launched by "${parent.id}".\n\nReview the diff`,
          launchContext: { prompt: "Review the diff" },
        });
        const posts = await launchPosts(child.id);
        expect(posts).toHaveLength(1);
        expect(posts[0]).toMatchObject({
          author_kind: "user",
          kind: "launch",
          text: "Review the diff",
          launched_by_agent_id: parent.id,
          delivered: true,
        });

        // child: false launches carry the launcher but no parent.
        const independent = await manager.createAgent({
          cwd: "/tmp",
          useWorktree: false,
          launchedByAgentId: parent.id,
          initialPrompt: "Go",
          launchContext: { prompt: "Go" },
        });
        expect((await launchPosts(independent.id))[0]).toMatchObject({
          launched_by_agent_id: parent.id,
          text: "Go",
        });
      });

      it("never attributes the post from parentAgentId alone", async () => {
        // The create route accepts parentAgentId from the request body, so
        // only the explicit launcher (set by agent-authenticated launch
        // paths) may name who the post reads as.
        const parent = await manager.createAgent({
          cwd: "/tmp",
          useWorktree: false,
        });
        const child = await manager.createAgent({
          cwd: "/tmp",
          useWorktree: false,
          parentAgentId: parent.id,
          initialPrompt: "Pretend I am the parent",
          launchContext: { prompt: "Pretend I am the parent" },
        });
        expect((await launchPosts(child.id))[0]).toMatchObject({
          author_kind: "user",
          text: "Pretend I am the parent",
          launched_by_agent_id: null,
        });
      });

      it("hands the engine the same post id and attachment lines as its first turn", async () => {
        const agent = await manager.createAgent({
          cwd: "/tmp",
          type: "claude",
          useWorktree: false,
          initialPrompt: "Build the widget",
          launchContext: {
            prompt: "Build the widget",
            links: ["https://example.com/spec"],
          },
          initialFiles: [
            {
              fileName: "brief.md",
              originalName: "brief.md",
              buffer: Buffer.from("# brief"),
              source: "text",
              mimeType: "text/markdown",
            },
          ],
        });
        const posts = await launchPosts(agent.id);
        expect(posts).toHaveLength(1);
        expect(posts[0]!.id).toBe(launchBlockId(agent.id));
        const [firstTurn] = promptsFor(agent.id);
        // The envelope names the card that was written, so the agent's reply
        // threads onto the launch card in the feed.
        expect(firstTurn).toContain(
          `--- DISPATCH POST (id: ${posts[0].id}, from: user) ---`
        );
        expect(firstTurn).toContain("--- END DISPATCH POST ---");
        expect(firstTurn).toContain("Build the widget");
        // Attachment lines come from the recorder, so turn and post agree.
        const seeded = await pool.query<{ file_name: string }>(
          `SELECT file_name FROM files WHERE agent_id = $1`,
          [agent.id]
        );
        expect(firstTurn).toContain(
          `- file: ${path.join(testConfig.filesRoot, agent.id, seeded.rows[0].file_name)} (text/markdown, 7 B)`
        );
        expect(firstTurn).toContain("- link: https://example.com/spec");
      });

      it("keeps generated startup prompts out of Chat and unwrapped", async () => {
        const agent = await manager.createAgent({
          cwd: "/tmp",
          type: "claude",
          useWorktree: false,
          initialPrompt: "Internal launch instructions",
        });
        expect(await launchPosts(agent.id)).toEqual([]);
        expect(promptsFor(agent.id)).toEqual(["Internal launch instructions"]);
        // The stream rule rides in the system prompt instead.
        expect(lastLaunch().systemPrompt).toContain(
          "The user reads your stream."
        );
      });

      it("never wraps a job run's first turn, and does not wait on its Chat write", async () => {
        const spy = createSpyRuntime();
        const stuck = managerWith({ runtime: spy });
        stuck.attachLaunchContextRecorder({
          prepareLaunchContext: () => new Promise(() => {}),
        });
        const startedAt = Date.now();
        const agent = await stuck.createAgent({
          cwd: "/tmp",
          useWorktree: false,
          initialPrompt: "Go",
          launchContext: { prompt: "Go" },
          jobRunId: "run_latency",
        });
        expect(spy.launch).toHaveBeenCalledTimes(1);
        expect(promptsFor(agent.id, spy)).toEqual(["Go"]);
        expect(await launchPosts(agent.id)).toEqual([]);
        // createAgent waits out the bounded detached write, never longer.
        expect(Date.now() - startedAt).toBeLessThan(
          LAUNCH_CONTEXT_WRITE_TIMEOUT_MS + 2_000
        );
      }, 20_000);

      it("launches unwrapped when the post never resolves", async () => {
        // Resolving the post is on the critical path (the first turn needs
        // its id), so a hung read gives up: no post, no envelope, and the
        // launch still happens.
        const warn = vi.fn();
        const spy = createSpyRuntime();
        const stuck = managerWith({ warn, runtime: spy });
        stuck.attachLaunchContextRecorder({
          prepareLaunchContext: () => new Promise(() => {}),
        });

        const agent = await stuck.createAgent({
          cwd: "/tmp",
          type: "claude",
          useWorktree: false,
          initialPrompt: "Go",
          launchContext: { prompt: "Go" },
        });
        expect(warn).toHaveBeenCalledWith(
          expect.objectContaining({
            agentId: agent.id,
            timeoutMs: LAUNCH_CONTEXT_RESOLVE_TIMEOUT_MS,
          }),
          expect.stringContaining("did not resolve in time")
        );
        expect(await launchPosts(agent.id)).toEqual([]);
        expect(promptsFor(agent.id, spy)).toEqual(["Go"]);
        expect(agent.status).toBe("running");
      }, 15_000);

      it("launches unwrapped when the post's write is rejected", async () => {
        // The envelope names a row; a rejected write means there is no row,
        // so naming it would point the agent's replies at nothing.
        const warn = vi.fn();
        const spy = createSpyRuntime();
        const failing = managerWith({ warn, runtime: spy });
        failing.attachLaunchContextRecorder({
          prepareLaunchContext: async () => ({
            id: "6a4f9e60-1111-4222-8333-444455556666",
            attachmentLines: [],
            record: async () => {
              throw new Error("db down");
            },
          }),
        });

        const agent = await failing.createAgent({
          cwd: "/tmp",
          type: "claude",
          useWorktree: false,
          initialPrompt: "Go",
        });
        expect(warn).toHaveBeenCalledWith(
          expect.objectContaining({ agentId: agent.id }),
          expect.stringContaining("launching without the Chat envelope")
        );
        expect(promptsFor(agent.id, spy)).toEqual(["Go"]);
      }, 15_000);

      it("launches unwrapped when the post's write never settles", async () => {
        const warn = vi.fn();
        const spy = createSpyRuntime();
        const hung = managerWith({ warn, runtime: spy });
        hung.attachLaunchContextRecorder({
          prepareLaunchContext: async () => ({
            id: "6a4f9e60-1111-4222-8333-444455556666",
            attachmentLines: [],
            record: () => new Promise(() => {}),
          }),
        });

        const agent = await hung.createAgent({
          cwd: "/tmp",
          type: "claude",
          useWorktree: false,
          initialPrompt: "Go",
        });
        expect(warn).toHaveBeenCalledWith(
          expect.objectContaining({
            agentId: agent.id,
            timeoutMs: LAUNCH_CONTEXT_WRITE_TIMEOUT_MS,
          }),
          expect.stringContaining("was not written in time")
        );
        expect(await launchPosts(agent.id)).toEqual([]);
        expect(promptsFor(agent.id, spy)).toEqual(["Go"]);
      }, 15_000);

      it("writes the briefing onto a card that was already there", async () => {
        // The card may predate the briefing (the startup steps write it
        // first, or an older card has an id of its own): the briefing fills
        // it in rather than failing on a taken id, and the first turn names
        // that card.
        const spy = createSpyRuntime();
        const early = managerWith({ runtime: spy });
        const chat = new StreamService({
          pool,
          publishUiEvent: (event) => chatEvents.push(event),
          getAgent: (id) => early.getAgent(id),
          filesRoot: testConfig.filesRoot,
        });
        const legacyId = "5a4f9e60-1111-4222-8333-444455556666";
        early.attachLaunchContextRecorder({
          prepareLaunchContext: async (input) => {
            await pool.query(
              `INSERT INTO blocks (id, stream_id, author_kind, to_agent_id, kind, text, state, delivered)
               VALUES ($1, $2, 'user', $2, 'launch', '', '{"instructions":"old"}'::jsonb, true)`,
              [legacyId, input.agentId]
            );
            return chat.prepareLaunchContext(input);
          },
        });

        const agent = await early.createAgent({
          cwd: "/tmp",
          type: "claude",
          useWorktree: false,
          initialPrompt: "Go",
          launchContext: { prompt: "Go" },
        });
        const cards = await launchCards(agent.id);
        expect(cards).toHaveLength(1);
        expect(cards[0]).toMatchObject({
          id: legacyId,
          text: "Go",
          state: { instructions: "old" },
        });
        const [firstTurn] = promptsFor(agent.id, spy);
        expect(firstTurn).toContain(
          `--- DISPATCH POST (id: ${legacyId}, from: user) ---`
        );
      }, 15_000);
    });

    it("should persist fullAccess", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        fullAccess: true,
        useWorktree: false,
      });
      expect(agent.fullAccess).toBe(true);
      expect(agent.agentArgs).toContain("--dangerously-skip-permissions");
    });

    it("should append the claude full access flag for direct launches", async () => {
      const agent = await manager.createAgent({
        type: "claude",
        cwd: "/tmp",
        fullAccess: true,
        useWorktree: false,
      });
      expect(agent.fullAccess).toBe(true);
      expect(agent.agentArgs).toContain("--dangerously-skip-permissions");
    });

    it("should persist baseBranch when provided", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        baseBranch: "feature/foo",
        useWorktree: false,
      });
      expect(agent.baseBranch).toBe("feature/foo");
    });

    it.each([false, true])(
      "normalizes origin bases before persistence (createNewBranch=%s)",
      async (createNewBranch) => {
        const agent = await manager.createAgent({
          cwd: "/tmp",
          name: "Origin base",
          baseBranch: "  origin/feature/x  ",
          useWorktree: true,
          createNewBranch,
          worktreeBranch: "origin/explicit-name",
        });
        expect(agent.baseBranch).toBe("feature/x");
        expect(agent.worktreeBranch).toBe(
          createNewBranch ? "origin/explicit-name" : "feature/x"
        );
        expect(createGitWorktree).toHaveBeenCalledWith(
          expect.objectContaining({
            baseBranch: "feature/x",
            createNewBranch,
            branchName: createNewBranch ? "origin/explicit-name" : undefined,
          })
        );
      }
    );

    it("normalizes origin bases for agents sharing a worktree", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        baseBranch: " origin/main ",
        useWorktree: false,
      });
      expect(agent.baseBranch).toBe("main");
    });

    it.each([
      "origin/",
      "origin/origin/main",
      " origin/origin/feature/x ",
      "origin/--all",
      "origin/ main",
      "origin/main;echo",
    ])(
      "rejects invalid base %s before creating an agent",
      async (baseBranch) => {
        await expect(
          manager.createAgent({ cwd: "/tmp", baseBranch })
        ).rejects.toMatchObject({ statusCode: 400 });
        expect(createGitWorktree).not.toHaveBeenCalled();
        const result = await pool.query("SELECT id FROM agents");
        expect(result.rows).toHaveLength(0);
      }
    );

    it("should default baseBranch to null when not provided for non-worktree agents", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });
      expect(agent.baseBranch).toBeNull();
    });

    it("should default baseBranch to main for worktree agents when not provided", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: true,
      });
      expect(agent.baseBranch).toBe("main");
    });

    it("should reject non-absolute paths", async () => {
      await expect(
        manager.createAgent({ cwd: "relative/path" })
      ).rejects.toThrow("absolute path");
    });

    it("should reject non-existent directories", async () => {
      await expect(
        manager.createAgent({ cwd: "/nonexistent-dispatch-test-dir" })
      ).rejects.toThrow("does not exist");
    });

    it("delivers a normal persona without review guidance and preserves it on restart", async () => {
      const cwd = await mkdtemp(
        path.join(os.tmpdir(), "dispatch-launch-persona-")
      );
      const worktreeRoot = vi
        .spyOn(gitContext, "resolveWorktreeRoot")
        .mockResolvedValue(cwd);
      const repoRoot = vi
        .spyOn(gitContext, "resolveRepoRoot")
        .mockResolvedValue(cwd);
      try {
        await upsertPersona({
          root: cwd,
          slug: "builder",
          name: "Builder",
          description: "Build features",
          type: "task",
          instructions: "Implement the requested feature and verify it.",
        });
        await pool.query(
          "INSERT INTO personalities (id, name, prompt) VALUES ('task-style', 'Task style', 'Keep answers terse.') ON CONFLICT (id) DO UPDATE SET prompt = EXCLUDED.prompt"
        );
        await pool.query(
          "INSERT INTO settings (key, value) VALUES ('active_personality_id', 'task-style') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value"
        );
        const agent = await manager.createAgent({
          cwd,
          useWorktree: false,
          persona: "builder",
          initialPrompt: "Build the thing",
        });
        expect(agent.persona).toBe("builder");
        expect(agent.role).toBe("standard");
        expect(lastLaunch().systemPrompt).toContain("Keep answers terse.");
        expect(lastLaunch().systemPrompt).toContain(
          "Name the session. Once the topic of work is clear"
        );
        expect(lastLaunch().personaContext).toBe(
          "Implement the requested feature and verify it."
        );
        expect(lastLaunch().systemPrompt).not.toContain("Feedback Guidelines");
        await manager.stopAgent(agent.id);
        await manager.startAgent(agent.id);
        expect(lastLaunch().personaContext).toBe(
          "Implement the requested feature and verify it."
        );
        await expect(
          manager.createAgent({
            cwd,
            useWorktree: false,
            persona: "code-review",
          })
        ).rejects.toThrow("not available for task launches");
      } finally {
        await pool.query(
          "DELETE FROM settings WHERE key = 'active_personality_id'"
        );
        worktreeRoot.mockRestore();
        repoRoot.mockRestore();
        await rm(cwd, { recursive: true, force: true });
      }
    });

    it("uses catalog definitions by default and local overrides for explicit workspace launches", async () => {
      const cwd = await mkdtemp(path.join(os.tmpdir(), "persona-source-"));
      const root = vi
        .spyOn(gitContext, "resolveWorktreeRoot")
        .mockResolvedValue(cwd);
      const catalog = vi.spyOn(personaCatalog, "get").mockResolvedValue({
        personas: [
          {
            slug: "builder",
            name: "Builder",
            type: "task",
            description: "",
            body: "Catalog body",
          },
        ],
        warnings: [],
        refreshing: false,
        updatedAt: Date.now(),
      });
      try {
        await upsertPersona({
          root: cwd,
          slug: "builder",
          name: "Builder",
          type: "task",
          description: "Workspace builder",
          instructions: "Workspace body",
        });
        const remote = await manager.createAgent({
          cwd,
          persona: "builder",
          useWorktree: false,
        });
        expect(lastLaunch().personaContext).toBe("Catalog body");
        await manager.stopAgent(remote.id);
        await manager.createAgent({
          cwd,
          persona: "builder",
          personaSource: "workspace",
          useWorktree: false,
        });
        expect(lastLaunch().personaContext).toBe("Workspace body");
        const before = await pool.query("SELECT count(*) FROM agents");
        await expect(
          manager.createAgent({ cwd, persona: "missing", useWorktree: false })
        ).rejects.toThrow('Persona "missing" not found');
        expect((await pool.query("SELECT count(*) FROM agents")).rows).toEqual(
          before.rows
        );
      } finally {
        catalog.mockRestore();
        root.mockRestore();
        await rm(cwd, { recursive: true, force: true });
      }
    });

    it("restarts a native worktree launch after persona setup fails before checkout preparation", async () => {
      const root = await mkdtemp(
        path.join(os.tmpdir(), "dispatch-worktree-intent-")
      );
      const cwd = path.join(root, "source");
      const worktreePath = path.join(root, "worktree");
      const config = {
        ...testConfig,
        agentStateRoot: path.join(root, "hosts"),
        filesRoot: path.join(root, "files"),
      };
      const firstRuntime = createSpyRuntime();
      const firstManager = new AgentManager(pool, noopLogger, config, {
        runtime: firstRuntime,
      });
      const catalog = vi
        .spyOn(personaCatalog, "get")
        .mockRejectedValueOnce(new Error("Persona lookup interrupted"));
      try {
        await Promise.all([mkdir(cwd), mkdir(worktreePath)]);
        const agent = await firstManager.createAgent(
          {
            cwd,
            persona: "builder",
            useWorktree: true,
            baseBranch: "develop",
            worktreeBranch: "session/retry",
          },
          { detachLaunch: true }
        );
        await vi.waitFor(async () =>
          expect(await firstManager.getAgent(agent.id)).toMatchObject({
            status: "error",
            lastError: "Persona lookup interrupted",
            cwd,
            worktreePath: null,
          })
        );
        expect(createGitWorktree).not.toHaveBeenCalled();
        expect(firstRuntime.launch).not.toHaveBeenCalled();

        vi.mocked(createGitWorktree).mockResolvedValueOnce({
          worktreePath,
          branchName: "session/retry",
        } as never);
        const retryRuntime = createSpyRuntime();
        const restartedManager = new AgentManager(pool, noopLogger, config, {
          runtime: retryRuntime,
        });
        expect(await restartedManager.startAgent(agent.id)).toMatchObject({
          status: "running",
          cwd: worktreePath,
          worktreePath,
          worktreeBranch: "session/retry",
        });
        expect(createGitWorktree).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            cwd,
            baseBranch: "develop",
            branchName: "session/retry",
          })
        );
        expect(retryRuntime.launch).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ cwd: worktreePath })
        );
      } finally {
        catalog.mockRestore();
        await rm(root, { recursive: true, force: true });
      }
    });

    it("settles a create interrupted after insert and prepares its checkout once on Start", async () => {
      const root = await mkdtemp(
        path.join(os.tmpdir(), "dispatch-create-crash-")
      );
      const cwd = path.join(root, "source");
      const worktreePath = path.join(root, "worktree");
      const config = {
        ...testConfig,
        agentStateRoot: path.join(root, "hosts"),
        filesRoot: path.join(root, "files"),
      };
      const firstRuntime = createSpyRuntime();
      const first = new AgentManager(pool, noopLogger, config, {
        runtime: firstRuntime,
      });
      // Suspend the old process at the last await before checkout preparation.
      const catalog = vi
        .spyOn(personaCatalog, "get")
        .mockImplementationOnce(() => new Promise(() => {}));
      try {
        await Promise.all([mkdir(cwd), mkdir(worktreePath)]);
        const agent = await first.createAgent(
          { cwd, persona: "builder", worktreeBranch: "recover/create" },
          { detachLaunch: true }
        );
        expect(agent).toMatchObject({ status: "creating", worktreePath: null });
        expect(createGitWorktree).not.toHaveBeenCalled();
        expect(firstRuntime.launch).not.toHaveBeenCalled();

        const retryRuntime = createSpyRuntime();
        retryRuntime.isAlive.mockResolvedValue(false);
        const restarted = new AgentManager(pool, noopLogger, config, {
          runtime: retryRuntime,
        });
        expect(await restarted.restoreRunningAgents()).toMatchObject({
          lost: [agent.id],
        });
        expect(await restarted.getAgent(agent.id)).toMatchObject({
          status: "stopped",
          worktreePath: null,
        });
        expect(createGitWorktree).not.toHaveBeenCalled();

        vi.mocked(createGitWorktree).mockResolvedValueOnce({
          worktreePath,
          branchName: "recover/create",
        } as never);
        expect(await restarted.startAgent(agent.id)).toMatchObject({
          status: "running",
          worktreePath,
          worktreeBranch: "recover/create",
        });
        expect(createGitWorktree).toHaveBeenCalledTimes(1);
        expect(retryRuntime.launch).toHaveBeenCalledTimes(1);
      } finally {
        catalog.mockRestore();
        await rm(root, { recursive: true, force: true });
      }
    });

    it.each([false, true])(
      "returns a creating row while a detached persona lookup is pending (missing=%s)",
      async (missing) => {
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        const catalog = vi
          .spyOn(personaCatalog, "get")
          .mockImplementation(async () => {
            await held;
            return {
              personas: missing
                ? []
                : [
                    {
                      slug: "builder",
                      name: "Builder",
                      type: "task",
                      description: "",
                      body: "Deferred body",
                    },
                  ],
              warnings: [],
              refreshing: false,
              updatedAt: Date.now(),
            };
          });
        try {
          const agent = await manager.createAgent(
            { cwd: "/tmp", persona: "builder", useWorktree: false },
            { detachLaunch: true }
          );
          expect(agent.status).toBe("creating");
          expect(runtime.launch).not.toHaveBeenCalled();
          release();
          await vi.waitFor(async () =>
            expect((await manager.getAgent(agent.id))?.status).toBe(
              missing ? "error" : "running"
            )
          );
          if (missing) {
            expect((await manager.getAgent(agent.id))?.lastError).toContain(
              'Persona "builder" not found'
            );
            expect(runtime.launch).not.toHaveBeenCalled();
          } else {
            expect(lastLaunch().personaContext).toBe("Deferred body");
            await manager.stopAgent(agent.id);
            await manager.startAgent(agent.id);
            expect(lastLaunch().personaContext).toBe("Deferred body");
          }
        } finally {
          release();
          catalog.mockRestore();
        }
      }
    );

    describe("system prompt", () => {
      const RENAME = "Name the session. Once the topic of work is clear";

      it("suggests a session name only for default-named agents", async () => {
        await manager.createAgent({ cwd: "/tmp", useWorktree: false });
        expect(lastLaunch().systemPrompt).toContain(RENAME);

        for (const input of [
          { name: "bug bash" },
          // Custom names that merely resemble the default pattern count too.
          { name: "agent-foobar" },
          {
            name: "security-review-123456",
            persona: "security-review",
            role: "review" as const,
            agentArgs: ["--dispatch-persona-context", "Review instructions"],
          },
        ]) {
          await manager.createAgent({
            cwd: "/tmp",
            type: "codex",
            useWorktree: false,
            ...input,
          });
          expect(lastLaunch().systemPrompt).not.toContain(RENAME);
        }
      });

      it("keeps persisted persona task context separate on launch and restart", async () => {
        const context = "Full persona rules\n".repeat(5000) + "FINAL BRIEFING";
        const agent = await manager.createAgent({
          cwd: "/tmp",
          type: "codex",
          useWorktree: false,
          persona: "reviewer",
          role: "review",
          agentArgs: [
            "--append-system-prompt",
            "Protected review instructions",
            "--dispatch-persona-context",
            context,
          ],
        });
        expect(lastLaunch().personaContext).toBe(context);
        expect(lastLaunch().systemPrompt).toContain(
          "Protected review instructions"
        );
        expect(lastLaunch().systemPrompt).not.toContain("FINAL BRIEFING");
        await manager.stopAgent(agent.id);
        await manager.startAgent(agent.id);
        expect(lastLaunch().personaContext).toBe(context);
      });

      it("folds an appended system prompt in, ahead of the active personality", async () => {
        await pool.query(
          `INSERT INTO personalities (id, name, prompt) VALUES ('p-formal', 'Formal', 'You are very formal.')
           ON CONFLICT (id) DO UPDATE SET prompt = EXCLUDED.prompt`
        );
        await pool.query(
          `INSERT INTO settings (key, value) VALUES ('active_personality_id', 'p-formal')
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`
        );
        try {
          await manager.createAgent({ cwd: "/tmp", useWorktree: false });
          expect(lastLaunch().systemPrompt).toContain("You are very formal.");

          await manager.createAgent({
            cwd: "/tmp",
            type: "codex",
            useWorktree: false,
            agentArgs: [
              "--append-system-prompt",
              "Persona review instructions",
            ],
          });
          expect(lastLaunch().systemPrompt).toContain(
            "Persona review instructions"
          );
          expect(lastLaunch().systemPrompt).not.toContain(
            "You are very formal."
          );
        } finally {
          await pool.query(
            `DELETE FROM settings WHERE key = 'active_personality_id'`
          );
        }
      });
    });
  });

  describe("getAgent / listAgents", () => {
    it("should return null for non-existent agent", async () => {
      const agent = await manager.getAgent("agt_does_not_exist");
      expect(agent).toBeNull();
    });

    it("should list created agents in descending order", async () => {
      await manager.createAgent({
        name: "first",
        cwd: "/tmp",
        useWorktree: false,
      });
      await manager.createAgent({
        name: "second",
        cwd: "/tmp",
        useWorktree: false,
      });

      const agents = await manager.listAgents();
      expect(agents.length).toBe(2);
      expect(agents[0].name).toBe("second");
      expect(agents[1].name).toBe("first");
    });

    it("should fetch a single agent by ID", async () => {
      const created = await manager.createAgent({
        name: "fetch-me",
        cwd: "/tmp",
        useWorktree: false,
      });
      const fetched = await manager.getAgent(created.id);

      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(created.id);
      expect(fetched!.name).toBe("fetch-me");
    });

    it("should rename an agent", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });

      const renamed = await manager.renameAgent(
        agent.id,
        "Investigate flaky e2e"
      );

      expect(renamed.name).toBe("Investigate flaky e2e");
    });

    it("should reject empty agent names when renaming", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });

      await expect(manager.renameAgent(agent.id, "   ")).rejects.toThrow(
        "Agent name must not be empty."
      );
    });

    it("should update reviewAgentType", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });

      await manager.updateReviewAgentType(agent.id, "claude");
      const updated = await manager.getAgent(agent.id);

      expect(updated?.reviewAgentType).toBe("claude");
    });
  });

  describe("getTerminalAccess", () => {
    it("should report live access while the host is alive", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });
      await expect(manager.getTerminalAccess(agent.id)).resolves.toEqual({
        mode: "live",
      });
      expect(runtime.isAlive).toHaveBeenCalledWith(agent.id);
    });

    it("should return inert metadata when the runtime has no processes", async () => {
      const inertManager = new AgentManager(pool, noopLogger, inertTestConfig);
      const agent = await inertManager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });

      const access = await inertManager.getTerminalAccess(agent.id);

      expect(access.mode).toBe("inert");
      expect(access.mode === "inert" && access.message).toContain("inert mode");
    });

    it("should mark a running agent stopped when its host is gone", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });
      runtime.isAlive.mockResolvedValue(false);

      await expect(manager.getTerminalAccess(agent.id)).rejects.toMatchObject({
        statusCode: 409,
      });
      const fetched = await manager.getAgent(agent.id);
      expect(fetched!.status).toBe("stopped");
      expect(fetched!.lastError).toContain("no longer running");
    });

    it("should refuse, without stopping it, an agent still starting", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });
      await pool.query(`UPDATE agents SET status = 'creating' WHERE id = $1`, [
        agent.id,
      ]);
      runtime.isAlive.mockResolvedValue(false);

      await expect(manager.getTerminalAccess(agent.id)).rejects.toThrow(
        "Agent is still starting."
      );
      expect((await manager.getAgent(agent.id))!.status).toBe("creating");
    });

    it("should refuse a stopped agent without asking the runtime", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });
      await manager.stopAgent(agent.id);
      runtime.isAlive.mockClear();

      await expect(manager.getTerminalAccess(agent.id)).rejects.toThrow(
        "Agent is not running."
      );
      expect(runtime.isAlive).not.toHaveBeenCalled();
    });
  });

  describe("prompting", () => {
    it("should pass prompts, the busy state and cancel through to the runtime", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });
      const turn = {
        accepted: Promise.resolve(),
        settled: Promise.resolve(),
      };
      runtime.prompt.mockReturnValueOnce(turn);
      runtime.isBusy.mockReturnValueOnce(true);

      expect(manager.promptAgent(agent.id, "next")).toBe(turn);
      expect(runtime.prompt).toHaveBeenLastCalledWith(
        agent.id,
        "next",
        undefined,
        undefined
      );
      // What the prompt is travels with it, for the turn it opens.
      const source = {
        source: "chat" as const,
        chatMessageId: "11111111-2222-4333-8444-555555555555",
      };
      runtime.prompt.mockReturnValueOnce(turn);
      manager.promptAgent(agent.id, "next", source);
      expect(runtime.prompt).toHaveBeenLastCalledWith(
        agent.id,
        "next",
        source,
        undefined
      );
      manager.promptAgent(agent.id, "cut in", source, { alone: true });
      expect(runtime.prompt).toHaveBeenLastCalledWith(
        agent.id,
        "cut in",
        source,
        { alone: true }
      );
      expect(manager.isPromptHeld(agent.id)).toBe(true);
      await manager.cancelTurn(agent.id);
      expect(runtime.cancel).toHaveBeenCalledWith(agent.id);
    });
  });

  describe("runtime events", () => {
    it("only notifies for newly pending permissions across reconnect snapshots", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });
      const attention = vi.fn();
      const updated = vi.fn();
      manager.onAttention(attention);
      manager.onAgentUpdated(updated);
      const request = (id: string) => ({
        id,
        toolCallId: id,
        title: `Operation ${id}`,
        details: "",
        createdAt: new Date().toISOString(),
        options: [],
      });
      const a = request("a");
      const b = request("b");
      const snapshot = (requests: (typeof a)[]) =>
        runtime.emit(
          agent.id,
          { type: "permissions", agentId: agent.id, requests },
          0
        );
      await snapshot([a]);
      await snapshot([a]); // host reconnect
      await snapshot([a, b]);
      await snapshot([a]); // answering B must not re-alert A
      await snapshot([]);
      expect(attention.mock.calls.map(([event]) => event.message)).toEqual([
        "Approval needed: Operation a",
        "Approval needed: Operation b",
      ]);
      expect(updated).toHaveBeenCalledTimes(5);
      await snapshot([request("c")]);
      expect(attention).toHaveBeenCalledTimes(3);
      expect(attention).toHaveBeenLastCalledWith(
        expect.objectContaining({
          type: "waiting_user",
          message: "Approval needed: Operation c",
        })
      );
    });

    it("should advance host_seq and fold turns into stream rows", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });

      await runtime.emit(
        agent.id,
        { type: "turn", agentId: agent.id, state: "started", text: "hello" },
        7
      );

      const seq = await pool.query<{ host_seq: number }>(
        `SELECT host_seq FROM agents WHERE id = $1`,
        [agent.id]
      );
      expect(Number(seq.rows[0]!.host_seq)).toBe(7);
      const turns = await pool.query<{ payload: { state: string } }>(
        `SELECT payload FROM agent_stream_events WHERE agent_id = $1 AND kind = 'turn'`,
        [agent.id]
      );
      expect(turns.rows.map((row) => row.payload.state)).toEqual(["started"]);

      // seq 0 is synthesized for a vanished host and never moves the watermark.
      await runtime.emit(
        agent.id,
        { type: "turn", agentId: agent.id, state: "settled" },
        0
      );
      const after = await pool.query<{ host_seq: number }>(
        `SELECT host_seq FROM agents WHERE id = $1`,
        [agent.id]
      );
      expect(Number(after.rows[0]!.host_seq)).toBe(7);
    });

    it("derives working, waiting and idle from the turn lifecycle", async () => {
      const { BlockStore } = await import("../../src/chat/store.js");
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });

      await runtime.emit(
        agent.id,
        {
          type: "turn",
          agentId: agent.id,
          state: "started",
          text: "Fix the login bug\nDetails follow.",
        },
        1
      );

      await runtime.emit(
        agent.id,
        { type: "turn", agentId: agent.id, state: "settled" },
        2
      );

      const store = new BlockStore(pool);
      await store.insert({
        streamId: agent.id,
        author: { kind: "agent", agentId: agent.id },
        kind: "question",
        text: "Ship it?",
        data: { options: [{ label: "Yes" }] },
        state: {},
      });
      const userMessage = await store.insert({
        streamId: agent.id,
        author: { kind: "user" },
        toAgentId: agent.id,
        kind: "text",
        text: "Please also update the docs",
      });
      await runtime.emit(
        agent.id,
        {
          type: "turn",
          agentId: agent.id,
          state: "started",
          text: `--- DISPATCH POST (id: ${userMessage.id}, from: user) ---\nPlease also update the docs\n--- END DISPATCH POST ---`,
        },
        3
      );

      await runtime.emit(
        agent.id,
        { type: "turn", agentId: agent.id, state: "settled" },
        4
      );

      await runtime.emit(
        agent.id,
        { type: "turn", agentId: agent.id, state: "started", text: "x" },
        5
      );
      await runtime.emit(
        agent.id,
        {
          type: "turn",
          agentId: agent.id,
          state: "settled",
          error: "rate limited",
        },
        6
      );
    });

    it("marks the agent waiting as soon as it posts a question", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });
      await manager.noteQuestionPosted(agent.id, "Which branch?\nmain or dev");
    });

    it("tells its listeners once when an engine's model list changes the catalog", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });
      const learned: string[] = [];
      manager.onModelsLearned((agentType) => learned.push(agentType));
      const config = {
        type: "config" as const,
        catalogSource: "engine" as const,
        agentId: agent.id,
        options: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select" as const,
            currentValue: "claude-opus-5",
            options: [
              { value: "claude-opus-5", name: "Opus 5" },
              { value: "claude-sonnet-5", name: "Sonnet 5" },
            ],
          },
        ],
      };
      try {
        await runtime.emit(agent.id, config, 4);
        // The same list again is not news: no second event.
        await runtime.emit(agent.id, config, 5);
        expect(learned).toEqual(["claude"]);
      } finally {
        forgetLearnedAgentModels();
      }
    });

    it("should put a running agent into error when its engine exits unexpectedly", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });
      const upserts: string[] = [];
      manager.onAgentUpdated((record) => upserts.push(record.status));

      await runtime.emit(
        agent.id,
        {
          type: "exit",
          agentId: agent.id,
          code: 1,
          signal: null,
          stderrTail: "panic: boom",
          expected: false,
        },
        3
      );

      const fetched = await manager.getAgent(agent.id);
      expect(fetched!.status).toBe("error");
      expect(fetched!.lastError).toBe(
        "The agent exited with code 1: panic: boom"
      );
      expect(upserts).toContain("error");
    });

    it("should leave the agent alone for an expected exit", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });
      await runtime.emit(
        agent.id,
        {
          type: "exit",
          agentId: agent.id,
          code: 0,
          signal: null,
          stderrTail: "",
          expected: true,
        },
        4
      );
      expect((await manager.getAgent(agent.id))!.status).toBe("running");
    });

    it("keeps tool locations absolute after an exit, even when the Git context refreshes, like main", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });
      const file = path.join(agent.cwd, "README.md");
      const readTool = (toolCallId: string) =>
        runtime.emit(
          agent.id,
          {
            type: "update",
            agentId: agent.id,
            update: {
              sessionUpdate: "tool_call",
              toolCallId,
              title: "Read README.md",
              kind: "read",
              status: "completed",
              locations: [{ path: file }],
            },
          } as never,
          0
        );
      const located = async (toolCallId: string) =>
        (
          await pool.query<{ payload: { locations: { path: string }[] } }>(
            `SELECT payload FROM agent_stream_events
              WHERE agent_id = $1 AND kind = 'tool_call' AND key = $2`,
            [agent.id, toolCallId]
          )
        ).rows[0]?.payload.locations;

      await readTool("before-exit");
      expect(await located("before-exit")).toEqual([{ path: "README.md" }]);

      await runtime.emit(
        agent.id,
        {
          type: "exit",
          agentId: agent.id,
          code: 0,
          signal: null,
          stderrTail: "",
          expected: true,
        },
        0
      );
      await manager.populateGitContext(agent.id);
      await readTool("after-exit");
      expect(await located("after-exit")).toEqual([{ path: file }]);
    });
  });

  describe("activity", () => {
    async function running() {
      return manager.createAgent({ cwd: "/tmp", useWorktree: false });
    }

    async function activityOf(id: string) {
      const one = (await manager.getAgent(id))!.activity;
      const listed = (await manager.listAgents()).find((a) => a.id === id)!;
      expect(listed.activity).toBe(one);
      return one;
    }

    it("reads idle for a running agent with nothing going on", async () => {
      const agent = await running();
      expect(await activityOf(agent.id)).toBe("idle");
    });

    it("reads working while the runtime has a turn running", async () => {
      const agent = await running();
      runtime.hasOpenTurn.mockImplementation((id) => id === agent.id);
      expect(await activityOf(agent.id)).toBe("working");
      runtime.hasOpenTurn.mockImplementation(() => false);
      expect(await activityOf(agent.id)).toBe("idle");
    });

    it("does not report working when prompts are queued but no turn is open", async () => {
      const agent = await running();
      runtime.isBusy.mockImplementation((id) => id === agent.id);
      expect(await activityOf(agent.id)).toBe("idle");
    });

    describe("current turn", () => {
      /** An open turn whose block sits under `threadId`, if given. */
      async function openTurn(agentId: string, threadId?: string) {
        const { BlockStore } = await import("../../src/chat/store.js");
        const store = new BlockStore(pool);
        await runtime.emit(
          agentId,
          { type: "turn", agentId, state: "started", text: "go" },
          1
        );
        const block = await store.insert({
          streamId: agentId,
          author: { kind: "agent", agentId },
          kind: "text",
          text: "",
          ...(threadId ? { threadId, replyTo: threadId } : {}),
        });
        await pool.query(
          `UPDATE agent_stream_events SET payload = payload || jsonb_build_object('blockId', $2::text)
            WHERE agent_id = $1 AND kind = 'turn'`,
          [agentId, block.id]
        );
        return block;
      }

      async function currentTurnOf(id: string) {
        const one = (await manager.getAgent(id))!.currentTurn;
        const listed = (await manager.listAgents()).find((a) => a.id === id)!;
        expect(listed.currentTurn).toEqual(one);
        return one;
      }

      it("names the open turn's block only while ACP has a live turn", async () => {
        const agent = await running();
        const block = await openTurn(agent.id);
        expect(await currentTurnOf(agent.id)).toBeNull();
        runtime.hasOpenTurn.mockImplementation((id) => id === agent.id);
        expect(await currentTurnOf(agent.id)).toEqual({
          streamId: agent.id,
          blockId: block.id,
          threadId: null,
        });
      });

      it("clears an unsettled turn label when only queued prompts remain", async () => {
        const agent = await running();
        await openTurn(agent.id);
        runtime.isBusy.mockImplementation((id) => id === agent.id);
        expect(await currentTurnOf(agent.id)).toBeNull();
        expect(await activityOf(agent.id)).toBe("idle");
      });

      it("does not gate the ACP turn on derived activity", async () => {
        const agent = await running();
        const block = await openTurn(agent.id);
        await pool.query(
          `UPDATE agents SET setup_phase = 'session' WHERE id = $1`,
          [agent.id]
        );
        runtime.hasOpenTurn.mockImplementation((id) => id === agent.id);

        expect(await activityOf(agent.id)).toBe("starting");
        expect(await currentTurnOf(agent.id)).toEqual({
          streamId: agent.id,
          blockId: block.id,
          threadId: null,
        });
      });

      it("carries the thread the turn's block sits in", async () => {
        const { BlockStore } = await import("../../src/chat/store.js");
        const agent = await running();
        const root = await new BlockStore(pool).insert({
          streamId: agent.id,
          author: { kind: "user" },
          kind: "text",
          text: "launch",
        });
        const block = await openTurn(agent.id, root.id);
        runtime.hasOpenTurn.mockImplementation((id) => id === agent.id);
        expect(await currentTurnOf(agent.id)).toEqual({
          streamId: agent.id,
          blockId: block.id,
          threadId: root.id,
        });
      });

      it("is null once the newest turn settled, even with prompts queued", async () => {
        const agent = await running();
        await openTurn(agent.id);
        await pool.query(
          `UPDATE agent_stream_events SET payload = payload || '{"state": "settled"}'
            WHERE agent_id = $1 AND kind = 'turn'`,
          [agent.id]
        );
        runtime.isBusy.mockImplementation((id) => id === agent.id);
        expect(await activityOf(agent.id)).toBe("idle");
        expect(await currentTurnOf(agent.id)).toBeNull();
      });
    });

    it("reads waiting while a question for people is open", async () => {
      const { BlockStore } = await import("../../src/chat/store.js");
      const agent = await running();
      const store = new BlockStore(pool);
      const question = await store.insert({
        streamId: agent.id,
        author: { kind: "agent", agentId: agent.id },
        kind: "question",
        text: "Ship it?",
        data: { options: [{ label: "Yes" }] },
        state: {},
      });
      expect(await activityOf(agent.id)).toBe("waiting");

      await pool.query(
        `UPDATE blocks SET state = '{"answer": {"value": "Yes"}}' WHERE id = $1`,
        [question.id]
      );
      expect(await activityOf(agent.id)).toBe("idle");
    });

    it("reads stopped when a turn was interrupted by a stop", async () => {
      const agent = await running();
      await runtime.emit(
        agent.id,
        { type: "turn", agentId: agent.id, state: "started", text: "go" },
        1
      );
      await pool.query(`UPDATE agents SET status = 'stopped' WHERE id = $1`, [
        agent.id,
      ]);
      const fetched = (await manager.getAgent(agent.id))!;
      expect(fetched.status).toBe("stopped");
      // Even if the runtime still counts the turn, a stopped agent is stopped.
      runtime.isBusy.mockImplementation(() => true);
      expect(await activityOf(agent.id)).toBe("stopped");
    });

    it("reads blocked after a failed turn until another turn runs", async () => {
      const agent = await running();
      await runtime.emit(
        agent.id,
        { type: "turn", agentId: agent.id, state: "started", text: "x" },
        1
      );
      await runtime.emit(
        agent.id,
        { type: "turn", agentId: agent.id, state: "settled", error: "boom" },
        2
      );
      expect(await activityOf(agent.id)).toBe("blocked");

      await runtime.emit(
        agent.id,
        { type: "turn", agentId: agent.id, state: "started", text: "again" },
        3
      );
      await runtime.emit(
        agent.id,
        { type: "turn", agentId: agent.id, state: "settled" },
        4
      );
      expect(await activityOf(agent.id)).toBe("idle");
    });

    it("does not read a turn cut by a restart as blocked", async () => {
      const agent = await running();
      await runtime.emit(
        agent.id,
        { type: "turn", agentId: agent.id, state: "started", text: "x" },
        1
      );
      await pool.query(
        `UPDATE agent_stream_events
            SET payload = payload || '{"state": "settled", "error": "interrupted by restart"}'
          WHERE agent_id = $1 AND kind = 'turn'`,
        [agent.id]
      );
      expect(await activityOf(agent.id)).toBe("idle");
    });

    it("does not read a turn cut by archiving or stopping as blocked", async () => {
      const agent = await running();
      await runtime.emit(
        agent.id,
        { type: "turn", agentId: agent.id, state: "started", text: "x" },
        1
      );
      await pool.query(
        `UPDATE agent_stream_events
            SET payload = payload || '{"state": "settled", "error": "stopped"}'
          WHERE agent_id = $1 AND kind = 'turn'`,
        [agent.id]
      );
      expect(await activityOf(agent.id)).toBe("idle");
    });

    it("reads blocked for an agent in error", async () => {
      const agent = await running();
      await pool.query(`UPDATE agents SET status = 'error' WHERE id = $1`, [
        agent.id,
      ]);
      expect(await activityOf(agent.id)).toBe("blocked");
    });

    it("reads starting while the agent is being created or set up", async () => {
      const agent = await running();
      await pool.query(`UPDATE agents SET status = 'creating' WHERE id = $1`, [
        agent.id,
      ]);
      expect(await activityOf(agent.id)).toBe("starting");
      await pool.query(
        `UPDATE agents SET status = 'running', setup_phase = 'deps' WHERE id = $1`,
        [agent.id]
      );
      expect(await activityOf(agent.id)).toBe("starting");
    });
  });

  describe("archiveAgent", () => {
    /** Helper: run the full beginArchive + executeArchive flow and wait for completion. */
    async function archiveAgent(
      id: string,
      cleanupWorktree: "auto" | "keep" | "force" = "auto"
    ): Promise<void> {
      await manager.beginArchive(id, cleanupWorktree);
      await new Promise<void>((resolve, reject) => {
        void manager.executeArchive(id, {
          onPhaseChange: () => {},
          onComplete: () => resolve(),
          onError: (err) => reject(err),
        });
      });
    }

    it.each(["standard", "review"] as const)(
      "reconciles an old borrower-deferred local archive with a live %s agent",
      async (role) => {
        const repo = await realpath(
          await mkdtemp(path.join(os.tmpdir(), "archive-retry-"))
        );
        const tree = path.join(repo, "linked");
        const git = (...args: string[]) =>
          execFileSync("git", args, {
            cwd: repo,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          }).trim();
        try {
          git("init", "-b", "main");
          git(
            "-c",
            "user.name=Dispatch Test",
            "-c",
            "user.email=test@example.test",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "--allow-empty",
            "-m",
            "Initial"
          );
          git("worktree", "add", "-b", "feature", tree);
          await pool.query(
            `INSERT INTO agents
              (id, name, cwd, status, worktree_path, worktree_branch, base_branch,
               deleted_at, runner_cleanup_pending, archive_cleanup_mode, archive_checkout_state)
             VALUES ('pending-owner', 'Owner', $1, 'stopped', $2, 'feature', 'main',
               NOW(), true, 'force', $3)`,
            [repo, tree, "1".repeat(64)]
          );
          await pool.query(
            `INSERT INTO agents (id, name, cwd, status, role)
             VALUES ('active-borrower', 'Borrower', $1, 'stopped', $2)`,
            [tree, role]
          );
          const commandModule = "../../src/shared/lib/run-command.js";
          const { runCommand } =
            await import("../../src/shared/lib/run-command.js");
          const actual = await vi.importActual<{
            runCommand: typeof runCommand;
          }>(commandModule);
          const original = vi.mocked(runCommand).getMockImplementation()!;
          await vi.mocked(runCommand).withImplementation(
            (command, args, options) =>
              command === "git" &&
              args[0] === "-C" &&
              [repo, tree].includes(args[1] ?? "")
                ? actual.runCommand(command, args, options)
                : original(command, args, options),
            async () => {
              await manager.reconcileAgentStatuses();
              await vi.waitFor(async () => {
                const {
                  rows: [row],
                } = await pool.query(
                  `SELECT runner_cleanup_pending, archive_cleanup_mode, archive_checkout_state
                   FROM agents WHERE id = 'pending-owner'`
                );
                expect(row).toEqual({
                  runner_cleanup_pending: false,
                  archive_cleanup_mode: null,
                  archive_checkout_state: null,
                });
              });
            }
          );
          expect(Boolean(await realpath(tree).catch(() => null))).toBe(
            role === "review"
          );
          expect(Boolean(git("branch", "--list", "feature"))).toBe(
            role === "review"
          );
        } finally {
          await rm(repo, { recursive: true, force: true });
        }
      }
    );

    it("should soft-delete an agent", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });

      // Stop first so beginArchive doesn't need force
      await manager.stopAgent(agent.id, { force: true });
      await archiveAgent(agent.id);

      // getAgent filters out soft-deleted agents
      const fetched = await manager.getAgent(agent.id);
      expect(fetched).toBeNull();

      // But the row still exists in the database with deleted_at set
      const row = await pool.query(
        "SELECT deleted_at FROM agents WHERE id = $1",
        [agent.id]
      );
      expect(row.rowCount).toBe(1);
      expect(row.rows[0].deleted_at).not.toBeNull();
    });

    it("settles the turn an agent was in when archived as stopped, not failed", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });
      await runtime.emit(
        agent.id,
        { type: "turn", agentId: agent.id, state: "started", text: "x" },
        1
      );
      // Tearing the session down fails the prompt in flight, as the host does.
      runtime.stop.mockImplementationOnce(async (id) => {
        await runtime.emit(
          id,
          {
            type: "turn",
            agentId: id,
            state: "settled",
            error: "Session closed",
          },
          2
        );
      });
      await archiveAgent(agent.id);

      const rows = await pool.query<{ kind: string; payload: unknown }>(
        "SELECT kind, payload FROM agent_stream_events WHERE agent_id = $1 ORDER BY seq",
        [agent.id]
      );
      const turns = rows.rows.filter((r) => r.kind === "turn");
      expect(turns).toHaveLength(1);
      expect(turns[0]!.payload).toMatchObject({
        state: "settled",
        error: "stopped",
      });
      // The teardown's own error is not a status line, and not "blocked".
      expect(rows.rows.filter((r) => r.kind === "status")).toHaveLength(0);
    });

    it("settles the turn an agent was in when stopped as stopped", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });
      await runtime.emit(
        agent.id,
        { type: "turn", agentId: agent.id, state: "started", text: "x" },
        1
      );
      await manager.stopAgent(agent.id, { force: true });
      const rows = await pool.query<{ payload: unknown }>(
        "SELECT payload FROM agent_stream_events WHERE agent_id = $1 AND kind = 'turn'",
        [agent.id]
      );
      expect(rows.rows[0]!.payload).toMatchObject({
        state: "settled",
        error: "stopped",
      });
    });

    it("should exclude soft-deleted agents from listAgents", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });
      await manager.stopAgent(agent.id, { force: true });
      await archiveAgent(agent.id);

      const agents = await manager.listAgents();
      expect(agents.find((a) => a.id === agent.id)).toBeUndefined();
    });

    it("should preserve file rows after soft delete", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });

      // Insert a file row directly
      await pool.query(
        `INSERT INTO files (agent_id, file_name, source, size_bytes, mime_type) VALUES ($1, 'test.png', 'screenshot', 100, 'image/png')`,
        [agent.id]
      );
      await pool.query(
        `INSERT INTO files_seen (agent_id, file_key) VALUES ($1, 'test.png')`,
        [agent.id]
      );

      await archiveAgent(agent.id);

      // File rows are preserved since soft delete doesn't trigger CASCADE
      const remaining = await pool.query(
        "SELECT * FROM files WHERE agent_id = $1",
        [agent.id]
      );
      const seen = await pool.query(
        "SELECT * FROM files_seen WHERE agent_id = $1",
        [agent.id]
      );
      expect(remaining.rowCount).toBe(1);
      expect(seen.rowCount).toBe(1);
    });

    it("should force-stop the host and discard its state when archiving", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });
      const discard = vi.spyOn(runtime, "discard");

      await archiveAgent(agent.id);

      expect(runtime.stop).toHaveBeenCalledWith(agent.id, true);
      expect(discard).toHaveBeenCalledWith(agent.id);
      expect(await manager.getAgent(agent.id)).toBeNull();
    });

    it("should throw 404 for non-existent agent", async () => {
      try {
        await manager.beginArchive("agt_nonexistent");
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(AgentError);
        expect((err as InstanceType<typeof AgentError>).statusCode).toBe(404);
      }
    });

    it("should set status to archiving during beginArchive", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });
      await manager.stopAgent(agent.id, { force: true });

      const archiving = await manager.beginArchive(agent.id);
      expect(archiving.status).toBe("archiving");
      expect(archiving.archivePhase).toBe("stopping");
    });

    it("should reject archiving an already-archiving agent", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });
      await manager.stopAgent(agent.id, { force: true });
      await manager.beginArchive(agent.id);

      try {
        await manager.beginArchive(agent.id);
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(AgentError);
        expect((err as InstanceType<typeof AgentError>).statusCode).toBe(409);
      }
    });
  });
  describe("stopAgent", () => {
    it("keeps lifecycle controls working when schedule cancellation fails", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });
      manager.attachScheduleCancellation(async () => {
        throw new Error("scheduler unavailable");
      });
      await manager.cancelTurn(agent.id);
      expect(runtime.cancel).toHaveBeenCalledWith(agent.id);
      const stopped = await manager.stopAgent(agent.id, { force: true });
      expect(stopped.status).toBe("stopped");
      const archived = await manager.beginArchive(agent.id);
      expect(archived.status).toBe("archiving");
    });
    it("should stop the host and settle open turns", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });
      await runtime.emit(
        agent.id,
        { type: "turn", agentId: agent.id, state: "started", text: "go" },
        1
      );

      const stopped = await manager.stopAgent(agent.id, { force: true });

      expect(stopped.status).toBe("stopped");
      expect(runtime.stop).toHaveBeenCalledWith(agent.id, true);
      const turns = await pool.query<{
        payload: { state: string; error?: string };
      }>(
        `SELECT payload FROM agent_stream_events WHERE agent_id = $1 AND kind = 'turn'`,
        [agent.id]
      );
      expect(turns.rows[0]!.payload).toMatchObject({
        state: "settled",
        error: "stopped",
      });
    });

    it("should pass a graceful stop through by default", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });
      await manager.stopAgent(agent.id);
      expect(runtime.stop).toHaveBeenCalledWith(agent.id, false);
    });

    it("should be a no-op for already stopped agent", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });
      await manager.stopAgent(agent.id, { force: true });
      runtime.stop.mockClear();

      const result = await manager.stopAgent(agent.id);
      expect(result.status).toBe("stopped");
      expect(runtime.stop).not.toHaveBeenCalled();
    });

    it("should put the agent into error when the host will not stop", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });
      runtime.stop.mockRejectedValueOnce(new Error("socket hung"));

      await expect(manager.stopAgent(agent.id)).rejects.toThrow(
        "Failed to stop agent: socket hung"
      );
      const failed = await manager.getAgent(agent.id);
      expect(failed!.status).toBe("error");
      expect(failed!.lastError).toBe("socket hung");
    });
  });

  describe("restartHost", () => {
    it("restarts the host without a Stop's side effects", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });
      const cancel = vi.fn(async () => {});
      manager.attachScheduleCancellation(cancel);
      runtime.launch.mockClear();

      const restarted = await manager.restartHost(agent.id);

      expect(restarted.status).toBe("running");
      expect(runtime.stop).toHaveBeenCalledWith(agent.id, false);
      expect(runtime.launch).toHaveBeenCalledTimes(1);
      // Schedules belong to the agent's work, which a sign-in leaves alone.
      expect(cancel).not.toHaveBeenCalled();
    });

    it("starts a stopped agent", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });
      await manager.stopAgent(agent.id, { force: true });
      runtime.stop.mockClear();
      runtime.launch.mockClear();

      const restarted = await manager.restartHost(agent.id);

      expect(restarted.status).toBe("running");
      expect(runtime.stop).not.toHaveBeenCalled();
      expect(runtime.launch).toHaveBeenCalledTimes(1);
    });
  });

  describe("startAgent", () => {
    async function createStoppedAgent(
      opts: {
        type?: "claude" | "codex";
        persona?: string;
        role?: "standard" | "review";
        agentArgs?: string[];
      } = {}
    ) {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        type: opts.type ?? "claude",
        useWorktree: false,
        persona: opts.persona,
        role: opts.role,
        agentArgs: opts.agentArgs,
      });
      await manager.stopAgent(agent.id, { force: true });
      runtime.launch.mockClear();
      return (await manager.getAgent(agent.id))!;
    }

    it("should reattach to a host that is still running without relaunching", async () => {
      const agent = await createStoppedAgent();
      runtime.attach.mockResolvedValueOnce(true);

      const started = await manager.startAgent(agent.id);

      expect(runtime.attach).toHaveBeenCalledWith(agent.id);
      expect(runtime.launch).not.toHaveBeenCalled();
      expect(started.status).toBe("running");
    });

    it("should relaunch resuming the stored ACP session", async () => {
      const agent = await createStoppedAgent();
      expect(agent.cliSessionId).toBe("sess_1");

      const started = await manager.startAgent(agent.id);

      expect(lastLaunch()).toMatchObject({
        agentId: agent.id,
        resumeSessionId: "sess_1",
      });
      expect(started.status).toBe("running");
      expect(started.cliSessionId).toBe("sess_1");
      expect(started.lastError).toBeNull();
    });

    it("preserves a resumed job's run-scoped guidance and MCP credentials", async () => {
      const agent = await createStoppedAgent({ type: "codex" });
      await pool.query(`INSERT INTO jobs (id, directory, name, enabled, agent_type, use_worktree, full_access, timeout_ms, needs_input_timeout_ms, auto_archive)
        VALUES ('job_resume', '/tmp', 'Resume job', false, 'codex', false, false, 1800000, 1800000, false)`);
      await pool.query(
        `INSERT INTO job_runs (id, job_id, status, started_at, status_updated_at, agent_id)
        VALUES ('run_resume', 'job_resume', 'running', NOW(), NOW(), $1)`,
        [agent.id]
      );
      runtime.prompt.mockClear();
      await manager.startAgent(agent.id);
      expect(lastLaunch().mcp?.url).toBe(
        `http://127.0.0.1:6767/api/mcp/jobs/run_resume/${agent.id}`
      );
      expect(lastLaunch().mcp?.token).toEqual(expect.any(String));
      expect(lastLaunch().mcp?.token).not.toBe(
        createAgentMcpToken("test-token", agent.id)
      );
      expect(lastLaunch().systemPrompt).toContain(
        "Dispatch job run (run_resume)"
      );
      expect(lastLaunch().systemPrompt).toContain("job_complete");
      expect(lastLaunch().systemPrompt).not.toContain("No task, no work");
      // Resume restores context; it must not silently repeat the job task.
      expect(runtime.prompt).not.toHaveBeenCalled();
    });

    it.each(["completed", "failed", "timed_out", "crashed"])(
      "resumes a %s job as an ordinary conversation without replaying its task",
      async (status) => {
        const agent = await createStoppedAgent({ type: "codex" });
        const jobId = `job_resume_${status}`;
        await pool.query(
          `INSERT INTO jobs (id, directory, name, enabled, agent_type, use_worktree, full_access, timeout_ms, needs_input_timeout_ms, auto_archive)
        VALUES ($1, '/tmp', $1, false, 'codex', false, false, 1800000, 1800000, false)`,
          [jobId]
        );
        await pool.query(
          `INSERT INTO job_runs (id, job_id, status, started_at, status_updated_at, agent_id)
        VALUES ($1, $1, $2, NOW(), NOW(), $3)`,
          [jobId, status, agent.id]
        );
        await pool.query(
          "UPDATE agents SET agent_args = $2::jsonb WHERE id = $1",
          [
            agent.id,
            JSON.stringify([
              "--append-system-prompt",
              "Repeat the old job and call job_complete.",
            ]),
          ]
        );
        runtime.prompt.mockClear();
        await manager.startAgent(agent.id);
        expect(lastLaunch().mcp?.url).toBe(
          `http://127.0.0.1:6767/api/mcp/${agent.id}`
        );
        expect(lastLaunch().mcp?.token).toBe(
          createAgentMcpToken("test-token", agent.id)
        );
        expect(lastLaunch().systemPrompt).not.toContain("job_complete");
        expect(lastLaunch().systemPrompt).not.toContain("Repeat the old job");
        expect(lastLaunch().systemPrompt).toContain(
          "previous Dispatch job run has ended"
        );
        expect(runtime.prompt).not.toHaveBeenCalled();
      }
    );

    it("should record the fresh session when the engine could not resume", async () => {
      const agent = await createStoppedAgent();
      runtime.launch.mockResolvedValueOnce({
        sessionId: "sess_fresh",
        resumed: false,
      });

      const started = await manager.startAgent(agent.id);

      expect(started.cliSessionId).toBe("sess_fresh");
    });

    it("should launch fresh when the agent has no session to resume", async () => {
      const agent = await createStoppedAgent({ type: "codex" });
      await pool.query(
        "UPDATE agents SET cli_session_id = NULL WHERE id = $1",
        [agent.id]
      );

      const started = await manager.startAgent(agent.id);

      expect(lastLaunch().resumeSessionId).toBeNull();
      expect(started.cliSessionId).toMatch(/^sess_/);
    });

    it("should transition through creating state during launch", async () => {
      const agent = await createStoppedAgent();
      let statusDuringLaunch: string | undefined;
      runtime.launch.mockImplementationOnce(async () => {
        statusDuringLaunch = (await manager.getAgent(agent.id))?.status;
        return { sessionId: "sess_1", resumed: true };
      });

      await manager.startAgent(agent.id);

      expect(statusDuringLaunch).toBe("creating");
    });

    it("should set error status when launch fails", async () => {
      const agent = await createStoppedAgent();
      runtime.launch.mockRejectedValueOnce(new Error("host exited"));

      await expect(manager.startAgent(agent.id)).rejects.toThrow(
        "Failed to start agent: host exited"
      );

      const failed = await manager.getAgent(agent.id);
      expect(failed!.status).toBe("error");
      expect(failed!.lastError).toBe("host exited");
    });

    it("should skip personality for persona agents even when one is active", async () => {
      await pool.query(
        `INSERT INTO settings (key, value) VALUES ('active_personality_id', 'test-personality')
         ON CONFLICT (key) DO UPDATE SET value = 'test-personality'`
      );
      await pool.query(
        `INSERT INTO personalities (id, name, prompt) VALUES ('test-personality', 'Test', 'You are very formal.')
         ON CONFLICT (id) DO UPDATE SET prompt = 'You are very formal.'`
      );
      try {
        const agent = await createStoppedAgent({
          persona: "security-review",
          role: "review",
          agentArgs: ["--dispatch-persona-context", "Review instructions"],
        });

        await manager.startAgent(agent.id);

        expect(lastLaunch().systemPrompt).not.toContain("You are very formal.");
      } finally {
        await pool.query(
          `DELETE FROM settings WHERE key = 'active_personality_id'`
        );
      }
    });

    it("should resolve a legacy home-relative files_dir before restarting", async () => {
      const agent = await createStoppedAgent();
      const fakeHome = await mkdtemp(path.join(os.tmpdir(), "dispatch-home-"));
      const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(fakeHome);
      try {
        await pool.query(`UPDATE agents SET files_dir = $2 WHERE id = $1`, [
          agent.id,
          `~/.dispatch/legacy-files-${agent.id}`,
        ]);

        await manager.startAgent(agent.id);

        expect(lastLaunch().env?.DISPATCH_FILES_DIR).toBe(
          path.join(fakeHome, ".dispatch", `legacy-files-${agent.id}`)
        );
      } finally {
        homedirSpy.mockRestore();
        await rm(fakeHome, { recursive: true, force: true });
      }
    });
  });

  describe("restoreRunningAgents", () => {
    it("should reattach live hosts and stop agents whose host is gone", async () => {
      const alive = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });
      const gone = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });
      const stopped = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });
      await manager.stopAgent(stopped.id);
      runtime.attach.mockImplementation(async (id) => id === alive.id);
      // "gone" is the genuinely-dead case: no process behind the pid file
      // at all, not merely one that didn't answer this attach attempt.
      runtime.isAlive.mockImplementation(async (id) => id !== gone.id);

      const result = await manager.restoreRunningAgents();

      expect(result).toEqual({
        attached: [alive.id],
        lost: [gone.id],
        resumes: [],
      });
      expect(runtime.attach).not.toHaveBeenCalledWith(stopped.id);
      expect((await manager.getAgent(alive.id))!.status).toBe("running");
      const lost = await manager.getAgent(gone.id);
      expect(lost!.status).toBe("stopped");
      expect(lost!.lastError).toContain("not running when Dispatch restarted");
    });

    it("keeps restoring the other agents when one agent's runner answers with an error", async () => {
      const broken = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });
      const alive = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });
      const gone = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });
      runtime.attach.mockImplementation(async (id) => {
        if (id === broken.id) throw new Error("Unsupported operation");
        return id === alive.id;
      });
      runtime.isAlive.mockImplementation(async (id) => id !== gone.id);

      const result = await manager.restoreRunningAgents();

      expect(result).toEqual({
        attached: [alive.id],
        lost: [gone.id],
        resumes: [],
      });
      // Unknown, not exited: left for the reconciler to check again.
      expect((await manager.getAgent(broken.id))!.status).toBe("running");
      expect((await manager.getAgent(gone.id))!.status).toBe("stopped");
    });

    it("stops a running row when its native host PID belongs to another process", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });
      const agentStateRoot = await mkdtemp(
        path.join(os.tmpdir(), "dispatch-stale-host-")
      );
      const dir = path.join(agentStateRoot, agent.id);
      try {
        await mkdir(dir);
        await writeFile(path.join(dir, "host.pid"), String(process.pid));
        const recovering = new AgentManager(pool, noopLogger, {
          ...testConfig,
          agentStateRoot,
        });
        await expect(recovering.restoreRunningAgents()).resolves.toEqual({
          attached: [],
          lost: [agent.id],
          resumes: [],
        });
        expect(await recovering.getAgent(agent.id)).toMatchObject({
          status: "stopped",
          lastError: expect.stringContaining(
            "not running when Dispatch restarted"
          ),
        });
      } finally {
        await rm(agentStateRoot, { recursive: true, force: true });
      }
    });

    it("does not lose, or let boot cleanup kill, a host that is alive but missed its first attach — and recovers once a later attach succeeds", async () => {
      // Models the real failure this closes: a host busy replaying its
      // journal (or plain boot contention) doesn't answer `hello` inside
      // the attach window, even though its process is still there.
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });
      runtime.attach.mockResolvedValue(false);
      runtime.isAlive.mockResolvedValue(true);
      runtime.listHosted.mockResolvedValue([agent.id]);

      const restored = await manager.restoreRunningAgents();
      expect(restored.lost).toEqual([]);
      expect((await manager.getAgent(agent.id))!.status).toBe("running");

      // reconcileAgents() is what boot actually runs right after restore —
      // status reconciliation (another attach attempt, still failing) plus
      // the orphan-host cleanup pass, in the same startup. The host must
      // still be standing afterward: cleanup only force-stops a host whose
      // agent row reads a terminal status, and this one never got there.
      await manager.reconcileAgents();
      expect((await manager.getAgent(agent.id))!.status).toBe("running");
      expect(runtime.stop).not.toHaveBeenCalled();

      // A later reconcile tick (the periodic loop) is what actually
      // reconnects: once attach succeeds, the agent reads exactly as it
      // would if it had never missed a beat.
      runtime.attach.mockResolvedValue(true);
      const reconciled = await manager.reconcileAgentStatuses();
      expect(reconciled).toEqual([]);
      expect((await manager.getAgent(agent.id))!.status).toBe("running");
      expect(runtime.stop).not.toHaveBeenCalled();
    });
  });

  describe("update recovery host resume", () => {
    const running = () =>
      manager.createAgent({ cwd: "/tmp", useWorktree: false });
    const hostGone = () => {
      runtime.attach.mockResolvedValue(false);
      runtime.isAlive.mockResolvedValue(false);
    };

    it("stops only idle hosts, without touching agent rows, and reports survivors", async () => {
      const agent = await running();
      const before = await pool.query(
        "SELECT status, updated_at::text AS at FROM agents WHERE id = $1",
        [agent.id]
      );
      runtime.listHosted
        .mockResolvedValueOnce([agent.id, "agt_busy", "agt_stuck"])
        .mockResolvedValueOnce(["agt_busy", "agt_stuck"]);
      runtime.isBusy.mockImplementation((id) => id === "agt_busy");

      const result = await manager.stopIdleHostsForRecovery(1_000);

      expect(result).toEqual({
        stopped: [agent.id],
        remaining: ["agt_busy", "agt_stuck"],
      });
      expect(runtime.stop).toHaveBeenCalledWith(agent.id, false);
      expect(runtime.stop).not.toHaveBeenCalledWith("agt_busy", false);
      const after = await pool.query(
        "SELECT status, updated_at::text AS at FROM agents WHERE id = $1",
        [agent.id]
      );
      expect(after.rows).toEqual(before.rows);
    });

    it("never plain-stops a host that the idle-only stop refused at the fence", async () => {
      const agent = await running();
      const stopIdle = vi.fn(async () => false);
      Object.assign(runtime, { stopIdleHostForRecovery: stopIdle });
      runtime.listHosted.mockResolvedValue([agent.id]);

      expect(await manager.stopIdleHostsForRecovery(1_000)).toEqual({
        stopped: [],
        remaining: [agent.id],
      });
      expect(stopIdle).toHaveBeenCalledExactlyOnceWith(agent.id);
      expect(runtime.stop).not.toHaveBeenCalled();
    });

    it("resumes an untouched idle agent exactly once, resuming its session without replaying prompts", async () => {
      const agent = await running();
      const snapshot = await manager.updateResumeSnapshot([agent.id]);
      expect(snapshot).toEqual([
        { id: agent.id, updatedAt: expect.any(String) },
      ]);

      // Normal start after the update: the fence stopped the host.
      hostGone();
      const eligible = await manager.eligibleUpdateResumes(snapshot);
      expect([...eligible]).toEqual([agent.id]);
      const { lost, resumes } = await manager.restoreRunningAgents({
        resumeAfterUpdate: eligible,
      });
      expect(lost).toEqual([agent.id]);
      const pending = await manager.getAgent(agent.id);
      expect(pending!.status).toBe("stopped");
      expect(pending!.lastError).toBe(UPDATE_RESUME_MESSAGE);
      // Display copy is not an intent marker (timestamp deliberately unchanged).
      await pool.query(
        "UPDATE agents SET last_error = 'Different display copy' WHERE id = $1",
        [agent.id]
      );

      runtime.launch.mockClear();
      runtime.prompt.mockClear();
      expect(await manager.resumeAgentsAfterUpdate(resumes)).toEqual([
        agent.id,
      ]);
      const resumed = await manager.getAgent(agent.id);
      expect(resumed!.status).toBe("running");
      expect(resumed!.lastError).toBeNull();
      expect(runtime.launch).toHaveBeenCalledOnce();
      expect(runtime.launch.mock.calls[0][0].resumeSessionId).toBe(
        agent.cliSessionId
      );
      expect(runtime.prompt).not.toHaveBeenCalled();

      // A second pass (duplicate call, crash-restart) does nothing.
      expect(await manager.resumeAgentsAfterUpdate(resumes)).toEqual([]);
      expect(runtime.launch).toHaveBeenCalledOnce();
    });

    it("never resumes rows that changed after the receipt or are uncertain", async () => {
      const edited = await running();
      const stoppedByUser = await running();
      const archived = await running();
      const snapshot = await manager.updateResumeSnapshot([
        edited.id,
        stoppedByUser.id,
        archived.id,
      ]);
      expect(snapshot).toHaveLength(3);
      await pool.query(
        "UPDATE agents SET updated_at = updated_at + interval '1 microsecond' WHERE id = $1",
        [edited.id]
      );
      await manager.stopAgent(stoppedByUser.id);
      await pool.query("UPDATE agents SET deleted_at = NOW() WHERE id = $1", [
        archived.id,
      ]);

      const eligible = await manager.eligibleUpdateResumes([
        ...snapshot,
        { id: "agt_missing", updatedAt: snapshot[0].updatedAt },
        { id: edited.id, updatedAt: "not a timestamp" },
      ]);
      expect(eligible.size).toBe(0);
      // Stopped rows are not snapshotted in the first place.
      expect(await manager.updateResumeSnapshot([stoppedByUser.id])).toEqual(
        []
      );

      hostGone();
      const { resumes } = await manager.restoreRunningAgents({
        resumeAfterUpdate: eligible,
      });
      expect((await manager.getAgent(edited.id))!.lastError).toContain(
        "not running when Dispatch restarted"
      );
      runtime.launch.mockClear();
      expect(await manager.resumeAgentsAfterUpdate(resumes)).toEqual([]);
      expect(runtime.launch).not.toHaveBeenCalled();
    });

    it("serializes a pending resume with concurrent user Start and Stop", async () => {
      const agent = await running();
      hostGone();
      const eligible = await manager.eligibleUpdateResumes(
        await manager.updateResumeSnapshot([agent.id])
      );
      const { resumes } = await manager.restoreRunningAgents({
        resumeAfterUpdate: eligible,
      });
      let release!: (alive: boolean) => void;
      runtime.attach.mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            release = resolve;
          })
      );
      runtime.attach.mockResolvedValue(true);
      runtime.attach.mockClear();
      runtime.launch.mockClear();
      const pending = manager.resumeAgentsAfterUpdate(resumes);
      await vi.waitFor(() => expect(runtime.attach).toHaveBeenCalledOnce());
      const userStart = manager.startAgent(agent.id);
      const userStop = manager.stopAgent(agent.id);
      release(false);
      expect(await pending).toEqual([agent.id]);
      await userStart;
      await userStop;
      expect(runtime.launch).toHaveBeenCalledOnce();
      expect((await manager.getAgent(agent.id))?.status).toBe("stopped");
      expect(await manager.resumeAgentsAfterUpdate(resumes)).toEqual([]);
    });

    it("lets a user decision made after restart win over the pending resume", async () => {
      const agent = await running();
      const snapshot = await manager.updateResumeSnapshot([agent.id]);
      hostGone();
      const eligible = await manager.eligibleUpdateResumes(snapshot);
      const { resumes } = await manager.restoreRunningAgents({
        resumeAfterUpdate: eligible,
      });

      // Stopping an already-stopped row cancels the pending receipt.
      await manager.stopAgent(agent.id);
      expect(await manager.resumeAgentsAfterUpdate(resumes)).toEqual([]);
      // The user started and stopped it again before the resume ran.
      await manager.startAgent(agent.id);
      await manager.stopAgent(agent.id);
      runtime.launch.mockClear();

      expect(await manager.resumeAgentsAfterUpdate(resumes)).toEqual([]);
      expect(runtime.launch).not.toHaveBeenCalled();
      expect((await manager.getAgent(agent.id))!.status).toBe("stopped");
    });
  });

  it("quiesces and resumes a real idle ACP host from an unchanged recovery receipt", async () => {
    const root = await mkdtemp("/tmp/dispatch-ru-host-");
    const previousHost = process.env.DISPATCH_AGENT_HOST_COMMAND;
    const repo = path.resolve(import.meta.dirname, "../../../..");
    process.env.DISPATCH_AGENT_HOST_COMMAND = JSON.stringify([
      "bun",
      path.join(repo, "apps/server/src/main.ts"),
      "agent-host",
    ]);
    const liveConfig = {
      ...testConfig,
      agentRuntime: "acp" as const,
      acpAdapter: { bin: path.join(repo, "e2e/fixtures/fake-acp-agent.mjs") },
      agentStateRoot: path.join(root, "hosts"),
      filesRoot: path.join(root, "files"),
    };
    const first = new AgentManager(pool, noopLogger, liveConfig);
    const restarted = new AgentManager(pool, noopLogger, liveConfig);
    let id: string | undefined;
    let startupTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const creation = first.createAgent({
        cwd: root,
        useWorktree: false,
        type: "claude",
      });
      const agent = await Promise.race([
        creation,
        new Promise<never>((_, reject) =>
          setTimeout(async () => {
            const row = await pool.query(
              "SELECT id FROM agents WHERE cwd = $1",
              [root]
            );
            id = row.rows[0]?.id;
            const diagnostic = id
              ? await readFile(
                  path.join(root, "hosts", id, "host.log"),
                  "utf8"
                ).catch(() => "no host log")
              : "no row";
            reject(new Error("Real host launch timed out: " + diagnostic));
          }, 15_000)
        ),
      ]);
      clearTimeout(startupTimer);
      id = agent.id;
      expect(await first.listHostedAgentIds()).toContain(id);
      expect(await first.recoveryHostActivity()).toEqual({
        busy: [],
        unattached: [],
      });
      const quiesced = await first.stopIdleHostsForRecovery(20_000);
      expect(quiesced).toEqual({ stopped: [id], remaining: [] });
      const snapshot = await first.updateResumeSnapshot([id]);
      const eligible = await restarted.eligibleUpdateResumes(snapshot);
      const { resumes } = await restarted.restoreRunningAgents({
        resumeAfterUpdate: eligible,
      });
      expect(resumes).toHaveLength(1);
      expect(await restarted.resumeAgentsAfterUpdate(resumes)).toEqual([id]);
      expect(await restarted.listHostedAgentIds()).toContain(id);
      expect((await restarted.getAgent(id))?.status).toBe("running");
      expect((await restarted.getAgent(id))?.cliSessionId).toBe(
        agent.cliSessionId
      );
      expect(await restarted.resumeAgentsAfterUpdate(resumes)).toEqual([]);
    } finally {
      clearTimeout(startupTimer);
      if (id) await restarted.stopAgent(id).catch(() => null);
      await first.stopIdleHostsForRecovery(20_000).catch(() => null);
      await restarted.stopIdleHostsForRecovery(20_000).catch(() => null);
      if (previousHost === undefined)
        delete process.env.DISPATCH_AGENT_HOST_COMMAND;
      else process.env.DISPATCH_AGENT_HOST_COMMAND = previousHost;
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  describe("reconcileAgents", () => {
    it("should mark a running agent stopped when its host is gone", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });
      runtime.isAlive.mockResolvedValue(false);
      runtime.readLogTail.mockResolvedValue("adapter crashed");

      await manager.reconcileAgents();

      const reconciled = await manager.getAgent(agent.id);
      expect(reconciled!.status).toBe("stopped");
      expect(reconciled!.lastError).toBe("adapter crashed");
    });

    it("should leave agents with a live host alone", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });

      expect(await manager.reconcileAgentStatuses()).toEqual([]);
      expect((await manager.getAgent(agent.id))!.status).toBe("running");
    });

    it("uses the enrolled runner inventory for update drain", async () => {
      const winner = {
        agentId: "agt_live",
        instanceId: "live-instance",
        quiesceSupported: true,
        attachedEpoch: 2,
      };
      runtime.runnerHosts = vi.fn(() => [
        winner,
        { ...winner, agentId: "agt_newer", instanceId: "older-instance" },
      ]);
      runtime.listRunnerSessions = vi.fn(async () => ({
        sessions: [
          {
            session: sessionFromWire("agt_live"),
            state: "live",
            instanceId: "live-instance",
          },
          {
            session: sessionFromWire("agt_newer"),
            state: "live",
            instanceId: "new-instance",
          },
          { session: sessionFromWire("agt_unknown"), state: "live" },
          { session: sessionFromWire("agt_exited"), state: "gone" },
        ],
      }));
      runtime.runnerHostAlive = vi.fn(async () => true);
      expect(
        await manager.runnerDrainHosts("runner-1", ["agt_exited"])
      ).toEqual([
        { id: "agt_live", host: winner },
        { id: "agt_newer", host: undefined },
        { id: "agt_unknown", host: undefined },
      ]);
      expect(runtime.runnerHostAlive).not.toHaveBeenCalled();
    });

    it("should stop hosts left behind by stopped agents", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });
      const launchId = "6f1c2d3e-4a5b-4c6d-8e7f-8091a2b3c4d5";
      await pool.query(
        `UPDATE agents SET status = 'stopped', host_launch_id = $2 WHERE id = $1`,
        [agent.id, launchId]
      );
      runtime.listSessions = vi.fn(async () => ({
        sessions: [
          { session: sessionFromWire(agent.id), state: "live", launchId },
        ],
      }));
      runtime.retryStop = vi.fn(async () => {});

      await manager.reconcileAgents();

      expect(runtime.retryStop).toHaveBeenCalledExactlyOnceWith(
        agent.id,
        true,
        null,
        launchId,
        true
      );
    });
  });

  describe("cliSessionId", () => {
    it("should record the session id the runtime reports, not a caller-supplied one", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
        cliSessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      });

      expect(lastLaunch().resumeSessionId).toBeNull();
      expect(agent.cliSessionId).toBe("sess_1");
    });

    it("should persist the session id for persona agents", async () => {
      const parent = await manager.createAgent({
        name: "parent",
        cwd: "/tmp",
        useWorktree: false,
      });
      const persona = await manager.createAgent({
        name: "sec-review",
        cwd: "/tmp",
        useWorktree: false,
        persona: "security-review",
        role: "review",
        agentArgs: ["--dispatch-persona-context", "Review instructions"],
        parentAgentId: parent.id,
      });

      const fetched = await manager.getAgent(persona.id);
      expect(fetched!.cliSessionId).toBe("sess_2");
      expect(fetched!.parentAgentId).toBe(parent.id);
    });
  });

  describe("listFiles", () => {
    it("should include filePath and sizeBytes for each file item", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });

      await pool.query(
        `INSERT INTO files (agent_id, file_name, source, size_bytes, description, mime_type)
         VALUES ($1, 'doc.pdf', 'upload', 4096, 'Product brief', 'application/pdf')`,
        [agent.id]
      );

      const files = await manager.listFiles(agent.id);
      expect(files).toHaveLength(1);
      const item = files[0]!;
      expect(item.fileName).toBe("doc.pdf");
      expect(item.description).toBe("Product brief");
      expect(item.source).toBe("upload");
      expect(item.sizeBytes).toBe(4096);
      expect(typeof item.createdAt).toBe("string");
      expect(item.filePath.endsWith(`${agent.id}/doc.pdf`)).toBe(true);
      expect(path.isAbsolute(item.filePath)).toBe(true);

      await writeFile(item.filePath, "shared files");
      await expect(readFile(item.filePath, "utf-8")).resolves.toBe(
        "shared files"
      );
    });

    it("should resolve filePath using the agent's files_dir override", async () => {
      const customDir = await mkdtemp(
        path.join(os.tmpdir(), "dispatch-files-")
      );
      try {
        const agent = await manager.createAgent({
          cwd: "/tmp",
          useWorktree: false,
        });
        await pool.query(`UPDATE agents SET files_dir = $2 WHERE id = $1`, [
          agent.id,
          customDir,
        ]);

        await pool.query(
          `INSERT INTO files (agent_id, file_name, source, size_bytes, mime_type)
           VALUES ($1, 'screen.png', 'screenshot', 256, 'image/png')`,
          [agent.id]
        );

        const files = await manager.listFiles(agent.id);
        expect(files).toHaveLength(1);
        expect(files[0]!.filePath).toBe(path.join(customDir, "screen.png"));
        expect(files[0]!.sizeBytes).toBe(256);
      } finally {
        await rm(customDir, { recursive: true, force: true });
      }
    });
  });

  describe("updateSetupPhase", () => {
    it("should update the setup phase on a creating agent", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });

      await manager.updateSetupPhase(agent.id, "worktree");

      const fetched = await manager.getAgent(agent.id);
      expect(fetched!.setupPhase).toBe("worktree");
    });

    it("should transition through multiple phases", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });

      await manager.updateSetupPhase(agent.id, "worktree");
      await manager.updateSetupPhase(agent.id, "deps");

      const fetched = await manager.getAgent(agent.id);
      expect(fetched!.setupPhase).toBe("deps");
    });
  });

  describe("checkWorktreeStatus", () => {
    it("reports the same worktree status for local and runner borrowers", async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "shared-checkout-"));
      try {
        const checkoutPath = await realpath(root);
        const git = (...args: string[]) =>
          execFileSync("git", args, { cwd: checkoutPath });
        git("init", "-b", "main");
        git(
          "-c",
          "user.name=Dispatch Test",
          "-c",
          "user.email=test@example.test",
          "commit",
          "--allow-empty",
          "-m",
          "Initial"
        );
        await writeFile(path.join(checkoutPath, "dirty.txt"), "uncommitted\n");

        vi.mocked(createGitWorktree).mockResolvedValueOnce({
          worktreePath: checkoutPath,
          branchName: "main",
        } as never);
        const owner = await manager.createAgent({
          cwd: checkoutPath,
          useWorktree: true,
          baseBranch: "main",
        });
        const child = await manager.createAgent({
          cwd: checkoutPath,
          parentAgentId: owner.id,
          useWorktree: false,
        });
        const ownerStatus = await manager.checkWorktreeStatus(owner.id);
        expect(ownerStatus).toMatchObject({
          ownership: "owned",
          borrowers: [child.id],
          checkoutState: expect.stringMatching(/^[0-9a-f]{64}$/),
          uncommittedFiles: ["?? dirty.txt"],
        });

        const runnerCwd = "runner://runner-test/@session";
        const checkout = await observeGitCheckout(checkoutPath);
        const requestSession = vi.fn(async () => ({
          value: JSON.stringify({
            ownership: "borrowed",
            owner: owner.id,
            borrowers: [child.id],
            checkout,
          }),
        }));
        const runnerManager = new AgentManager(pool, noopLogger, testConfig, {
          runtime,
          remote: { requestSession } as unknown as RemoteRunnerService,
        });
        const localStatus = await manager.checkWorktreeStatus(child.id);
        // The runner the locator names, as every launch records it (0065).
        await pool.query(
          "UPDATE agents SET cwd = $2, runner_id = 'runner-test' WHERE id = $1",
          [child.id, runnerCwd]
        );
        const runnerStatus = await runnerManager.checkWorktreeStatus(child.id);
        expect(requestSession).toHaveBeenCalledWith(
          { runner: "runner-test", workspace: "@session" },
          {
            kind: "checkoutRelease",
            agentId: child.id,
            operation: { kind: "observe" },
          }
        );
        expect(runnerStatus).toEqual({ ...ownerStatus, ownership: "borrowed" });
        expect(localStatus).toEqual(runnerStatus);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it("does not count a child whose own worktree was never created as a borrower", async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "failed-borrower-"));
      try {
        const checkoutPath = await realpath(root);
        execFileSync("git", ["init", "-b", "main"], { cwd: checkoutPath });
        execFileSync(
          "git",
          [
            "-c",
            "user.name=Dispatch Test",
            "-c",
            "user.email=test@example.test",
            "commit",
            "--allow-empty",
            "-m",
            "Initial",
          ],
          { cwd: checkoutPath }
        );
        vi.mocked(createGitWorktree).mockResolvedValueOnce({
          worktreePath: checkoutPath,
          branchName: "main",
        } as never);
        const owner = await manager.createAgent({
          cwd: checkoutPath,
          useWorktree: true,
          baseBranch: "main",
        });
        vi.mocked(createGitWorktree).mockRejectedValueOnce(
          new GitWorktreeError("branch is already checked out", 409)
        );
        await expect(
          manager.createAgent({
            cwd: checkoutPath,
            parentAgentId: owner.id,
            worktreeBranch: "feat/x",
          })
        ).rejects.toMatchObject({ statusCode: 409 });
        const borrower = await manager.createAgent({
          cwd: checkoutPath,
          parentAgentId: owner.id,
          useWorktree: false,
        });
        await manager.stopAgent(borrower.id);

        expect(await manager.checkWorktreeStatus(owner.id)).toMatchObject({
          ownership: "owned",
          borrowers: [borrower.id],
        });
        const failed = await pool.query<{ id: string }>(
          "SELECT id FROM agents WHERE parent_agent_id = $1 AND id <> $2",
          [owner.id, borrower.id]
        );
        const failedId = failed.rows[0].id;
        await manager.setWorkspace(failedId, {
          path: checkoutPath,
          baseBranch: "main",
        });
        expect(await manager.checkWorktreeStatus(owner.id)).toMatchObject({
          ownership: "owned",
          borrowers: [borrower.id, failedId].sort(),
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it("should return hasWorktree false for agents without a worktree", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });

      const status = await manager.checkWorktreeStatus(agent.id);
      expect(status.hasWorktree).toBe(false);
      expect(status.worktreePath).toBeNull();
      expect(status.branchName).toBeNull();
      expect(status.changedFiles).toEqual([]);
      expect(status.uncommittedFiles).toEqual([]);
    });

    it("answers like main when the recorded worktree is gone", async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "missing-checkout-"));
      const worktreePath = path.join(await realpath(root), "gone");
      try {
        await mkdir(worktreePath);
        vi.mocked(createGitWorktree).mockResolvedValueOnce({
          worktreePath,
          branchName: "feature",
        } as never);
        const agent = await manager.createAgent({
          cwd: root,
          useWorktree: true,
          baseBranch: "main",
        });
        await rm(worktreePath, { recursive: true });
        expect(await manager.checkWorktreeStatus(agent.id)).toEqual({
          ownership: "owned",
          borrowers: [],
          hasWorktree: true,
          hasUnmergedCommits: false,
          hasUncommittedChanges: false,
          worktreePath,
          branchName: null,
          changedFiles: [],
          uncommittedFiles: [],
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    describe("a runner agent whose owned checkout is gone", () => {
      const runnerCwd = "runner://runner-test/@session";
      const owned = {
        value: JSON.stringify({
          ownership: "owned",
          owner: "self",
          borrowers: [],
          checkout: null,
        }),
      };
      async function runnerAgent(worktreePath: string | null) {
        const agent = await manager.createAgent({
          cwd: "/tmp",
          useWorktree: false,
        });
        await pool.query(
          "UPDATE agents SET cwd = $2, worktree_path = $3, runner_id = 'runner-test' WHERE id = $1",
          [agent.id, runnerCwd, worktreePath]
        );
        return agent;
      }
      function runnerManager(requestSession: ReturnType<typeof vi.fn>) {
        return new AgentManager(pool, noopLogger, testConfig, {
          runtime,
          remote: { requestSession } as unknown as RemoteRunnerService,
        });
      }

      it("answers like main with the recorded checkout path", async () => {
        const agent = await runnerAgent("/srv/checkouts/gone");
        const status = await runnerManager(
          vi.fn(async () => owned)
        ).checkWorktreeStatus(agent.id);
        expect(status).toEqual({
          ownership: "owned",
          borrowers: [],
          hasWorktree: true,
          hasUnmergedCommits: false,
          hasUncommittedChanges: false,
          worktreePath: "/srv/checkouts/gone",
          branchName: null,
          changedFiles: [],
          uncommittedFiles: [],
        });
      });

      it("answers main's no-worktree status when no path was recorded", async () => {
        const agent = await runnerAgent(null);
        const status = await runnerManager(
          vi.fn(async () => owned)
        ).checkWorktreeStatus(agent.id);
        expect(status).toEqual({
          ownership: "owned",
          borrowers: [],
          hasWorktree: false,
          hasUnmergedCommits: false,
          hasUncommittedChanges: false,
          worktreePath: null,
          branchName: null,
          changedFiles: [],
          uncommittedFiles: [],
        });
      });

      it.each([
        ["offline", new Error("Runner runner-test is not connected.")],
        ["an error reply", new Error("Checkout observation failed.")],
      ])(
        "stays unavailable, not gone, when the runner is %s",
        async (_, error) => {
          const agent = await runnerAgent("/srv/checkouts/kept");
          await expect(
            runnerManager(
              vi.fn(async () => {
                throw error;
              })
            ).checkWorktreeStatus(agent.id)
          ).rejects.toMatchObject({
            statusCode: 503,
            message: "Checkout status is unavailable on the owning runner.",
          });
        }
      );

      it("stays unavailable when the runner's reply is not an observation", async () => {
        const agent = await runnerAgent("/srv/checkouts/kept");
        await expect(
          runnerManager(
            vi.fn(async () => ({ value: "not json" }))
          ).checkWorktreeStatus(agent.id)
        ).rejects.toMatchObject({ statusCode: 503 });
      });
    });

    describe("the status read on a runner that releases bound checkouts", () => {
      const runnerCwd = "runner://runner-test/@session";
      const replies = {
        owned: {
          ownership: "owned",
          owner: "self",
          borrowers: ["agt_review"],
          checkout: {
            path: "/srv/checkouts/kept",
            branch: "feature",
            stateId: "0".repeat(64),
            unmerged: false,
            changedFiles: ["a.ts"],
            uncommittedFiles: ["?? b.ts"],
          },
        },
        borrowed: {
          ownership: "borrowed",
          owner: "agt_owner",
          borrowers: [],
          checkout: null,
        },
        external: {
          ownership: "external",
          owner: null,
          borrowers: [],
          checkout: null,
        },
        gone: {
          ownership: "owned",
          owner: "self",
          borrowers: [],
          checkout: null,
        },
      };
      async function runnerAgent() {
        const agent = await manager.createAgent({
          cwd: "/tmp",
          useWorktree: false,
        });
        await pool.query(
          "UPDATE agents SET cwd = $2, worktree_path = $3, runner_id = 'runner-test' WHERE id = $1",
          [agent.id, runnerCwd, "/srv/checkouts/kept"]
        );
        return agent;
      }
      function managerFor(
        capable: boolean,
        requestSession: ReturnType<typeof vi.fn>
      ) {
        return new AgentManager(pool, noopLogger, testConfig, {
          runtime,
          remote: {
            requestSession,
            supportsWorkspaceRelease: () => capable,
            connectionEpoch: () => (capable ? 3 : undefined),
          } as unknown as RemoteRunnerService,
        });
      }
      const outcome = (work: Promise<unknown>) =>
        work.then(
          (status) => ({ status }),
          (error: { statusCode?: number; message?: string }) => ({
            error: { statusCode: error.statusCode, message: error.message },
          })
        );

      it.each([
        ...Object.entries(replies).map(
          ([name, reply]) =>
            [name, async () => ({ value: JSON.stringify(reply) })] as const
        ),
        [
          "offline",
          async () => {
            throw new Error("Runner runner-test is not connected.");
          },
        ] as const,
        [
          "an error reply",
          async () => {
            throw new Error("Checkout observation failed.");
          },
        ] as const,
        ["not an observation", async () => ({ value: "not json" })] as const,
      ])(
        "%s: the same status (or 503 body) as through the snapshot transport",
        async (_name, reply) => {
          const agent = await runnerAgent();
          const results = [];
          for (const capable of [false, true]) {
            const requestSession = vi.fn(reply);
            results.push(
              await outcome(
                managerFor(capable, requestSession).checkWorktreeStatus(
                  agent.id
                )
              )
            );
            expect(requestSession).toHaveBeenCalledOnce();
            // The capable peer is asked for the checkout's state (changes);
            // the snapshot peer gets its own frame, as before.
            expect(requestSession.mock.calls[0]![1]).toEqual({
              kind: "checkoutRelease",
              agentId: agent.id,
              operation: capable
                ? { kind: "observe", policy: "changes" }
                : { kind: "observe" },
            });
          }
          expect(results[1]).toEqual(results[0]);
          if ("error" in results[0]!)
            expect(results[0].error).toEqual({
              statusCode: 503,
              message: "Checkout status is unavailable on the owning runner.",
            });
        }
      );

      it("without an enrolled service: today's 503", async () => {
        const agent = await runnerAgent();
        await expect(
          new AgentManager(pool, noopLogger, testConfig, {
            runtime,
          }).checkWorktreeStatus(agent.id)
        ).rejects.toMatchObject({
          statusCode: 503,
          message: "Checkout status is unavailable on the owning runner.",
        });
      });

      it.each([
        [true, null],
        [false, "1".repeat(64)],
      ] as const)(
        "beginArchive keeps the observed state only for a snapshot peer (bound release %s)",
        async (capable, kept) => {
          const agent = await runnerAgent();
          await managerFor(
            capable,
            vi.fn(async () => ({ value: "released" }))
          ).beginArchive(agent.id, "auto", "1".repeat(64));
          const { rows } = await pool.query(
            "SELECT archive_checkout_state FROM agents WHERE id = $1",
            [agent.id]
          );
          expect(rows[0]?.archive_checkout_state).toBe(kept);
        }
      );

      it("beginArchive keeps the observed state for a local row", async () => {
        const agent = await manager.createAgent({
          cwd: "/tmp",
          useWorktree: false,
        });
        await managerFor(true, vi.fn()).beginArchive(
          agent.id,
          "auto",
          "1".repeat(64)
        );
        const { rows } = await pool.query(
          "SELECT archive_checkout_state FROM agents WHERE id = $1",
          [agent.id]
        );
        expect(rows[0]?.archive_checkout_state).toBe("1".repeat(64));
      });
    });

    it("should throw 404 for a non-existent agent", async () => {
      await expect(
        manager.checkWorktreeStatus("agt_does_not_exist")
      ).rejects.toThrow(/not found/i);
    });
  });

  describe("resolveRuntimeCwd", () => {
    it("should return the agent's working directory", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });
      await pool.query(
        `UPDATE agents SET cwd = '/tmp/workspace' WHERE id = $1`,
        [agent.id]
      );

      const fetched = (await manager.getAgent(agent.id))!;
      expect(await manager.resolveRuntimeCwd(fetched)).toBe("/tmp/workspace");
    });
  });
});
