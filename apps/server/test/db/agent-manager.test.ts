import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  setupAgentWorkspace: vi.fn(async () => {}),
}));

// We need to dynamically import AgentManager AFTER the mocks are in place
const {
  AgentManager,
  AgentError,
  LAUNCH_CONTEXT_RESOLVE_TIMEOUT_MS,
  LAUNCH_CONTEXT_WRITE_TIMEOUT_MS,
} = await import("../../src/agents/manager.js");
const { StreamService } = await import("../../src/chat/service.js");
const { createAgentMcpToken } = await import("../../src/auth.js");
const { createInertRuntime } = await import("../../src/agents/runtime.js");
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
  // Real executables: the launch path checks the engine CLI is installed.
  codexBin: "/bin/echo",
  claudeBin: "/bin/echo",
  opencodeBin: "/bin/opencode",
  agentStateRoot: "/tmp/dispatch-test-agents",
  agentRuntime: "acp",
  sessionPrefix: "dispatch",
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
 * The published stream entries a launch produced, minus the system-prompt
 * record every launch writes. These tests are about launch context.
 */
function launchChatEvents(): unknown[] {
  return chatEvents.filter((event) => {
    const entry = (event as { entry?: { block?: { origin?: string } } }).entry;
    return entry?.block?.origin !== "system_prompt";
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
  pool = await setupTestDb();
  await runTestMigrations();
});

afterAll(async () => {
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
  describe("createAgent", () => {
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
      expect(agent.latestEvent?.message).toBe("Claude Code session started.");
      expect(runtime.launch).toHaveBeenCalledTimes(1);
    });

    it("should hand the runtime the engine, cwd, bins and an agent-scoped MCP endpoint", async () => {
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
        bins: {
          claudeBin: "/bin/echo",
          codexBin: "/bin/echo",
        },
        mcp: {
          url: `http://127.0.0.1:6767/api/mcp/${agent.id}`,
          token: createAgentMcpToken("test-token", agent.id),
        },
        resumeSessionId: null,
      });
      expect(launch.env).toMatchObject({
        DISPATCH_AGENT_ID: agent.id,
        DISPATCH_FILES_DIR: path.join(testConfig.filesRoot, agent.id),
        DISPATCH_PORT: "6767",
        DISPATCH_SCHEME: "http",
      });
      expect(launch.pathPrefix[0]).toBe(testConfig.dispatchBinDir);
      expect(launch.systemPrompt).toContain(agent.id);
    });

    it("should use the job MCP route and token for job runs", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
        jobRunId: "run_1",
      });
      expect(lastLaunch().mcp.url).toBe(
        `http://127.0.0.1:6767/api/mcp/jobs/run_1/${agent.id}`
      );
      expect(lastLaunch().mcp.token).not.toBe(
        createAgentMcpToken("test-token", agent.id)
      );
    });

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
      expect(failed!.latestEvent).toMatchObject({
        type: "blocked",
        message: "Failed to create agent: adapter not found",
      });
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
      expect(failed!.latestEvent?.type).toBe("blocked");
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

    it("should persist assisted update role when provided", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        role: "assisted_update",
        useWorktree: false,
      });
      expect(agent.role).toBe("assisted_update");
    });

    it("should give assisted update agents the update API URL and a release token", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        role: "assisted_update",
        type: "codex",
        useWorktree: false,
      });

      const { env } = lastLaunch();
      expect(env.DISPATCH_API_URL).toBe("http://127.0.0.1:6767");
      expect(env.DISPATCH_RELEASE_UPDATE_TOKEN).toBeTruthy();
      expect(env.DISPATCH_RELEASE_UPDATE_TOKEN).not.toBe(
        createAgentMcpToken("test-token", agent.id)
      );
    });

    it("should not hand a release token to standard agents", async () => {
      await manager.createAgent({ cwd: "/tmp", useWorktree: false });
      expect(lastLaunch().env.DISPATCH_RELEASE_UPDATE_TOKEN).toBeUndefined();
      expect(lastLaunch().env.DISPATCH_API_URL).toBeUndefined();
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
      async function launchPosts(agentId: string) {
        const result = await pool.query(
          `SELECT * FROM blocks WHERE to_agent_id = $1 AND origin = 'launch' ORDER BY created_at`,
          [agentId]
        );
        return result.rows as Array<{
          id: string;
          author_kind: string;
          kind: string;
          text: string;
          delivered: boolean | null;
          origin: string | null;
          launched_by_agent_id: string | null;
          attachments: Array<Record<string, unknown>>;
        }>;
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
            },
          ],
        });
        const posts = await launchPosts(agent.id);
        expect(posts).toHaveLength(1);
        const seeded = await pool.query<{ id: number; file_name: string }>(
          `SELECT id, file_name FROM files WHERE agent_id = $1`,
          [agent.id]
        );
        expect(posts[0]).toMatchObject({
          author_kind: "user",
          kind: "text",
          to_agent_id: agent.id,
          text: "Build the widget",
          delivered: true,
          origin: "launch",
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
        expect(launchChatEvents()).toEqual([
          expect.objectContaining({
            type: "stream.entry",
            agentId: agent.id,
            entry: expect.objectContaining({
              type: "block",
              block: expect.objectContaining({ origin: "launch" }),
            }),
          }),
        ]);
      });

      it("records nothing for a bare launch", async () => {
        const bare = await manager.createAgent({
          cwd: "/tmp",
          useWorktree: false,
        });
        expect(await launchPosts(bare.id)).toEqual([]);
        expect(launchChatEvents()).toEqual([]);
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
          text: "Review the diff",
          origin: "launch",
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
            },
          ],
        });
        const posts = await launchPosts(agent.id);
        expect(posts).toHaveLength(1);
        const [firstTurn] = promptsFor(agent.id);
        // The envelope names the post that was written, so the agent's reply
        // threads onto the launch post in the feed.
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

      it("launches unwrapped when the post's id is already taken", async () => {
        // Between resolving the id and writing it, something else claims the
        // row. The insert is ON CONFLICT DO NOTHING, so the write reports
        // failure and the envelope is dropped rather than naming a row this
        // launch does not own.
        const warn = vi.fn();
        const spy = createSpyRuntime();
        const racing = managerWith({ warn, runtime: spy });
        const chat = new StreamService({
          pool,
          publishUiEvent: (event) => chatEvents.push(event),
          getAgent: (id) => racing.getAgent(id),
          filesRoot: testConfig.filesRoot,
        });
        racing.attachLaunchContextRecorder({
          prepareLaunchContext: async (input) => {
            const prepared = await chat.prepareLaunchContext(input);
            await pool.query(
              `INSERT INTO blocks (id, stream_id, author_kind, to_agent_id, kind, text)
               VALUES ($1, $2, 'user', $2, 'text', 'squatter')`,
              [input.id, input.agentId]
            );
            return prepared;
          },
        });

        const agent = await racing.createAgent({
          cwd: "/tmp",
          type: "claude",
          useWorktree: false,
          initialPrompt: "Go",
          launchContext: { prompt: "Go" },
        });
        expect(warn).toHaveBeenCalledWith(
          expect.objectContaining({ agentId: agent.id }),
          expect.stringContaining("launching without the Chat envelope")
        );
        expect(promptsFor(agent.id, spy)).toEqual(["Go"]);
        // The squatter row is untouched: the launch wrote nothing.
        const rows = await pool.query<{ text: string }>(
          `SELECT text FROM blocks WHERE stream_id = $1`,
          [agent.id]
        );
        expect(rows.rows).toEqual([{ text: "squatter" }]);
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

    it("should persist autoReview", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        autoReview: true,
        useWorktree: false,
      });
      expect(agent.autoReview).toBe(true);
    });

    it("should default autoReview to false", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });
      expect(agent.autoReview).toBe(false);
    });

    it("should persist baseBranch when provided", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        baseBranch: "feature/foo",
        useWorktree: false,
      });
      expect(agent.baseBranch).toBe("feature/foo");
    });

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

    describe("system prompt", () => {
      const RENAME = "Name the session. Once the topic of work is clear";

      it("suggests a session name only for default-named agents", async () => {
        await manager.createAgent({ cwd: "/tmp", useWorktree: false });
        expect(lastLaunch().systemPrompt).toContain(RENAME);

        for (const input of [
          { name: "bug bash" },
          // Custom names that merely resemble the default pattern count too.
          { name: "agent-foobar" },
          { name: "security-review-123456", persona: "security-review" },
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

      it("includes autonomous review guidance only for non-persona, non-job autoReview agents", async () => {
        await manager.createAgent({
          cwd: "/tmp",
          type: "claude",
          autoReview: true,
          useWorktree: false,
        });
        expect(lastLaunch().systemPrompt).toContain(
          "Autonomous Review is enabled"
        );

        await manager.createAgent({
          cwd: "/tmp",
          type: "claude",
          autoReview: false,
          useWorktree: false,
        });
        expect(lastLaunch().systemPrompt).not.toContain(
          "Autonomous Review is enabled"
        );

        await manager.createAgent({
          cwd: "/tmp",
          type: "claude",
          autoReview: true,
          persona: "security-review",
          useWorktree: false,
        });
        expect(lastLaunch().systemPrompt).not.toContain(
          "Autonomous Review is enabled"
        );

        await manager.createAgent({
          cwd: "/tmp",
          type: "claude",
          autoReview: true,
          jobRunId: "run_abc123",
          useWorktree: false,
        });
        expect(lastLaunch().systemPrompt).not.toContain(
          "Autonomous Review is enabled"
        );
        expect(lastLaunch().systemPrompt).toContain(
          "Dispatch job startup rules"
        );
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

    it("should round-trip autoReview through getAgent", async () => {
      const created = await manager.createAgent({
        cwd: "/tmp",
        autoReview: true,
        useWorktree: false,
      });
      const fetched = await manager.getAgent(created.id);

      expect(fetched).not.toBeNull();
      expect(fetched!.autoReview).toBe(true);
    });

    it("should include autoReview in listAgents results", async () => {
      await manager.createAgent({
        name: "review-on",
        cwd: "/tmp",
        autoReview: true,
        useWorktree: false,
      });
      await manager.createAgent({
        name: "review-off",
        cwd: "/tmp",
        autoReview: false,
        useWorktree: false,
      });

      const agents = await manager.listAgents();
      const reviewOn = agents.find((a) => a.name === "review-on");
      const reviewOff = agents.find((a) => a.name === "review-off");

      expect(reviewOn!.autoReview).toBe(true);
      expect(reviewOff!.autoReview).toBe(false);
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
      expect(runtime.prompt).toHaveBeenLastCalledWith(agent.id, "next");
      expect(manager.isPromptHeld(agent.id)).toBe(true);
      await manager.cancelTurn(agent.id);
      expect(runtime.cancel).toHaveBeenCalledWith(agent.id);
    });
  });

  describe("runtime events", () => {
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
      expect((await manager.getAgent(agent.id))!.latestEvent).toMatchObject({
        type: "working",
        message: "Fix the login bug",
      });

      await runtime.emit(
        agent.id,
        { type: "turn", agentId: agent.id, state: "settled" },
        2
      );
      expect((await manager.getAgent(agent.id))!.latestEvent).toMatchObject({
        type: "idle",
      });

      const store = new BlockStore(pool);
      await store.insert({
        streamId: agent.id,
        author: { kind: "agent", agentId: agent.id },
        kind: "question",
        text: "Ship it?",
        data: { options: [{ label: "Yes" }] },
        state: {},
      });
      // A stream prompt names its block by id; the status reads the text back.
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
      expect((await manager.getAgent(agent.id))!.latestEvent).toMatchObject({
        type: "working",
        message: "Please also update the docs",
      });
      await runtime.emit(
        agent.id,
        { type: "turn", agentId: agent.id, state: "settled" },
        4
      );
      expect((await manager.getAgent(agent.id))!.latestEvent).toMatchObject({
        type: "waiting_user",
        message: "Ship it?",
      });

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
      expect((await manager.getAgent(agent.id))!.latestEvent).toMatchObject({
        type: "blocked",
        message: "rate limited",
      });
    });

    it("marks the agent waiting as soon as it posts a question", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });
      await manager.noteQuestionPosted(agent.id, "Which branch?\nmain or dev");
      expect((await manager.getAgent(agent.id))!.latestEvent).toMatchObject({
        type: "waiting_user",
        message: "Which branch?",
      });
    });

    it("should put a running agent into error when its engine exits unexpectedly", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });
      const upserts: string[] = [];
      manager.onLatestEvent((record) => upserts.push(record.status));

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
      expect(fetched!.latestEvent).toMatchObject({ type: "blocked" });
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
  });

  describe("upsertLatestEvent", () => {
    it("should persist an event on an agent", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });

      const updated = await manager.upsertLatestEvent(agent.id, {
        type: "working",
        message: "Doing stuff",
      });

      expect(updated.latestEvent).not.toBeNull();
      expect(updated.latestEvent!.type).toBe("working");
      expect(updated.latestEvent!.message).toBe("Doing stuff");
      expect(updated.latestEvent!.updatedAt).toBeTruthy();
    });

    it("should overwrite a previous event", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });

      await manager.upsertLatestEvent(agent.id, {
        type: "working",
        message: "Step 1",
      });

      const updated = await manager.upsertLatestEvent(agent.id, {
        type: "done",
        message: "Step 2",
      });

      expect(updated.latestEvent!.type).toBe("done");
      expect(updated.latestEvent!.message).toBe("Step 2");
    });

    it("should store metadata", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });

      const updated = await manager.upsertLatestEvent(agent.id, {
        type: "blocked",
        message: "Waiting on build",
        metadata: { source: "ci", buildId: "123" },
      });

      expect(updated.latestEvent!.metadata).toEqual({
        source: "ci",
        buildId: "123",
      });
    });

    it("should reject empty message", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });

      await expect(
        manager.upsertLatestEvent(agent.id, { type: "working", message: "  " })
      ).rejects.toThrow("non-empty");
    });

    it("should return 404 for non-existent agent", async () => {
      try {
        await manager.upsertLatestEvent("agt_nonexistent", {
          type: "working",
          message: "hello",
        });
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(AgentError);
        expect((err as InstanceType<typeof AgentError>).statusCode).toBe(404);
      }
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
        `INSERT INTO files (agent_id, file_name, source, size_bytes) VALUES ($1, 'test.png', 'screenshot', 100)`,
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
      expect(stopped.latestEvent?.message).toBe("Session stopped.");
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
      expect(failed!.latestEvent?.type).toBe("blocked");
    });
  });

  describe("startAgent", () => {
    async function createStoppedAgent(
      opts: { type?: "claude" | "codex"; persona?: string } = {}
    ) {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        type: opts.type ?? "claude",
        useWorktree: false,
        persona: opts.persona,
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
      expect(started.latestEvent?.message).toBe(
        "Reattached to the running agent."
      );
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
      expect(started.latestEvent?.message).toBe("Session resumed.");
    });

    it("should record the fresh session when the engine could not resume", async () => {
      const agent = await createStoppedAgent();
      runtime.launch.mockResolvedValueOnce({
        sessionId: "sess_fresh",
        resumed: false,
      });

      const started = await manager.startAgent(agent.id);

      expect(started.cliSessionId).toBe("sess_fresh");
      expect(started.latestEvent?.message).toBe("Session started.");
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
      expect(started.latestEvent?.message).toBe("Session started.");
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
      expect(failed!.latestEvent?.type).toBe("blocked");
      expect(failed!.latestEvent?.message).toContain("Failed to start agent");
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
        const agent = await createStoppedAgent({ persona: "security-review" });

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

        expect(lastLaunch().env.DISPATCH_FILES_DIR).toBe(
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

      const result = await manager.restoreRunningAgents();

      expect(result).toEqual({ attached: [alive.id], lost: [gone.id] });
      expect(runtime.attach).not.toHaveBeenCalledWith(stopped.id);
      expect((await manager.getAgent(alive.id))!.status).toBe("running");
      const lost = await manager.getAgent(gone.id);
      expect(lost!.status).toBe("stopped");
      expect(lost!.lastError).toContain("not running when Dispatch restarted");
      expect(lost!.latestEvent?.message).toBe(
        "Session ended while Dispatch was down."
      );
    });
  });

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
      expect(reconciled!.latestEvent?.message).toContain(
        "The agent is no longer running."
      );
    });

    it("should leave agents with a live host alone", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });

      expect(await manager.reconcileAgentStatuses()).toEqual([]);
      expect((await manager.getAgent(agent.id))!.status).toBe("running");
    });

    it("should stop hosts left behind by stopped agents", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });
      await pool.query(`UPDATE agents SET status = 'stopped' WHERE id = $1`, [
        agent.id,
      ]);
      runtime.listHosted.mockResolvedValue([agent.id]);

      await manager.reconcileAgents();

      expect(runtime.stop).toHaveBeenCalledWith(agent.id, true);
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
        `INSERT INTO files (agent_id, file_name, source, size_bytes, description)
         VALUES ($1, 'doc.pdf', 'upload', 4096, 'Product brief')`,
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
          `INSERT INTO files (agent_id, file_name, source, size_bytes)
           VALUES ($1, 'screen.png', 'screenshot', 256)`,
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

  describe("upsertLatestEventIfCurrent", () => {
    it("should update when expectedUpdatedAt matches", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });

      await manager.upsertLatestEvent(agent.id, {
        type: "working",
        message: "first",
      });

      // The SQL comparison uses `latest_event_updated_at::text`, so we
      // must read the timestamp in the same format the real caller
      // (activity-monitor) uses.
      const { rows } = await pool.query(
        `SELECT latest_event_updated_at::text AS "ts" FROM agents WHERE id = $1`,
        [agent.id]
      );
      const ts = rows[0].ts as string;

      const result = await manager.upsertLatestEventIfCurrent(agent.id, ts, {
        type: "done",
        message: "second",
      });

      expect(result).not.toBeNull();
      expect(result!.latestEvent!.type).toBe("done");
      expect(result!.latestEvent!.message).toBe("second");
    });

    it("should return null when expectedUpdatedAt does not match", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });

      await manager.upsertLatestEvent(agent.id, {
        type: "working",
        message: "first",
      });

      const result = await manager.upsertLatestEventIfCurrent(
        agent.id,
        "1970-01-01 00:00:00",
        { type: "done", message: "stale" }
      );

      expect(result).toBeNull();
    });

    it("should return null for a non-existent agent", async () => {
      const result = await manager.upsertLatestEventIfCurrent(
        "agt_missing",
        "1970-01-01 00:00:00",
        { type: "done", message: "ghost" }
      );

      expect(result).toBeNull();
    });
  });

  describe("checkWorktreeStatus", () => {
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
