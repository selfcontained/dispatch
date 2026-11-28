/*
 * A Local launch from a repository-only project that fails before any
 * checkout exists (the requested base is not on the remote) leaves a row
 * with no folder. Archive must still preview and remove it: nothing to
 * remove in the preview, then the row, the preparation receipt and the
 * host state go. The database and the Local runner child are real.
 */
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Pool } from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { runTestMigrations, setupTestDb, teardownTestDb } from "./setup.js";
import { createInertRuntime } from "../../src/agents/runtime.js";
import type { AgentRuntime } from "../../src/agents/runtime.js";
import { removeHostState } from "../../src/files/session-directories.js";
import { runCommand } from "../../src/shared/lib/run-command.js";
import { startTestLocalRunner } from "../helpers/local-runner-child.js";

const { AgentManager } = await import("../../src/agents/manager.js");

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

const git = async (cwd: string, ...args: string[]) =>
  (await runCommand("git", ["-C", cwd, ...args])).stdout.trim();

let pool: Pool;
let root: string;
let state: string;
let child: ReturnType<typeof startTestLocalRunner>;
const repository = "https://github.com/fixture/hello-world";

beforeAll(async () => {
  pool = await setupTestDb();
  await runTestMigrations();
  root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "repo-launch-failure-"))
  );
  state = path.join(root, "state");
  await mkdir(state);
  await mkdir(path.join(root, "files"));
  const source = path.join(root, "source");
  const remote = path.join(root, "remote.git");
  await mkdir(source);
  await git(source, "init", "-q", "-b", "master");
  await git(source, "config", "user.name", "Test");
  await git(source, "config", "user.email", "test@example.test");
  await writeFile(path.join(source, "README"), "hello\n");
  await git(source, "add", ".");
  await git(source, "commit", "-qm", "base");
  await git(root, "clone", "-q", "--bare", source, remote);
  const config = path.join(root, "gitconfig");
  await runCommand("git", [
    "config",
    "--file",
    config,
    `url.file://${remote}.insteadOf`,
    repository,
  ]);
  child = startTestLocalRunner(state, {
    env: { GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1" },
  });
  await child.ready();
});

afterAll(async () => {
  await child?.stop();
  await teardownTestDb();
  await rm(root, { recursive: true, force: true });
});

function manager() {
  const runtime = {
    ...createInertRuntime(),
    tracksProcesses: () => true,
    launch: vi.fn(async () => ({ sessionId: "sess", resumed: false })),
    attach: vi.fn(async () => false),
    isAlive: vi.fn(async () => false),
    // As the ACP runtime clears a stopped host's state.
    clearRemoteState: vi.fn((agentId: string) =>
      removeHostState(state, agentId)
    ),
  } as AgentRuntime;
  const instance = new AgentManager(
    pool,
    noopLogger,
    {
      host: "127.0.0.1",
      port: 6767,
      databaseUrl: "",
      authToken: "test-token",
      filesRoot: path.join(root, "files"),
      agentStateRoot: state,
      dispatchBinDir: "/tmp",
      codexBin: "echo",
      claudeBin: "echo",
      opencodeBin: "echo",
      agentRuntime: "acp",
      tls: null,
    },
    { runtime }
  );
  instance.attachLocalRunner(() => child.session);
  return instance;
}

it("previews and archives a Local repository launch that failed before its checkout existed", async () => {
  await pool.query(
    "INSERT INTO projects (id, name, repo_root, repository) VALUES ('hello', 'Hello-World', NULL, $1)",
    [repository]
  );
  const agents = manager();
  await expect(
    agents.createAgent({
      cwd: "",
      projectId: "hello",
      type: "codex",
      useWorktree: true,
      baseBranch: "main",
    })
  ).rejects.toThrow(/main/);
  const {
    rows: [failed],
  } = await pool.query<{ id: string; cwd: string; worktree_path: null }>(
    "SELECT id, cwd, worktree_path FROM agents WHERE deleted_at IS NULL"
  );
  expect(failed).toMatchObject({ cwd: "", worktree_path: null });

  const preview = await agents.checkArchivePreview(failed!.id);
  expect(preview).toMatchObject({
    worktreeStatus: null,
    cleanupDescriptions: [],
  });
  expect(preview).not.toHaveProperty("worktreeStatusUnreadable");

  await agents.beginArchive(failed!.id, "auto");
  const onError = vi.fn();
  await agents.executeArchive(failed!.id, {
    onPhaseChange: () => {},
    onComplete: () => {},
    onError,
  });
  expect(onError).not.toHaveBeenCalled();
  const {
    rows: [archived],
  } = await pool.query<{ deleted: boolean; cleanup: boolean }>(
    "SELECT deleted_at IS NOT NULL AS deleted, runner_cleanup_pending AS cleanup FROM agents WHERE id = $1",
    [failed!.id]
  );
  expect(archived).toEqual({ deleted: true, cleanup: false });
  expect(existsSync(path.join(state, failed!.id))).toBe(false);
  expect(
    (await readdir(state)).filter((name) => name.includes(failed!.id))
  ).toEqual([]);
});
