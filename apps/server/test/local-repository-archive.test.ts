import {
  resolveSavedTarget,
  savedLaunchTarget,
} from "../src/runners/saved-location.js";
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
import { fileURLToPath } from "node:url";
import path from "node:path";
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
  options: {
    install?: "done" | "failed" | "timeout";
    interrupt?: boolean;
    pickBranches?: boolean;
  } = {}
) {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "local-repo-archive-"))
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
  if (options.install) {
    await writeFile(
      path.join(source, "package.json"),
      JSON.stringify({
        name: "offline-install",
        version: "1.0.0",
        scripts: { postinstall: "sh fixture-install.sh" },
      })
    );
    await writeFile(
      path.join(source, "package-lock.json"),
      JSON.stringify({
        name: "offline-install",
        version: "1.0.0",
        lockfileVersion: 3,
        packages: { "": { name: "offline-install", version: "1.0.0" } },
      })
    );
    await writeFile(
      path.join(source, "fixture-install.sh"),
      options.install === "timeout"
        ? "printf 'local install\\n' > .dependency-step\nprintf '%s' \"$$\" > .dependency-pid\nwhile :; do :; done\n"
        : `printf 'local install\\n' > .dependency-step\nexit ${options.install === "failed" ? 7 : 0}\n`
    );
    await writeFile(
      path.join(source, ".gitignore"),
      ".dependency-step\n.dependency-pid\nnode_modules/\n"
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
  const home = path.join(root, "home"),
    tools = path.join(root, "only-on-path");
  await mkdir(home);
  await mkdir(tools);
  await writeFile(
    path.join(tools, "npm"),
    '#!/bin/sh\n[ "$*" = install ] || exit 64\nprintf "install\\n" >> "$HOME/npm-invocations"\nexec /bin/sh fixture-install.sh\n',
    { mode: 0o755 }
  );
  const crash = path.join(root, "crash-after-create");
  if (options.interrupt) await writeFile(crash, "");
  const child = startTestLocalRunner(hosts, {
    backoffMs: 250,
    ...(options.install === "timeout" && {
      entry: fileURLToPath(
        new URL("./fixtures/local-runner-timeout-entry.ts", import.meta.url)
      ),
    }),
    env: {
      GIT_CONFIG_GLOBAL: config,
      GIT_CONFIG_NOSYSTEM: "1",
      HOME: home,
      GH_CONFIG_DIR: path.join(home, "gh"),
      XDG_CONFIG_HOME: path.join(home, "config"),
      PATH: `${tools}:${process.env.PATH}`,
      NPM_CONFIG_AUDIT: "false",
      NPM_CONFIG_FUND: "false",
      ...(options.interrupt && { RUNNER_DIE_AFTER_CREATE: crash }),
    },
  });
  cleanups.push(() => child.stop());
  await child.ready();
  if (options.pickBranches) {
    const project = resolveSavedTarget("", {
      runner: "local",
      projectId: "fixture-project",
    });
    const selected = savedLaunchTarget({ ...project, useWorktree: true });
    expect(selected).toMatchObject({
      cwd: "",
      projectId: "fixture-project",
      repository: {},
    });
    expect(
      (await child.session.call("git.branches", { target: { repository } }))
        .branches
    ).toContain("main");
  }
  const session = sessionFromWire("agt_archive_repository");
  const controller = new AbortController();
  const steps: Array<{ phase: string; status?: string; detail?: string }> = [];
  const preparation = child.session.call(
    "workspace.prepare",
    {
      session,
      source: {
        repository,
        checkout: { kind: "new", branch: "feature/archive" },
      },
      copyIgnored: [],
      installDependencies: Boolean(options.install),
    },
    { signal: controller.signal, onEvent: (event) => steps.push(event) }
  );
  let checkout: string;
  if (options.interrupt) {
    const ignored = preparation.catch(() => null);
    const deadline = Date.now() + 5_000;
    while (existsSync(crash) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(existsSync(crash)).toBe(false);
    controller.abort();
    await ignored;
    await child.ready(1);
    const receipt = JSON.parse(
      await readFile(
        path.join(hosts, String(session), "workspace-preparation"),
        "utf8"
      )
    );
    checkout = receipt.pending.path;
  } else checkout = displayPath((await preparation).path);
  const agent = {
    id: String(session),
    type: "codex",
    status: "stopped",
    placement: controllerPlacement,
    cwd: options.interrupt ? "" : checkout,
    worktreePath: options.interrupt ? null : checkout,
    worktreeBranch: "feature/archive",
    baseBranch: "main",
    workspacePath: null,
    launchCwd: checkout,
    archivePhase: null,
    archiveCleanupMode: "auto",
    lastError: null,
  } as AgentRecord;
  let deleted = false;
  const events: string[] = [];
  const pool = {
    query: vi.fn(async (sql: string, values: unknown[] = []) => {
      if (sql.includes('AS "repositorySource"'))
        return {
          rows: [
            {
              repositorySource: true,
              preparationPending: Boolean(options.interrupt),
              repositoryBranchCreated: true,
            },
          ],
          rowCount: 1,
        };
      if (sql.includes("SET status = 'archiving'")) {
        agent.status = "archiving";
        agent.archiveCleanupMode = values[1] as WorktreeCleanupMode;
        return { rows: [{ id: agent.id }], rowCount: 1 };
      }
      if (sql.includes("SET archive_cleanup_mode = 'keep'"))
        agent.archiveCleanupMode = "keep";
      if (sql.includes("SET deleted_at = NOW()")) {
        deleted = true;
        events.push("deleted");
      }
      return { rows: [], rowCount: 0 };
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
    home,
    steps,
    hosts,
    child,
    session,
    agent,
    checkout,
    clone: receipt.source as string,
    hookLog,
    deps,
    callbacks,
    runtime,
    events,
    deleted: () => deleted,
  };
}

it.each(["clean", "dirty", "committed", "force", "cascade", "retry"])(
  "archives a real Local repository-source session (%s)",
  async (state) => {
    const f = await fixture();
    if (state === "dirty" || state === "force")
      await writeFile(path.join(f.checkout, "draft.txt"), "keep draft\n");
    if (state === "committed") {
      await writeFile(
        path.join(f.checkout, "unpublished.txt"),
        "keep commit\n"
      );
      await git(f.checkout, "add", "unpublished.txt");
      await git(
        f.checkout,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.test",
        "commit",
        "-qm",
        "unpublished"
      );
    }
    const head = await git(f.checkout, "rev-parse", "HEAD");
    if (state === "retry") {
      // An old archive discarded host metadata/binding but left its worktree.
      // Deployment's launcher imports every undeleted Local row, including error rows.
      await rm(path.join(f.hosts, f.agent.id), {
        recursive: true,
        force: true,
      });
      const name =
        createHash("sha256").update(f.agent.id).digest("hex") + ".json";
      await rm(path.join(f.hosts, ".bindings", name));
      f.agent.status = "error";
      f.agent.lastError = "No checkout is bound to this session";
      const binding = bindingFromRow(f.agent);
      expect(binding).not.toBeNull();
      expect(
        (await f.child.current()!.importBindings([binding!], 5000)).invalid
      ).toBe(0);
    }
    if (state === "cascade") {
      expect(await deleteAgentDirect(f.deps, f.agent.id)).toEqual([f.agent.id]);
    } else {
      await beginArchive(
        f.deps,
        f.agent.id,
        state === "force" ? "force" : "auto"
      );
      await executeArchive(f.deps, f.agent.id, f.callbacks);
      expect(f.callbacks.onError).not.toHaveBeenCalled();
      expect(f.callbacks.onComplete).toHaveBeenCalledWith([f.agent.id]);
    }
    expect(f.deleted()).toBe(true);
    expect(await readFile(f.hookLog, "utf8")).toBe("stop\narchive\n");
    expect(f.runtime.discard).not.toHaveBeenCalled();
    expect(f.events.indexOf("clear-state")).toBeGreaterThan(
      f.events.indexOf("stop")
    );
    expect(existsSync(path.join(f.hosts, f.agent.id))).toBe(false);
    const retained = state === "dirty" || state === "committed";
    expect(existsSync(f.checkout)).toBe(retained);
    if (retained) {
      expect(await git(f.clone, "rev-parse", "feature/archive")).toBe(head);
      expect(f.agent.archiveCleanupMode).toBe("keep");
      if (state === "dirty")
        expect(await readFile(path.join(f.checkout, "draft.txt"), "utf8")).toBe(
          "keep draft\n"
        );
    } else {
      expect(await git(f.clone, "branch", "--list", "feature/archive")).toBe(
        ""
      );
    }
  }
);

it("discards a real Local repository checkout while retaining its unpublished branch", async () => {
  const f = await fixture();
  await writeFile(path.join(f.checkout, "unpublished.txt"), "committed work\n");
  await git(f.checkout, "add", "unpublished.txt");
  await git(
    f.checkout,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.test",
    "commit",
    "-qm",
    "unpublished"
  );
  const head = await git(f.checkout, "rev-parse", "HEAD");
  await f.child.session.call("session.discard", { session: f.session });
  expect(existsSync(f.checkout)).toBe(false);
  expect(await git(f.clone, "rev-parse", "feature/archive")).toBe(head);
  const reused = await f.child.session.call("workspace.prepare", {
    session: sessionFromWire("agt_reuse_branch"),
    source: {
      repository: "https://github.com/fixture/archive",
      checkout: { kind: "branch", branch: "feature/archive" },
    },
    copyIgnored: [],
    installDependencies: false,
  });
  expect(await git(displayPath(reused.path), "rev-parse", "HEAD")).toBe(head);
  expect(
    await readFile(
      path.join(displayPath(reused.path), "unpublished.txt"),
      "utf8"
    )
  ).toBe("committed work\n");
});

it.each(["done", "failed"] as const)(
  "runs a lockfile dependency step through the real Local child (%s)",
  async (install) => {
    const f = await fixture({ install });
    expect(await readFile(path.join(f.home, "npm-invocations"), "utf8")).toBe(
      "install\n"
    );
    expect(
      await readFile(path.join(f.checkout, ".dependency-step"), "utf8")
    ).toBe("local install\n");
    expect(f.steps).toContainEqual(
      expect.objectContaining({ phase: "dependencies", status: install })
    );
    if (install === "failed")
      expect(f.steps.find((s) => s.status === "failed")?.detail).toContain(
        "exitCode=7"
      );
    await f.child.session.call("session.discard", { session: f.session });
    expect(existsSync(f.checkout)).toBe(false);
    expect(
      (await git(f.clone, "branch", "--list", "feature/archive")).trim()
    ).toBe("feature/archive");
    expect(existsSync(path.join(f.hosts, f.agent.id))).toBe(false);
    expect(
      existsSync(
        path.join(
          f.hosts,
          ".bindings",
          createHash("sha256").update(f.agent.id).digest("hex") + ".json"
        )
      )
    ).toBe(false);
  }
);

const interruptedCleanup = async (action: "discard" | "archive") => {
  const f = await fixture({ interrupt: true });
  expect(existsSync(f.checkout)).toBe(true);
  if (action === "discard")
    await f.child.session.call("session.discard", { session: f.session });
  else {
    await beginArchive(f.deps, f.agent.id, "force");
    await executeArchive(f.deps, f.agent.id, f.callbacks);
    expect(f.callbacks.onError).not.toHaveBeenCalled();
    expect(f.callbacks.onComplete).toHaveBeenCalledWith([f.agent.id]);
  }
  expect(existsSync(f.checkout)).toBe(false);
  expect(existsSync(path.join(f.hosts, f.agent.id))).toBe(false);
  expect(
    existsSync(
      path.join(
        f.hosts,
        ".bindings",
        createHash("sha256").update(f.agent.id).digest("hex") + ".json"
      )
    )
  ).toBe(false);
  expect(
    (await git(f.clone, "branch", "--list", "feature/archive")).trim()
  ).toBe(action === "discard" ? "feature/archive" : "");
};
it("cleans a repository worktree interrupted before binding (discard)", () =>
  interruptedCleanup("discard"));
// The integration base keeps preparation metadata available to archive hooks and release.
it("cleans a repository worktree interrupted before binding (archive)", () =>
  interruptedCleanup("archive"));

it("launches a repository-only project through branch picking, preparation, install and archive", async () => {
  const f = await fixture({ install: "done", pickBranches: true });
  await beginArchive(f.deps, f.agent.id, "force");
  await executeArchive(f.deps, f.agent.id, f.callbacks);
  expect(f.callbacks.onError).not.toHaveBeenCalled();
  expect(existsSync(f.checkout)).toBe(false);
});

it.each(["discard", "archive"] as const)(
  "removes clean and dirty installed checkouts without orphaned host/binding files (%s)",
  async (action) => {
    for (const dirty of [false, true]) {
      const f = await fixture({ install: "done" });
      if (dirty)
        await writeFile(path.join(f.checkout, "draft.txt"), "dirty draft");
      if (action === "discard")
        await f.child.session.call("session.discard", { session: f.session });
      else {
        await beginArchive(f.deps, f.agent.id, "force");
        await executeArchive(f.deps, f.agent.id, f.callbacks);
        expect(f.callbacks.onError).not.toHaveBeenCalled();
      }
      expect(existsSync(f.checkout)).toBe(false);
      expect(existsSync(path.join(f.hosts, f.agent.id))).toBe(false);
      expect(
        existsSync(
          path.join(
            f.hosts,
            ".bindings",
            createHash("sha256").update(f.agent.id).digest("hex") + ".json"
          )
        )
      ).toBe(false);
      expect(
        (await git(f.clone, "branch", "--list", "feature/archive")).trim()
      ).toBe(action === "discard" ? "feature/archive" : "");
    }
  }
);

it.each(["discard", "archive"] as const)(
  "cleans a repository-only launch after the real install command times out (%s)",
  async (action) => {
    const f = await fixture({ install: "timeout", pickBranches: true });
    expect(await readFile(path.join(f.home, "npm-invocations"), "utf8")).toBe(
      "install\n"
    );
    expect(f.steps).toContainEqual(
      expect.objectContaining({
        phase: "dependencies",
        status: "failed",
        detail: expect.stringContaining("timeoutMs=1000"),
      })
    );
    expect(f.steps.at(-1)?.phase).toBe("ready");
    const pid = Number(
      await readFile(path.join(f.checkout, ".dependency-pid"), "utf8")
    );
    expect(pid).toBeGreaterThan(0);
    await vi.waitFor(() => {
      expect(() => process.kill(pid, 0)).toThrowError(
        expect.objectContaining({ code: "ESRCH" })
      );
    });
    if (action === "discard")
      await f.child.session.call("session.discard", { session: f.session });
    else {
      await beginArchive(f.deps, f.agent.id, "force");
      await executeArchive(f.deps, f.agent.id, f.callbacks);
      expect(f.callbacks.onError).not.toHaveBeenCalled();
      expect(f.callbacks.onComplete).toHaveBeenCalledWith([f.agent.id]);
    }
    expect(existsSync(f.checkout)).toBe(false);
    expect(existsSync(path.join(f.hosts, f.agent.id))).toBe(false);
    expect(
      existsSync(
        path.join(
          f.hosts,
          ".bindings",
          createHash("sha256").update(f.agent.id).digest("hex") + ".json"
        )
      )
    ).toBe(false);
    expect(
      (await git(f.clone, "branch", "--list", "feature/archive")).trim()
    ).toBe(action === "discard" ? "feature/archive" : "");
  }
);
