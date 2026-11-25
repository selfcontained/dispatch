import { inferRepositoryUrl } from "../src/agents/checkout-worker.js";
import { runnerWorktree } from "../src/agents/workspace-launch.js";
import { WORKTREE_LOCAL_CONFIG_FILES } from "../src/agents/worktree-local-config-files.js";
import { launchDirectory } from "../src/agents/workspace-launch.js";
/*
 * Local launch preparation through the real local runner child (T18): the
 * app's request goes to `workspace.prepare` on a child running the app's own
 * `posix-user` platform, over its socket. Temp repositories only; every
 * child is stopped at the end of its test.
 */
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyBaseLogger } from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import {
  RunnerCallError,
  sessionFromWire,
} from "@dispatch/runner-protocol/contract";
import {
  superviseRunner,
  type LaunchedRunner,
} from "@dispatch/runner-client/launcher";
import { LocalRunnerSession } from "@dispatch/runner-client/session";
import { createLocalRunner } from "../src/agents/local-runner.js";
import { resolveLaunchDirectory as resolveWorkloadDirectory } from "../src/agents/workspace.js";
import {
  prepareLocalWorkspace,
  resumeLocalWorkspace,
  worktreeRefusal,
} from "../src/agents/workspace-launch.js";
import { runCommand } from "../src/shared/lib/run-command.js";

const logger = { info: vi.fn(), warn: vi.fn() } as unknown as FastifyBaseLogger;
const entry = fileURLToPath(
  new URL("./fixtures/local-runner-entry.ts", import.meta.url)
);
const bun = process.env.BUN_BINARY ?? "bun";
import { embeddedBuild } from "../src/agents/build-identity.js";
const build = {
  version: embeddedBuild.version,
  ...(embeddedBuild.revision && { revision: embeddedBuild.revision }),
};

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const run of cleanups.splice(0).reverse()) await run();
});

async function tempRoot() {
  const root = await mkdtemp(
    path.join(await realpath(os.tmpdir()), "runner-workspace-")
  );
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

/** The app's local runner child on `hosts`, supervised as the app does. */
async function startChild(hosts: string, env: Record<string, string> = {}) {
  const session = new LocalRunnerSession({
    description: {
      runnerId: "local" as never,
      displayName: "Local",
      build,
      protocol: 1 as never,
      engines: [],
      capabilities: {},
    },
  });
  const pids: number[] = [];
  let current: LaunchedRunner | null = null;
  let readyNow: () => void = () => {};
  let ready = new Promise<void>((resolve) => (readyNow = resolve));
  const supervisor = superviseRunner({
    command: [bun, entry, "local-runner"],
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      BUN_RUNTIME_TRANSPILER_CACHE_PATH:
        process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH,
      ...env,
    },
    start: {
      build,
      roots: { state: hosts, files: hosts },
      config: { runnerId: "local", displayName: "Local", engines: [] },
    },
    backoff: { initialMs: 50, maxMs: 200 },
    onState(state) {
      if (state.state === "ready") {
        current = state.runner;
        pids.push(state.runner.pid);
        session.setEndpoint({
          socket: state.runner.ready.socket,
          nonce: state.runner.ready.nonce,
        });
        readyNow();
      } else if (state.state !== "starting") {
        current = null;
        session.setEndpoint(null);
        ready = new Promise<void>((resolve) => (readyNow = resolve));
      }
    },
  });
  cleanups.push(async () => {
    session.close();
    await supervisor.stop(2_000);
  });
  await ready;
  return {
    session,
    pids,
    child: () => {
      if (!current) throw new Error("No child running");
      return current;
    },
  };
}

const git = async (cwd: string, ...args: string[]) =>
  (await runCommand("git", ["-C", cwd, ...args])).stdout;

/** A repository on `main` and `develop`, `.env` ignored and present. */
async function repository(root: string) {
  const checkout = path.join(root, "repository");
  await mkdir(checkout);
  await git(checkout, "init", "-b", "main");
  await writeFile(path.join(checkout, ".gitignore"), ".env\n");
  await git(checkout, "add", ".gitignore");
  const commit = (message: string) =>
    git(
      checkout,
      "-c",
      "user.name=Runner",
      "-c",
      "user.email=runner@example.test",
      "commit",
      "--allow-empty",
      "-m",
      message
    );
  await commit("main");
  await git(checkout, "switch", "-c", "develop");
  await commit("develop");
  const develop = await git(checkout, "rev-parse", "HEAD");
  await git(checkout, "switch", "main");
  await writeFile(path.join(checkout, ".env"), "LOCAL_CONFIG=fixture\n");
  return { checkout, develop };
}

const worktrees = async (checkout: string) =>
  (
    (await git(checkout, "worktree", "list", "--porcelain")).match(
      /^worktree /gm
    ) ?? []
  ).length;

/** The binding the child stored for a session. */
async function stored(hosts: string, session: string) {
  const name = createHash("sha256").update(session).digest("hex");
  return JSON.parse(
    await readFile(path.join(hosts, ".bindings", `${name}.json`), "utf8")
  );
}

const progress = () => vi.fn().mockResolvedValue(undefined);

it("prepares native folders, direct checkouts and independent worktrees in the child", async () => {
  const root = await tempRoot();
  const { checkout, develop } = await repository(root);
  const folder = path.join(root, "folder");
  await mkdir(folder);
  const hosts = path.join(root, "hosts");
  const app = createLocalRunner(hosts, logger);
  const { session } = await startChild(hosts);
  const native = await resolveLaunchDirectory(checkout);

  expect(
    await prepareLocalWorkspace(
      session,
      "folder",
      await resolveLaunchDirectory(folder),
      null,
      progress()
    )
  ).toMatchObject({
    effectiveCwd: folder,
    worktreePath: null,
    git: { status: "ok", value: null },
  });
  const direct = progress();
  expect(
    await prepareLocalWorkspace(session, "direct", native, null, direct)
  ).toMatchObject({
    effectiveCwd: checkout,
    worktreePath: null,
    git: { value: { branch: "main", repoRoot: checkout } },
  });
  expect(direct.mock.calls).toEqual([[{ phase: "session" }]]);
  // A user's folder and the primary checkout are external: never removed.
  for (const [id, at] of [
    ["folder", folder],
    ["direct", checkout],
  ])
    expect(await stored(hosts, id)).toMatchObject({
      path: at,
      checkout: { path: at, ownership: "external", branch: null },
      source: "prepare",
    });

  // Main's answer for a branch already checked out: Git's own message, not
  // a mapped refusal.
  const busy = await prepareLocalWorkspace(
    session,
    "busy",
    native,
    { name: "Busy", branch: "main", createNewBranch: false },
    progress()
  ).catch((error: unknown) => error);
  expect(busy).toBeInstanceOf(RunnerCallError);
  expect((busy as Error).message).toMatch(
    /Command failed \(git .* worktree add .*already/s
  );
  expect(worktreeRefusal(busy)).toBeNull();

  const request = {
    name: "Work",
    branch: "session/work",
    baseBranch: "develop",
    createNewBranch: true,
  };
  const steps = progress();
  const work = await prepareLocalWorkspace(
    session,
    "work",
    native,
    request,
    steps
  );
  expect(work).toMatchObject({
    baseBranch: "develop",
    worktreeBranch: "session/work",
    worktreePath: path.join(root, "repository-session-work"),
  });
  // Main's phases, in main's order, with the dependency step's result.
  expect(steps.mock.calls.map(([step]) => step)).toEqual([
    { phase: "worktree" },
    { phase: "env" },
    { phase: "deps" },
    {
      phase: "deps",
      status: "done",
      detail:
        "No supported lockfile found; automatic dependency installation skipped.",
    },
    { phase: "session" },
  ]);
  expect(await git(work.effectiveCwd, "rev-parse", "HEAD")).toBe(develop);
  expect(await readFile(path.join(work.effectiveCwd, ".env"), "utf8")).toBe(
    "LOCAL_CONFIG=fixture\n"
  );
  expect(await stored(hosts, "work")).toMatchObject({
    path: work.effectiveCwd,
    checkout: {
      path: work.effectiveCwd,
      ownership: "owned",
      branch: "session/work",
      base: "develop",
    },
    source: "prepare",
  });

  // The same worktree for another launch: main's 409, and the path that was
  // already there is never claimed for that launch.
  const other = await prepareLocalWorkspace(
    session,
    "other",
    native,
    request,
    progress()
  ).catch((error: unknown) => error);
  expect(worktreeRefusal(other)).toMatchObject({ status: 409 });
  expect(
    JSON.parse(
      await readFile(path.join(hosts, "other", "workspace-preparation"), "utf8")
    )
  ).not.toHaveProperty("pending");
  expect(await worktrees(checkout)).toBe(2);

  // The failed request finishes once its branch is free again.
  await git(checkout, "switch", "develop");
  expect(await resumeLocalWorkspace(session, "busy", progress())).toMatchObject(
    { baseBranch: "main", worktreeBranch: "main" }
  );
  expect(await git(checkout, "branch", "--show-current")).toBe("develop");
  // Nothing to resume for a launch that never asked for a worktree.
  expect(await resumeLocalWorkspace(session, "direct", progress())).toBeNull();
});

it("finishes a launch whose runner died after Git made the worktree, without a second one", async () => {
  const root = await tempRoot();
  const { checkout } = await repository(root);
  const hosts = path.join(root, "hosts");
  const marker = path.join(root, "die-after-create");
  await writeFile(marker, "");
  const app = createLocalRunner(hosts, logger);
  const { session, pids } = await startChild(hosts, {
    RUNNER_DIE_AFTER_CREATE: marker,
  });
  const native = await resolveLaunchDirectory(checkout);
  const request = {
    name: "Crash",
    branch: "session/crash",
    createNewBranch: true,
    location: "nested" as const,
  };
  // The call is sent again to the restarted child (its retry is by key).
  const prepared = await prepareLocalWorkspace(
    session,
    "crash",
    native,
    request,
    progress()
  );
  expect(pids.length).toBe(2);
  const nested = path.join(checkout, ".dispatch", "worktrees", "session-crash");
  expect(prepared).toMatchObject({
    effectiveCwd: nested,
    worktreePath: nested,
    worktreeBranch: "session/crash",
    baseBranch: "main",
  });
  expect(await worktrees(checkout)).toBe(2);
  expect(await readFile(path.join(nested, ".env"), "utf8")).toBe(
    "LOCAL_CONFIG=fixture\n"
  );
  expect(await stored(hosts, "crash")).toMatchObject({
    checkout: { path: nested, ownership: "owned" },
  });
  // The runner's receipt is there, as an earlier build's Start looks for it.
  expect(await app.bindWorkspace("crash")).toBe(true);
});

it("binds a launch whose runner died after preparing and before binding", async () => {
  const root = await tempRoot();
  const { checkout } = await repository(root);
  const hosts = path.join(root, "hosts");
  const marker = path.join(root, "die-after-install");
  await writeFile(marker, "");
  const app = createLocalRunner(hosts, logger);
  const { session, pids, child } = await startChild(hosts, {
    RUNNER_DIE_AFTER_INSTALL: marker,
  });
  const native = await resolveLaunchDirectory(checkout);
  const request = { name: "Late", branch: "late", createNewBranch: true };
  // The restarted child's import ran first and holds the row's folder as
  // external (the row still names the source folder): the prepared binding
  // replaces it.
  const launch = prepareLocalWorkspace(
    session,
    "late",
    native,
    request,
    progress()
  );
  while (pids.length < 2) await new Promise((r) => setTimeout(r, 20));
  await child().importBindings(
    [{ session: "late", path: checkout, currentPath: null, worktree: null }],
    10_000
  );
  const prepared = await launch;
  expect(await worktrees(checkout)).toBe(2);
  expect(await stored(hosts, "late")).toMatchObject({
    path: prepared.effectiveCwd,
    checkout: { path: prepared.effectiveCwd, ownership: "owned" },
    source: "prepare",
  });
  // A repeat answers from what is recorded: no new worktree, same binding.
  expect(
    await prepareLocalWorkspace(session, "late", native, request, progress())
  ).toMatchObject({ worktreePath: prepared.effectiveCwd });
  expect(await worktrees(checkout)).toBe(2);
});

it("resumes a receipt an earlier build of this branch wrote", async () => {
  const root = await tempRoot();
  const { checkout } = await repository(root);
  const hosts = path.join(root, "hosts");
  const app = createLocalRunner(hosts, logger);
  const { session } = await startChild(hosts);
  const source = await realpath(checkout);
  // The earlier shape: the app's request, no copy list.
  await mkdir(path.join(hosts, "legacy"), { recursive: true });
  const evidence = await stat(source, { bigint: true });
  await writeFile(
    path.join(hosts, "legacy", "workspace-preparation"),
    JSON.stringify({
      cwd: checkout,
      source,
      sourceIdentity: `${evidence.dev}:${evidence.ino}:${evidence.birthtimeNs}`,
      request: {
        name: "Legacy",
        branch: "legacy/work",
        createNewBranch: true,
        location: "nested",
      },
    })
  );
  expect(await app.bindWorkspace("legacy")).toBe(true);
  const resumed = await resumeLocalWorkspace(session, "legacy", progress());
  const nested = path.join(checkout, ".dispatch", "worktrees", "legacy-work");
  expect(resumed).toMatchObject({
    worktreePath: nested,
    worktreeBranch: "legacy/work",
  });
  expect(await readFile(path.join(nested, ".env"), "utf8")).toBe(
    "LOCAL_CONFIG=fixture\n"
  );
});

it("keeps a worktree main created as the import found it", async () => {
  const root = await tempRoot();
  const { checkout } = await repository(root);
  const hosts = path.join(root, "hosts");
  const { session, child } = await startChild(hosts);
  const made = path.join(root, "repository-main-made");
  await git(checkout, "worktree", "add", "-b", "main-made", made, "main");
  await child().importBindings(
    [
      {
        session: "old",
        path: made,
        currentPath: null,
        worktree: { path: made, branch: "main-made", base: "main" },
      },
    ],
    10_000
  );
  // No receipt: nothing to resume, and the imported binding stays.
  expect(await resumeLocalWorkspace(session, "old", progress())).toBeNull();
  expect(await stored(hosts, "old")).toMatchObject({
    checkout: { path: made, ownership: "owned" },
    source: "import",
  });
  const described = await session.call("workspace.describe", {
    session: sessionFromWire("old"),
  });
  expect(described.worktree).toMatchObject({ branch: "main-made" });
});

it("refuses preparation while the child is frozen, and writes nothing", async () => {
  const root = await tempRoot();
  const { checkout } = await repository(root);
  const hosts = path.join(root, "hosts");
  const app = createLocalRunner(hosts, logger);
  const { session, child } = await startChild(hosts);
  await child().fence(true, 10_000);
  const refused = await prepareLocalWorkspace(
    session,
    "frozen",
    await resolveLaunchDirectory(checkout),
    { name: "Frozen", branch: "frozen", createNewBranch: true },
    progress()
  ).catch((error: unknown) => error);
  expect(refused).toMatchObject({ code: "fenced" });
  expect(await app.bindWorkspace("frozen")).toBe(false);
  expect(await worktrees(checkout)).toBe(1);
  await child().fence(false, 10_000);
});

function resolveLaunchDirectory(raw: string) {
  return resolveWorkloadDirectory(raw, launchDirectory, inferRepositoryUrl);
}

it("upgrades legacy local receipts with the controller's exact mapping and config list", async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), "workspace-inputs-"));
  try {
    const directory = path.join(state, "legacy");
    await mkdir(directory);
    const request = {
      name: "legacy",
      branch: "topic",
      createNewBranch: true,
      location: "nested" as const,
    };
    const receipt = {
      source: "/source",
      sourceIdentity: "source",
      cwd: "/source",
      request,
    };
    await writeFile(
      path.join(directory, "workspace-preparation"),
      JSON.stringify(receipt)
    );
    expect(await createLocalRunner(state).bindWorkspace("legacy")).toBe(true);
    expect(
      JSON.parse(
        await readFile(path.join(directory, "workspace-preparation"), "utf8")
      )
    ).toEqual({
      ...receipt,
      request: runnerWorktree(request),
      copy: [...WORKTREE_LOCAL_CONFIG_FILES],
      install: true,
    });
  } finally {
    await rm(state, { recursive: true, force: true });
  }
});

it("keeps the Linux entry on its privsep workspace composition", async () => {
  const main = await readFile(
    new URL("../src/main.ts", import.meta.url),
    "utf8"
  );
  const linux = main.slice(
    main.indexOf('process.argv[2] === "remote-runner"'),
    main.indexOf('process.argv[2] === "local-runner"')
  );
  expect(linux).toContain('await import("@dispatch/runner/cli")');
  expect(linux).toContain(
    "createWorkspacePreparation: createRemoteWorkspacePreparation"
  );
  expect(linux).not.toContain('import("./agents/workspace.js")');
});
