import { readRepositoryRoot } from "../helpers/task-scope.js";
import { launchPersonaScope } from "../../src/personas/persona-scope.js";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { Pool } from "pg";
import { withTestWorkspaceRunner } from "../helpers/test-workspace-runner.js";
import { setupTestDb, teardownTestDb, runTestMigrations } from "./setup.js";
import { startupFileUpload } from "../../src/routes/agent-startup.js";
import type { TemplateRecord } from "../../src/templates/store.js";
import type { AgentRuntime } from "../../src/agents/runtime.js";

// Git context and lifecycle hooks shell out; keep them off the host.
vi.mock("../../src/shared/lib/run-command.js", () => ({
  runCommand: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
}));
vi.mock("../../src/agents/workspace-prep.js", () => ({
  installWorkspaceDependencies: vi.fn(async () => {}),
}));

const { AgentManager: HostAgentManager } =
  await import("../../src/agents/manager.js");
const AgentManager = withTestWorkspaceRunner(HostAgentManager);
const { createInertRuntime } = await import("../../src/agents/runtime.js");
const { TemplateService } = await import("../../src/templates/service.js");
const { TaskService } = await import("../../src/tasks/service.js");
const { TemplateStore } = await import("../../src/templates/store.js");

/**
 * Main's behaviour for a local agent's task briefing and session files,
 * pinned before they moved onto the Runner interface (T13b): the briefing
 * names each attachment at its controller path, nothing is read or hashed to
 * write it, an image attachment is never attached inline, and a vanished
 * file keeps its line. A prompt's own files still drop out when missing.
 */

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  fatal: () => {},
  trace: () => {},
  child: () => logger,
  silent: () => {},
  level: "silent",
} as unknown as import("fastify").FastifyBaseLogger;

const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000",
  "hex"
);

let pool: Pool;
let root: string;
let config: import("../../src/config.js").AppConfig;
let projectId: string;
let prompt: ReturnType<typeof vi.fn<AgentRuntime["prompt"]>>;
let manager: InstanceType<typeof AgentManager>;
let tasks: InstanceType<typeof TaskService>;
let templateId: string;

function runtime(): AgentRuntime {
  let sessions = 0;
  prompt = vi.fn<AgentRuntime["prompt"]>(() => ({
    accepted: Promise.resolve(),
    settled: Promise.resolve(),
  }));
  return {
    ...createInertRuntime(),
    tracksProcesses: () => true,
    launch: vi.fn(async () => ({
      sessionId: `sess_${++sessions}`,
      resumed: false,
    })),
    attach: vi.fn(async () => false),
    isAlive: vi.fn(async () => true),
    prompt,
    isBusy: vi.fn(() => false),
    hasOpenTurn: vi.fn(() => false),
    onEvent: () => () => {},
  };
}

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "dispatch-briefing-files-"));
  pool = await setupTestDb();
  await runTestMigrations();
});

afterAll(async () => {
  await teardownTestDb();
  await rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  await pool.query("DELETE FROM tasks");
  await pool.query("DELETE FROM task_columns");
  await pool.query("DELETE FROM agents");
  await pool.query("DELETE FROM projects");
  await pool.query("DELETE FROM templates");
  const repo = path.join(root, "repo");
  await mkdir(repo, { recursive: true });
  config = {
    host: "127.0.0.1",
    port: 6767,
    databaseUrl: "",
    authToken: "test-token",
    filesRoot: path.join(root, "files"),
    dispatchBinDir: path.join(root, "bin"),
    codexBin: "/bin/echo",
    claudeBin: "/bin/echo",
    opencodeBin: "/bin/opencode",
    agentStateRoot: path.join(root, "state"),
    agentRuntime: "acp",
    tls: null,
  };
  await mkdir(config.agentStateRoot, { recursive: true });
  projectId = (
    await pool.query<{ id: string }>(
      `INSERT INTO projects (id, name, repo_root, color) VALUES (gen_random_uuid(), 'Briefing', $1, '#336699') RETURNING id`,
      [repo]
    )
  ).rows[0]!.id;
  manager = new AgentManager(pool, logger, config, { runtime: runtime() });
  const templates = new TemplateService(pool, manager, logger);
  const template: TemplateRecord = await new TemplateStore(pool).createTemplate(
    {
      name: "Builder",
      directory: repo,
      projectId,
      description: null,
      prompt: null,
      agentType: "claude",
      useWorktree: false,
      baseBranch: null,
      branchName: null,
      fullAccess: false,
      callable: false,
      allowFiles: false,
    }
  );
  templateId = template.id;
  tasks = new TaskService({
    readRepositoryRoot,
    pool,
    filesRoot: config.filesRoot,
    getAgent: async (id) => {
      const agent = await manager.getAgent(id);
      return agent && { id, name: agent.name, status: agent.status, projectId };
    },
    getTemplate: async (id) => (id === templateId ? template : null),
    launchTemplate: async (input) =>
      (await templates.launchTemplate(input)).agent,
    chat: {
      closeStream: async () => {},
      releaseStream: () => {},
      withdrawDeliveries: async () => () => {},
      sendUserPost: (async () => ({
        block: { id: "00000000-0000-4000-8000-000000000001" },
        delivered: null,
        held: false,
      })) as never,
      post: (async () => ({ id: "reply-block" })) as never,
    },
    publishUiEvent: () => {},
    log: { warn: vi.fn(), info: vi.fn() },
    personaScope: (target) => launchPersonaScope(manager, target),
  });
});

afterEach(async () => {
  await chmod(path.join(config.filesRoot), 0o755).catch(() => {});
});

async function taskWithAttachments() {
  const task = await tasks.createTask(
    { projectId, title: "Read the context" },
    { kind: "user" },
    {
      startupFiles: [
        startupFileUpload(
          "notes.md",
          "notes.md",
          Buffer.from("# Notes\nread me")
        ),
        startupFileUpload("shot.png", "shot.png", PNG),
      ],
    }
  );
  const detail = await tasks.getTaskDetail(task.id);
  const paths = await Promise.all(
    detail.attachments.map(
      async (attachment) =>
        (await tasks.attachmentFile(task.id, attachment.id)).path
    )
  );
  return { task, notes: paths[0]!, shot: paths[1]! };
}

async function firstTurn(agentId: string) {
  await vi.waitFor(() =>
    expect(prompt.mock.calls.some(([id]) => id === agentId)).toBe(true)
  );
  const [, text, , opts] = prompt.mock.calls.find(([id]) => id === agentId)!;
  return { text, opts };
}

describe("a local agent's task briefing (main)", () => {
  it("names each attachment at its controller path, with no inline image", async () => {
    const { task, notes, shot } = await taskWithAttachments();
    const briefing = await tasks.briefingFor(task.id);
    expect(briefing.text).toContain(
      `Attachments:\n- notes.md (text/markdown) — ${notes}\n- shot.png (image/png) — ${shot}\n`
    );

    const { agent } = await tasks.launchAgent(
      task.id,
      { templateId },
      { kind: "user" }
    );
    const { text, opts } = await firstTurn(agent.id);
    expect(text).toContain(briefing.text);
    expect(opts?.images ?? []).toEqual([]);
  });

  it("keeps a vanished or unreadable file's line without reading it", async () => {
    const { task, notes, shot } = await taskWithAttachments();
    await rm(notes);
    // Unreadable: any read or hash of it would fail.
    await chmod(shot, 0o000);
    try {
      const briefing = await tasks.briefingFor(task.id);
      expect(briefing.text).toContain(
        `- notes.md (text/markdown) — ${notes}\n- shot.png (image/png) — ${shot}\n`
      );
      const { agent } = await tasks.launchAgent(
        task.id,
        { templateId },
        { kind: "user" }
      );
      const { text, opts } = await firstTurn(agent.id);
      expect(text).toContain(briefing.text);
      expect(opts?.images ?? []).toEqual([]);
    } finally {
      await chmod(shot, 0o644);
    }
  });

  it("is the first turn of an agent created by hand for the task", async () => {
    const { task, notes } = await taskWithAttachments();
    await rm(notes);
    const briefing = await tasks.briefingFor(task.id);
    const agent = await manager.createAgent({
      cwd: path.join(root, "repo"),
      useWorktree: false,
      initialPrompt: briefing.text,
    });
    const { text, opts } = await firstTurn(agent.id);
    expect(text).toContain(briefing.text);
    expect(opts?.images ?? []).toEqual([]);
  });
});

describe("a local agent's session files (main)", () => {
  it("hands a prompt file over in place and drops a missing one", async () => {
    const agent = await manager.createAgent({
      cwd: path.join(root, "repo"),
      useWorktree: false,
    });
    const dir = path.join(root, "prompt-files");
    await mkdir(dir, { recursive: true });
    const present = path.join(dir, "present.png");
    const missing = path.join(dir, "missing.png");
    await writeFile(present, PNG);
    const text = `see ${present} and ${missing}`;
    const prepared = await manager["preparePromptFiles"](
      agent.id,
      [
        { path: present, mimeType: "image/png", runnerName: "present.png" },
        { path: missing, mimeType: "image/png", runnerName: "missing.png" },
      ],
      text
    );
    expect(prepared).toEqual({
      images: [{ path: present, mimeType: "image/png" }],
      text,
    });
  });

  it("lists a reference at its own path even when the file is gone", async () => {
    const agent = await manager.createAgent({
      cwd: path.join(root, "repo"),
      useWorktree: false,
    });
    const gone = path.join(root, "gone", "report.txt");
    await expect(
      manager.deliverSessionFile(agent, gone, "report.txt", "reference")
    ).resolves.toBe(gone);
    await expect(
      manager.deliverSessionFile(agent, gone, "report.txt")
    ).rejects.toThrow();
  });

  it("collects a local session file's bytes as they are", async () => {
    const agent = await manager.createAgent({
      cwd: path.join(root, "repo"),
      useWorktree: false,
    });
    const file = path.join(root, "collect.bin");
    const bytes = Buffer.from([0, 1, 2, 255, 254]);
    await writeFile(file, bytes);
    const collected = await manager.collectSessionFile(agent, file);
    expect(Buffer.compare(collected, bytes)).toBe(0);
  });
});
