import { spawn, execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  realpath,
  readdir,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { text } from "node:stream/consumers";
import { vi } from "vitest";
import { createSessionCore } from "@dispatch/runner/cli";
import {
  displayPath,
  sessionFromWire,
  pathFromWire,
  RunnerCallError,
  type Runner,
} from "@dispatch/runner-protocol/contract";
import { createSessionSupervisor } from "../../../../packages/runner/src/workload/agents/remote/session-supervisor.js";
import { enrolledSessions } from "../../../../packages/runner/src/workload/agents/remote/session-operations.js";
import { enrolledWorkspace } from "../../../../packages/runner/src/workload/agents/remote/workspace-operations.js";
import { enrolledCheckouts } from "../../../../packages/runner/src/workload/agents/remote/checkout-operations.js";
import { createCheckoutWorkload } from "../../../../packages/runner/src/workload/agents/checkout-worker.js";
import { observeGitCheckout } from "../../../../packages/runner/src/workload/agents/checkout-inspection.js";
import { createRemoteWorkspacePreparation } from "../../../../packages/runner/src/platform/linux-privsep/index.js";
import { bindingFileName } from "../../../../packages/runner/src/local/bindings.js";
import { startTestLocalRunner } from "./local-runner-child.js";
import { streamHelper } from "./stream-helper.js";
import { createInertRuntime } from "../../src/agents/runtime.js";
import {
  controllerPlacement,
  placementForRunner,
} from "../../src/runners/placement.js";
import type { ArchiveDeps } from "../../src/agents/archive.js";
import type {
  AgentRecord,
  WorktreeCleanupMode,
} from "../../src/agents/types.js";

export type Kind = "Local folder" | "Local repository" | "runner";
export const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const entry = fileURLToPath(new URL("../../src/main.ts", import.meta.url));

/** Real handlers/filesystems; only OS process launching and the controller DB are substituted. */
export async function archiveParityHarness() {
  const root = await realpath(await mkdtemp("/tmp/archive-parity-"));
  const home = join(root, "home"),
    source = join(root, "source"),
    bare = join(root, "origin.git");
  await mkdir(home);
  await mkdir(source);
  git(source, "init", "-q", "-b", "main");
  await writeFile(join(source, "base.txt"), "base\n");
  git(source, "add", ".");
  git(
    source,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.test",
    "commit",
    "-qm",
    "base"
  );
  for (const name of ["folder", "repository", "runner"])
    git(source, "branch", `user/${name}`);
  git(root, "clone", "--bare", "-q", source, bare);
  git(source, "remote", "add", "origin", bare);
  git(source, "fetch", "-q", "origin");
  const repository = "https://github.com/fixture/archive-parity";
  const config = join(home, "gitconfig");
  execFileSync("git", [
    "config",
    "--file",
    config,
    `url.file://${bare}.insteadOf`,
    repository,
  ]);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    TMPDIR: process.env.TMPDIR,
    GH_CONFIG_DIR: join(home, "gh"),
    XDG_CONFIG_HOME: join(home, "config"),
    GIT_CONFIG_GLOBAL: config,
    GIT_CONFIG_NOSYSTEM: "1",
  };
  vi.stubEnv("GIT_CONFIG_GLOBAL", config);
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  const localState = join(root, "local");
  const local = startTestLocalRunner(localState, {
    env: Object.fromEntries(
      Object.entries(env).filter(
        (x): x is [string, string] => typeof x[1] === "string"
      )
    ),
  });
  await local.ready();
  const state = join(root, "enrolled");
  const asWorkload = async (bin: string, args: string[]) =>
    execFileSync(bin, args, {
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
  let prep:
    | Awaited<ReturnType<typeof createRemoteWorkspacePreparation>>
    | undefined;
  const supervisor = await createSessionSupervisor(
    {
      state,
      streamHelper,
      build: { version: "1.7.39", revision: "a".repeat(40) },
      uid: process.getuid!(),
      gid: process.getgid!(),
      ca: join(root, "unused-ca"),
      bins: { claudeBin: "", codexBin: "" },
      env,
      hostCommand: () => {
        throw new Error("Archive matrix never launches an engine");
      },
      sessions: createSessionCore,
      asWorkload,
      observeCheckout: (dir) => observeGitCheckout(dir),
      bindingWritten: async (id) => {
        await prep?.bindingWritten(id);
      },
      removePreparedCheckout: async (id) => (await prep?.remove(id)) ?? false,
      forgetPreparedCheckout: async (id) => {
        await prep?.forget(id);
      },
    },
    {
      acquire: () => () => {},
      alive: () => false,
      stop: async () => {},
      cleanup: async () => {},
      cleanupLegacy: async () => {},
      socketInUse: () => false,
      socketMatchesHost: () => true,
      spawn: async () => {
        throw new Error("No engine process expected");
      },
    }
  );
  const step = async (method: string, args: unknown[]) => {
    const child = spawn(
      process.env.BUN_BINARY ?? "bun",
      ["--no-env-file", entry, "runner-worker", method, ""],
      { env, stdio: ["pipe", "pipe", "pipe"] }
    );
    const out = text(child.stdout),
      err = text(child.stderr);
    const done = new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    child.stdin.end(JSON.stringify(args));
    const [code, stdout, stderr] = await Promise.all([done, out, err]);
    if (code !== 0)
      throw new Error(stderr || `Worker ${method} exited ${code}`);
    const reply = JSON.parse(stdout);
    if (reply.error) throw new RunnerCallError(reply.error);
    return reply.data;
  };
  prep = await createRemoteWorkspacePreparation({
    state,
    ids: {
      supervisor: process.getuid!(),
      uid: process.getuid!(),
      gid: process.getgid!(),
    },
    asWorkload,
    step,
  });
  const sessions = enrolledSessions(supervisor, () => {}).calls;
  const preparation = enrolledWorkspace(supervisor, prep, () => {});
  const workload = createCheckoutWorkload();
  const checkout = enrolledCheckouts(
    supervisor,
    {
      run: async () => {
        throw new Error("Unexpected query");
      },
      manifest: async () => {
        throw new Error("Unexpected manifest command");
      },
      read: (directory, input, signal) =>
        Readable.from(
          (async function* () {
            const req = input as { op: "checkout.read"; request: never };
            yield JSON.stringify({
              data: await workload.run(
                req.op,
                { directory, request: req.request },
                { signal }
              ),
            });
          })()
        ),
    },
    new AbortController().signal
  );
  const context = {
    emit: () => {},
    receiveBlob: async () => {
      throw new Error("Unexpected blob");
    },
  };
  const call: Runner["call"] = async (op, input) => {
    if (op === "checkout.read")
      return JSON.parse(
        await text(
          await checkout.checkoutRead(
            op,
            input as never,
            new AbortController().signal
          )
        )
      ).data;
    const handler =
      op in preparation
        ? preparation[op as keyof typeof preparation]
        : sessions[op as keyof typeof sessions];
    if (!handler) throw new Error(`Unexpected ${op}`);
    return (handler as (input: unknown, context: unknown) => Promise<never>)(
      input,
      context
    );
  };
  const remote = {
    connectionEpoch: () => 1,
    call: async (
      _id: string,
      op: Parameters<Runner["call"]>[0],
      input: never
    ) => call(op, input),
  };
  let next = 0;
  return {
    root,
    async close() {
      supervisor.close();
      await local.stop();
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    },
    async fixture(kind: Kind, existingBranch = false) {
      const id = `agt_parity${++next}`,
        session = sessionFromWire(id),
        branch = existingBranch
          ? `user/${kind === "Local folder" ? "folder" : kind === "Local repository" ? "repository" : "runner"}`
          : `parity/case${next}`;
      const runner = kind === "runner" ? { call } : local.session;
      const request = {
        session,
        source:
          kind === "Local folder"
            ? { directory: pathFromWire(source) }
            : {
                repository,
                checkout: {
                  kind: existingBranch ? ("branch" as const) : ("new" as const),
                  branch,
                },
              },
        ...(kind === "Local folder"
          ? {
              worktree: {
                name: id,
                branch,
                base: existingBranch ? branch : "main",
                create: !existingBranch,
                location: "sibling" as const,
              },
            }
          : {}),
        copyIgnored: [],
        installDependencies: false,
      };
      const prepared = await runner.call("workspace.prepare", request);
      const dir = displayPath(prepared.path),
        common = git(
          dir,
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir"
        );
      const host =
        kind === "runner" ? join(state, "hosts", id) : join(localState, id);
      await mkdir(host, { recursive: true });
      await writeFile(join(host, "stale-host-state"), "stopped host\n");
      const agent = {
        id,
        name: id,
        type: "codex",
        status: "stopped",
        placement:
          kind === "runner"
            ? placementForRunner("parity-runner")
            : controllerPlacement,
        cwd: dir,
        worktreePath: dir,
        worktreeBranch: branch,
        baseBranch: existingBranch ? branch : "main",
        workspacePath: null,
        launchCwd: dir,
        archivePhase: null,
        archiveCleanupMode: "auto",
        lastError: null,
      } as AgentRecord;
      let deleted = false,
        pending = false;
      const pool = {
        query: vi.fn(async (sql: string, values: unknown[] = []) => {
          if (sql.includes('AS "repositorySource"'))
            return {
              rows: [
                {
                  repositorySource: kind !== "Local folder",
                  preparationPending: false,
                  repositoryBranchCreated: !existingBranch,
                },
              ],
              rowCount: 1,
            };
          if (sql.includes("SET status = 'archiving'")) {
            agent.status = "archiving";
            agent.archiveCleanupMode = values[1] as WorktreeCleanupMode;
            return { rows: [{ id }], rowCount: 1 };
          }
          if (sql.includes("SET archive_cleanup_mode = 'keep'"))
            agent.archiveCleanupMode = "keep";
          if (sql.includes("SET deleted_at = NOW()")) {
            deleted = true;
            pending = values[1] === true;
          }
          return { rows: [], rowCount: 0 };
        }),
      };
      const errors: unknown[] = [];
      const deps = {
        pool,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        runtime: {
          ...createInertRuntime(),
          stop: async () => {
            await runner.call("session.stop", { session, force: true });
          },
          clearRemoteState: async () => {},
        },
        ...(kind === "runner"
          ? { remote }
          : { localRunnerChild: () => local.session }),
        diffStatsRefresher: null,
        getAgent: async () => agent,
        getRequiredAgent: async () => agent,
        setAgentStatus: async (_id: string, status: AgentRecord["status"]) => {
          agent.status = status;
        },
        beginStopStream: () => {},
        settleStream: async () => 0,
        setArchivePhase: async (
          _id: string,
          phase: AgentRecord["archivePhase"]
        ) => {
          agent.archivePhase = phase;
        },
      } as unknown as ArchiveDeps;
      const bindingRoot =
        kind === "runner"
          ? join(state, "bindings")
          : join(localState, ".bindings");
      const receipt =
        kind === "runner" ? join(bindingRoot, "workspace", id) : host;
      return {
        kind,
        id,
        session,
        branch,
        dir,
        common,
        agent,
        deps,
        runner,
        host,
        receipt,
        bindingRoot,
        errors,
        callbacks: {
          onPhaseChange: () => {},
          onComplete: () => {},
          onError: (err: unknown) => errors.push(err),
        },
        deleted: () => deleted,
        pending: () => pending,
        async leftovers() {
          const names = await readdir(bindingRoot);
          return names.filter(
            (n) =>
              (n === id || n.startsWith(id + ".")) && !n.endsWith(".retired")
          );
        },
        async cleanup() {
          if (existsSync(dir))
            execFileSync("git", [
              `--git-dir=${common}`,
              "worktree",
              "remove",
              "--force",
              dir,
            ]);
          execFileSync("git", [`--git-dir=${common}`, "branch", "-D", branch], {
            stdio: "ignore",
          });
        },
        binding:
          kind === "runner"
            ? join(bindingRoot, ".bindings", bindingFileName(id))
            : join(bindingRoot, bindingFileName(id)),
      };
    },
  };
}
