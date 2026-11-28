import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Pool } from "pg";
import { afterEach, expect, it, vi } from "vitest";
import {
  sessionFromWire,
  displayPath,
} from "@dispatch/runner-protocol/contract";
import {
  beginArchive,
  executeArchive,
  deleteAgentDirect,
  type ArchiveDeps,
} from "../src/agents/archive.js";
import { createInertRuntime } from "../src/agents/runtime.js";
import type { AgentRecord, WorktreeCleanupMode } from "../src/agents/types.js";
import { controllerPlacement } from "../src/runners/placement.js";
import { bindingFromRow } from "../src/runners/local-bindings.js";
import { runCommand } from "../src/shared/lib/run-command.js";
import { startTestLocalRunner } from "./helpers/local-runner-child.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const git = async (cwd: string, ...args: string[]) =>
  (await runCommand("git", ["-C", cwd, ...args])).stdout;

async function fixture(
  options: { interrupt?: boolean; existingBranch?: boolean; pool?: Pool } = {}
) {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "local-repo-interrupted-"))
  );
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const remote = path.join(root, "remote.git");
  const hosts = path.join(root, "hosts");
  const hookLog = path.join(root, "hooks");
  await mkdir(path.join(source, ".dispatch"), { recursive: true });
  await git(source, "init", "-q", "-b", "main");
  await git(source, "config", "user.name", "Test");
  await git(source, "config", "user.email", "test@example.test");
  await writeFile(path.join(source, "base.txt"), "base\n");
  await writeFile(
    path.join(source, ".dispatch/tools.json"),
    JSON.stringify({
      hooks: Object.fromEntries(
        ["stop", "archive"].map((hook) => [
          hook,
          {
            command: [
              "sh",
              "-c",
              'printf "%s\\n" "$1" >> "$2"',
              "sh",
              hook,
              hookLog,
            ],
          },
        ])
      ),
    })
  );
  const installStarted = path.join(root, "install-started");
  const allowInstall = path.join(root, "allow-install");
  const installLog = path.join(root, "install-log");
  const bin = path.join(root, "bin");
  if (options.interrupt) {
    await mkdir(bin);
    await writeFile(
      path.join(source, "package.json"),
      '{"name":"partial","private":true}'
    );
    await writeFile(path.join(source, "pnpm-lock.yaml"), "");
    await writeFile(path.join(source, ".gitignore"), "installed\n");
    await writeFile(
      path.join(bin, "pnpm"),
      `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(installLog)}, 'install\\n');
fs.writeFileSync(${JSON.stringify(installStarted)}, JSON.stringify({ pid: process.pid, path: process.cwd() }));
const finish = () => fs.writeFileSync('installed', 'yes');
if (fs.existsSync(${JSON.stringify(allowInstall)})) finish();
else {
  const timer = setInterval(() => {
    if (fs.existsSync(${JSON.stringify(allowInstall)})) { clearInterval(timer); finish(); }
  }, 20);
}
`,
      { mode: 0o700 }
    );
  }
  await git(source, "add", ".");
  await git(source, "commit", "-qm", "base");
  await git(root, "clone", "-q", "--bare", source, remote);
  const repository = "https://github.com/fixture/archive";
  const config = path.join(root, "gitconfig");
  await runCommand("git", [
    "config",
    "--file",
    config,
    `url.file://${remote}.insteadOf`,
    repository,
  ]);
  const child = startTestLocalRunner(hosts, {
    env: {
      GIT_CONFIG_GLOBAL: config,
      GIT_CONFIG_NOSYSTEM: "1",
      PATH: bin + path.delimiter + process.env.PATH,
    },
  });
  cleanups.push(() => child.stop());
  await child.ready();
  const session = sessionFromWire("agt_archive_repository");
  const branch = options.existingBranch ? "main" : "feature/archive";
  const abort = new AbortController();
  const preparation = child.session.call(
    "workspace.prepare",
    {
      session,
      source: {
        repository,
        checkout: options.existingBranch
          ? { kind: "branch", branch }
          : { kind: "new", branch },
      },
      copyIgnored: [],
      installDependencies: Boolean(options.interrupt),
    },
    { signal: abort.signal }
  );
  let checkout: string;
  if (options.interrupt) {
    const result = preparation.catch((error: unknown) => error);
    await expect.poll(() => existsSync(installStarted)).toBe(true);
    const installing = JSON.parse(await readFile(installStarted, "utf8"));
    checkout = installing.path;
    abort.abort();
    process.kill(child.current()!.pid, "SIGKILL");
    // This test owns the package-manager pid too; do not orphan it when the
    // parent is killed (launchd handles its service process group in production).
    process.kill(installing.pid, "SIGKILL");
    await result;
    await child.ready(1);
  } else {
    checkout = displayPath((await preparation).path);
  }
  const agent = {
    id: String(session),
    type: "codex",
    status: "stopped",
    placement: controllerPlacement,
    cwd: options.interrupt ? "" : checkout,
    worktreePath: options.interrupt ? null : checkout,
    worktreeBranch: options.interrupt ? null : branch,
    baseBranch: options.interrupt ? null : "main",
    workspacePath: null,
    launchCwd: options.interrupt ? "" : checkout,
    setupPhase: options.interrupt ? "deps" : null,
    archivePhase: null,
    archiveCleanupMode: "auto",
    lastError: null,
  } as AgentRecord;
  if (options.pool) {
    await options.pool.query(
      `INSERT INTO agents (id, name, type, status, cwd, setup_phase, runner_preparation)
       VALUES ($1, $1, 'codex', 'stopped', '', 'deps', $2::jsonb)`,
      [
        agent.id,
        JSON.stringify({
          source: {
            repository,
            checkout: {
              kind: options.existingBranch ? "branch" : "new",
              branch,
            },
          },
          copyIgnored: [],
          installDependencies: true,
          pending: true,
        }),
      ]
    );
  }
  let deleted = false;
  const events: string[] = [];
  const pool = {
    query: vi.fn(async (sql: string, values: unknown[] = []) => {
      const actual = options.pool
        ? await options.pool.query(sql, values)
        : undefined;
      if (sql.includes('AS "repositorySource"'))
        return (
          actual ?? {
            rows: [
              {
                repositorySource: true,
                preparationPending: Boolean(options.interrupt),
                repositoryBranchCreated: !options.existingBranch,
              },
            ],
            rowCount: 1,
          }
        );
      if (sql.includes("SET status = 'archiving'")) {
        agent.status = "archiving";
        agent.archiveCleanupMode = values[1] as WorktreeCleanupMode;
        return actual ?? { rows: [{ id: agent.id }], rowCount: 1 };
      }
      if (sql.includes("SET archive_cleanup_mode = 'keep'"))
        agent.archiveCleanupMode = "keep";
      if (sql.includes("SET deleted_at = NOW()")) {
        deleted = true;
        events.push("deleted");
      }
      return actual ?? { rows: [], rowCount: 0 };
    }),
  };
  const runtime = {
    ...createInertRuntime(),
    stop: vi.fn(async () => {
      await child.session.call("session.stop", { session, force: true });
      events.push("stop");
    }),
    discard: vi.fn(async () => {
      events.push("discard");
      await child.session.call("session.discard", { session });
    }),
    clearRemoteState: vi.fn(async () => {
      events.push("clear-state");
      await rm(path.join(hosts, agent.id), { recursive: true, force: true });
    }),
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const deps = {
    pool,
    logger,
    runtime,
    localRunnerChild: () => child.session,
    diffStatsRefresher: null,
    getAgent: async () => agent,
    getRequiredAgent: async () => agent,
    setAgentStatus: async (_id, status, lastError) => {
      agent.status = status;
      agent.lastError = lastError;
    },
    beginStopStream: vi.fn(),
    settleStream: async () => 0,
    setArchivePhase: async (_id, phase) => {
      agent.archivePhase = phase;
      events.push(phase);
    },
  } as unknown as ArchiveDeps;
  const callbacks = {
    onPhaseChange: vi.fn(),
    onComplete: vi.fn(),
    onError: vi.fn(),
  };
  const receipt = JSON.parse(
    await readFile(path.join(hosts, agent.id, "workspace-preparation"), "utf8")
  );
  return {
    root,
    hosts,
    child,
    session,
    agent,
    checkout,
    clone: receipt.source as string,
    allowInstall,
    installLog,
    branch,
    hookLog,
    deps,
    callbacks,
    runtime,
    events,
    deleted: () => deleted,
  };
}

it.each([false, true])(
  "archives after the real child dies during dependency installation (existing branch=%s)",
  async (existingBranch) => {
    const f = await fixture({ interrupt: true, existingBranch });
    expect(
      (await f.child.session.call("session.alive", { session: f.session }))
        .state
    ).toBe("gone");
    expect(f.agent.worktreePath).toBeNull();
    expect(existsSync(f.checkout)).toBe(true);
    await beginArchive(f.deps, f.agent.id, "force");
    await executeArchive(f.deps, f.agent.id, f.callbacks);
    expect(f.callbacks.onError).not.toHaveBeenCalled();
    expect(f.deleted()).toBe(true);
    expect(existsSync(f.checkout)).toBe(false);
    expect(existsSync(path.join(f.hosts, f.agent.id))).toBe(false);
    expect(existsSync(f.hookLog)).toBe(false);
    expect(await git(f.clone, "worktree", "list", "--porcelain")).not.toContain(
      `worktree ${f.checkout}\n`
    );
    expect(await readFile(f.installLog, "utf8")).toBe("install\n");
    expect(await git(f.clone, "branch", "--list", f.branch)).toBe(
      existingBranch ? "main" : ""
    );
  }
);

it("resumes the same incomplete repository worktree and reruns dependency preparation", async () => {
  const f = await fixture({ interrupt: true });
  await writeFile(f.allowInstall, "");
  const resumed = await f.child.session.call("workspace.resume", {
    session: f.session,
  });
  expect(resumed && displayPath(resumed.path)).toBe(f.checkout);
  expect(resumed?.worktree?.branch).toBe(f.branch);
  expect(await readFile(path.join(f.checkout, "installed"), "utf8")).toBe(
    "yes"
  );
  expect(await readFile(f.installLog, "utf8")).toBe("install\ninstall\n");
  await f.child.session.call("session.discard", { session: f.session });
});

it.each(["archive", "cascade", "keep", "pending"])(
  "settles the real database's preparation marker after interrupted %s cleanup",
  async (mode) => {
    const { setupTestDb, runTestMigrations, teardownTestDb } =
      await import("./db/setup.js");
    const pool = await setupTestDb();
    try {
      await runTestMigrations();
      const f = await fixture({ interrupt: true, pool });
      if (mode === "pending") f.deps.localRunnerChild = () => undefined;
      if (mode === "cascade") await deleteAgentDirect(f.deps, f.agent.id);
      else {
        await beginArchive(
          f.deps,
          f.agent.id,
          mode === "keep" ? "keep" : "force"
        );
        await executeArchive(f.deps, f.agent.id, f.callbacks);
        expect(f.callbacks.onError).not.toHaveBeenCalled();
      }
      const {
        rows: [row],
      } = await pool.query(
        `SELECT deleted_at IS NOT NULL AS deleted, runner_cleanup_pending AS cleanup,
              runner_preparation ? 'pending' AS pending
       FROM agents WHERE id = $1`,
        [f.agent.id]
      );
      expect(row).toEqual({
        deleted: true,
        cleanup: mode === "pending",
        pending: mode === "pending",
      });
      expect(existsSync(f.checkout)).toBe(
        mode === "keep" || mode === "pending"
      );
      expect(
        existsSync(path.join(f.hosts, f.agent.id, "workspace-preparation"))
      ).toBe(mode === "keep" || mode === "pending");
    } finally {
      await teardownTestDb();
    }
  }
);
