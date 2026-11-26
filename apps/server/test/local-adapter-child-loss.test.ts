import { inProcessPorts } from "../src/runners/in-process.js";
/*
 * The local adapter with a real child that dies mid-call. A read answers as
 * a healthy child does, from exactly one in-process call, without waiting
 * for the child to come back; a mutation is sent once, and only one the
 * child never received runs here. The child is stopped (SIGSTOP) so the
 * request is written but never read, then killed (SIGKILL): the reply is
 * lost (`unknown_outcome`). Its supervisor restarts it only after a long
 * backoff, so any wait for a restart shows as time.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  pathFromWire,
  RunnerCallError,
  sessionFromWire,
  type CallName,
  type Runner,
  type Req,
} from "@dispatch/runner-protocol/contract";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { workspaceWorkload } from "../../../packages/runner/src/workload/agents/checkout-worker.js";
import { runnerDirectory } from "../src/runners/directory.js";
import { controllerPlacement } from "../src/runners/placement.js";
import {
  sessionFor,
  startTestLocalRunner,
  type TestLocalRunner,
} from "./helpers/local-runner-child.js";

/** Longer than any answer here takes; shorter than the restart backoff. */
const NO_WAIT_MS = 2_500;
const RESTART_BACKOFF_MS = 5_000;

const agentId = "agt_childloss1";
const session = sessionFromWire(agentId);
let root: string;
let repo: string;
let moved: string;
let child: TestLocalRunner;

const git = (...args: string[]) =>
  execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });

const row = (workspacePath: string | null = null) => ({
  id: agentId,
  cwd: repo,
  worktreePath: null,
  workspacePath,
  placement: controllerPlacement,
});

const adapter = (
  runner: Parameters<typeof runnerDirectory>[0]["child"],
  workspacePath: string | null = null
) =>
  runnerDirectory({ child: runner }, row(workspacePath)).for(
    controllerPlacement
  );

/** An answer as the caller sees it; `computedAt` is when, not what. */
const outcome = (run: () => Promise<unknown>) =>
  run().then(
    (value) => ({
      value:
        value && typeof value === "object" && "computedAt" in value
          ? { ...value, computedAt: "<when>" }
          : value,
    }),
    (error: { code?: string; message?: string }) => ({
      error: error.code ?? error.message,
    })
  );

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "child-loss-")));
  repo = join(root, "repo");
  // A folder outside the checkout: `set_workspace` there is a move.
  moved = join(root, "elsewhere");
  await mkdir(join(repo, "src"), { recursive: true });
  await mkdir(moved);
  await writeFile(join(moved, "b.ts"), "export const b = 1;\n");
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.test");
  git("config", "user.name", "T");
  await writeFile(join(repo, "a.txt"), "one\n");
  await writeFile(join(repo, "src", "b.ts"), "export const b = 1;\n");
  git("add", ".");
  git("commit", "-qm", "base");
  // A remote, so branch reads answer rather than fail.
  execFileSync("git", ["init", "-q", "--bare", join(root, "origin.git")]);
  git("remote", "add", "origin", join(root, "origin.git"));
  git("push", "-q", "origin", "main");
  await writeFile(join(repo, "a.txt"), "one\ntwo\n");
  await mkdir(join(root, "state"));
  child = startTestLocalRunner(join(root, "state"), {
    backoffMs: RESTART_BACKOFF_MS,
    // The child kills itself at these points once each marker exists.
    env: {
      RUNNER_DIE_BEFORE_RELEASE: join(root, "die-before"),
      RUNNER_DIE_AFTER_RELEASE: join(root, "die-after"),
    },
  });
  await child.ready();
  await child.session.call("runner.describe", {});
  // The child holds the session's folder, as every local launch is bound.
  await child.session.call("workspace.prepare", {
    session,
    source: { directory: pathFromWire(repo) },
    copyIgnored: [],
    installDependencies: false,
  });
}, 60_000);

afterAll(async () => {
  await child?.stop();
  await rm(root, { recursive: true, force: true });
});

/**
 * Run `call` on a child that is stopped before it reads the request and
 * killed before it answers; then wait for its replacement.
 */
async function interrupted(call: () => Promise<unknown>) {
  const before = child.pids.length;
  const pid = child.current()!.pid;
  process.kill(pid, "SIGSTOP");
  const pending = outcome(call);
  await delay(150);
  const killedAt = performance.now();
  process.kill(pid, "SIGKILL");
  const answer = await pending;
  const ms = performance.now() - killedAt;
  await child.ready(before);
  await child.session.call("runner.describe", {});
  return { answer, ms };
}

const target = { session, checkout: "current" as const };
const reads: Array<[CallName, (at: object) => object]> = [
  ["checkout.list", (at) => ({ target: at, path: "" })],
  ["checkout.preview", (at) => ({ target: at, path: "a.txt" })],
  ["checkout.index", (at) => ({ target: at, generation: "g1" })],
  [
    "checkout.read",
    (at) => ({ target: at, path: "a.txt", encoding: "utf8", maxBytes: null }),
  ],
  [
    "checkout.stats",
    (at) => ({ target: at, base: "main", uncommitted: true, exclude: [] }),
  ],
  [
    "checkout.diff",
    (at) => ({
      target: at,
      base: "main",
      uncommitted: true,
      whitespace: "show",
      exclude: [],
    }),
  ],
  ["checkout.changes", (at) => ({ target: at, base: "main" })],
  [
    "checkout.defaultFiles",
    (at) => ({ target: at, dirs: [".agents"], wait: false }),
  ],
];

describe("a read whose child dies mid-call", () => {
  it.each(reads)(
    "%s for the session answers as a healthy child, once, at once",
    async (op, request) => {
      const run = () =>
        adapter(() => child.session).call(op, request(target) as never);
      const here = vi.spyOn(inProcessPorts().checkoutWorkload, "run");
      try {
        const healthy = await outcome(run);
        expect(healthy).not.toHaveProperty("error");
        // The healthy answer is the child's: nothing ran here.
        expect(here).not.toHaveBeenCalled();
        const { answer, ms } = await interrupted(run);
        expect(answer).toEqual(healthy);
        expect(here.mock.calls.map(([name]) => name)).toEqual([op]);
        expect(ms).toBeLessThan(NO_WAIT_MS);
      } finally {
        here.mockRestore();
      }
    },
    30_000
  );

  it.each(reads)(
    "%s for a folder answers as a healthy child, once, at once",
    async (op, request) => {
      const at = { path: pathFromWire(repo) };
      const run = () =>
        adapter(() => child.session).call(op, request(at) as never);
      const here = vi.spyOn(inProcessPorts().checkoutWorkload, "run");
      try {
        const healthy = await outcome(run);
        expect(healthy).not.toHaveProperty("error");
        // The healthy answer is the child's: nothing ran here.
        expect(here).not.toHaveBeenCalled();
        const { answer, ms } = await interrupted(run);
        expect(answer).toEqual(healthy);
        expect(here.mock.calls.map(([name]) => name)).toEqual([op]);
        expect(ms).toBeLessThan(NO_WAIT_MS);
      } finally {
        here.mockRestore();
      }
    },
    30_000
  );

  it.each([
    ["git.context", { target }],
    ["git.branches", { target: { path: "" } }],
    ["git.defaultBranch", { target: { path: "" } }],
  ] as const)(
    "%s answers as a healthy child, once, at once",
    async (op, base) => {
      const request =
        "path" in base.target ? { target: { path: pathFromWire(repo) } } : base;
      const run = () =>
        adapter(() => child.session).call(op, request as Req<typeof op>);
      const here = vi.spyOn(inProcessPorts().checkoutWorkload, "run");
      try {
        const healthy = await outcome(run);
        expect(healthy).not.toHaveProperty("error");
        // The healthy answer is the child's: nothing ran here.
        expect(here).not.toHaveBeenCalled();
        const { answer, ms } = await interrupted(run);
        expect(answer).toEqual(healthy);
        expect(here).toHaveBeenCalledTimes(1);
        expect(ms).toBeLessThan(NO_WAIT_MS);
      } finally {
        here.mockRestore();
      }
    },
    30_000
  );

  it("path.resolve answers as a healthy child, once, at once", async () => {
    const run = () =>
      adapter(() => child.session).call("path.resolve", {
        path: repo,
        projectRoot: true,
      });
    const here = vi.spyOn(workspaceWorkload, "resolvePath");
    try {
      const healthy = await outcome(run);
      expect(here).not.toHaveBeenCalled();
      const { answer, ms } = await interrupted(run);
      expect(answer).toEqual(healthy);
      expect(here).toHaveBeenCalledTimes(1);
      expect(ms).toBeLessThan(NO_WAIT_MS);
    } finally {
      here.mockRestore();
    }
  }, 30_000);

  it.each(["inspect", "complete", "remoteHeads"] as const)(
    "serves launch-form %s in the child and falls back once on connection loss",
    async (operation) => {
      const probes = inProcessPorts().launchProbes;
      const here = vi.spyOn(probes, operation);
      const target = adapter(() => child.session);
      const run = () => {
        if (operation === "inspect")
          return target.call("path.resolve", { path: repo, automatic: true });
        if (operation === "complete")
          return target.call("path.complete", {
            prefix: repo + "/",
            limit: 20,
          });
        return target.call("git.remoteHeads", { path: repo });
      };
      try {
        const healthy = await outcome(run);
        expect(healthy).not.toHaveProperty("error");
        expect(here).not.toHaveBeenCalled();
        const { answer, ms } = await interrupted(run);
        expect(answer).toEqual(healthy);
        expect(here).toHaveBeenCalledTimes(1);
        expect(ms).toBeLessThan(NO_WAIT_MS);
      } finally {
        here.mockRestore();
      }
    },
    30_000
  );

  it("reads the moved folder the child would, after set_workspace", async () => {
    // The move goes through the adapter to the child, as `set_workspace` does;
    // the row then records it.
    const selected = await adapter(() => child.session).call(
      "workspace.select",
      { session, path: pathFromWire(moved) }
    );
    expect(selected).toMatchObject({ path: moved, moved: true });
    const request = { target, path: "" } as Req<"checkout.list">;
    const run = () =>
      adapter(() => child.session, moved).call("checkout.list", request);
    const here = vi.spyOn(inProcessPorts().checkoutWorkload, "run");
    try {
      const healthy = await outcome(run);
      expect(JSON.stringify(healthy)).toContain("b.ts");
      expect(here).not.toHaveBeenCalled();
      const { answer } = await interrupted(run);
      expect(answer).toEqual(healthy);
      // Here, from the folder the row records: the one the child read.
      expect(
        here.mock.calls.map(
          ([, input]) => (input as { directory: string }).directory
        )
      ).toEqual([moved]);
    } finally {
      here.mockRestore();
    }
    await adapter(() => child.session, moved).call("workspace.select", {
      session,
      path: null,
    });
  }, 30_000);
});

describe("a child that is not running", () => {
  it.each(reads)(
    "%s answers in process at once, as main",
    async (op, request) => {
      const down = sessionFor(null);
      try {
        const started = performance.now();
        const answer = await outcome(() =>
          adapter(() => down).call(op, request(target) as never)
        );
        expect(performance.now() - started).toBeLessThan(NO_WAIT_MS);
        expect(answer).toEqual(
          await outcome(() =>
            adapter(() => undefined).call(op, request(target) as never)
          )
        );
      } finally {
        down.close();
      }
    }
  );
});

describe("a mutation whose child dies mid-call", () => {
  it("checkout.write is not made again: the caller gets the lost reply", async () => {
    const file = "written.txt";
    const request = {
      target,
      path: file,
      data: "x",
      expectedDigest: null,
    } as Req<"checkout.write">;
    // Bind the gate's answer for this child before it is stopped.
    await adapter(() => child.session).call("checkout.read", {
      target,
      path: "a.txt",
      encoding: "utf8",
      maxBytes: null,
    });
    const here = vi.spyOn(inProcessPorts().checkoutWorkload, "run");
    try {
      const { answer } = await interrupted(() =>
        adapter(() => child.session).call("checkout.write", request)
      );
      expect(answer).toEqual({ error: "unknown_outcome" });
      expect(here).not.toHaveBeenCalled();
    } finally {
      here.mockRestore();
    }
    // A write that did land: the same request by hand answers its guard.
    await adapter(() => child.session).call("checkout.write", request);
    expect(
      await outcome(() =>
        adapter(() => child.session).call("checkout.write", request)
      )
    ).toEqual({ error: "stale" });
    await rm(join(repo, file), { force: true });
  }, 30_000);

  it("files.put whose reply is lost is a clean error, and the file is as it was", async () => {
    const file = join(root, "upload.txt");
    await writeFile(file, "bytes");
    const { putSessionFile } = await import("../src/files/session-file.js");
    await adapter(() => child.session).call("checkout.read", {
      target,
      path: "a.txt",
      encoding: "utf8",
      maxBytes: null,
    });
    const put = vi.spyOn(
      (
        await import("../../../packages/runner/src/workload/agents/checkout-worker.js")
      ).sessionFilesWorkload,
      "put"
    );
    try {
      const { answer } = await interrupted(() =>
        putSessionFile(
          adapter(() => child.session),
          session,
          file,
          "upload.txt",
          "prompt"
        )
      );
      expect(answer).toEqual({ error: "unknown_outcome" });
      expect(put).not.toHaveBeenCalled();
      expect(await readFile(file, "utf8")).toBe("bytes");
    } finally {
      put.mockRestore();
    }
  }, 30_000);
});

describe("workspace.release whose reply is lost", () => {
  let owned = "";
  let worktree: string;
  const release = () =>
    runnerDirectory(
      { child: () => child.session },
      {
        id: owned,
        cwd: repo,
        worktreePath: worktree,
        workspacePath: null,
        placement: controllerPlacement,
      }
    )
      .for(controllerPlacement)
      .call("workspace.release", {
        session: sessionFromWire(owned),
        deleteBranch: false,
        originalBranch: null,
      });

  async function prepareWorktree(name: string) {
    owned = `agt_childloss${name}`;
    const prepared = await child.session.call("workspace.prepare", {
      session: sessionFromWire(owned),
      source: { directory: pathFromWire(repo) },
      worktree: { name, branch: `child-loss-${name}`, create: true },
      copyIgnored: [],
      installDependencies: false,
    });
    worktree = prepared.worktree!.path as string;
  }

  it("answers removed when the worktree went before the reply was lost", async () => {
    await prepareWorktree("after");
    const here = vi.spyOn(workspaceWorkload, "release");
    try {
      await writeFile(join(root, "die-after"), "");
      const { answer } = await crashed(release);
      // Read-only: the worktree is gone, so the release happened.
      expect(answer).toEqual({ value: { removed: true } });
      expect(existsSync(worktree)).toBe(false);
      expect(here).not.toHaveBeenCalled();
    } finally {
      here.mockRestore();
    }
  }, 60_000);

  it("keeps the lost reply when the worktree is still there, and never removes it here", async () => {
    await prepareWorktree("before");
    const here = vi.spyOn(workspaceWorkload, "release");
    try {
      await writeFile(join(root, "die-before"), "");
      const { answer } = await crashed(release);
      expect(answer).toEqual({ error: "unknown_outcome" });
      expect(existsSync(worktree)).toBe(true);
      expect(here).not.toHaveBeenCalled();
    } finally {
      here.mockRestore();
    }
    // Archive's next attempt releases it through the restarted child.
    expect(await release()).toEqual({ removed: true });
    expect(existsSync(worktree)).toBe(false);
  }, 60_000);
});

/** Run `call` on a child that kills itself at a marked point; then wait for its replacement. */
async function crashed(call: () => Promise<unknown>) {
  const before = child.pids.length;
  const answer = await outcome(call);
  await child.ready(before);
  await child.session.call("runner.describe", {});
  return { answer };
}

describe("checkout.watch when the child cannot open it", () => {
  it("watches here for the subscription's life, also after the child is back", async () => {
    const down = sessionFor(null);
    const here = vi.spyOn(inProcessPorts().checkoutWorkload, "watch");
    try {
      const { channel } = await adapter(() => down).open("checkout.watch", {
        target,
      });
      expect(here).toHaveBeenCalledTimes(1);
      let pulses = 0;
      channel.onData(() => (pulses += 1));
      const change = async (text: string) => {
        const before = pulses;
        await writeFile(join(repo, "watched.txt"), text);
        await vi.waitFor(() => expect(pulses).toBeGreaterThan(before), {
          timeout: 5_000,
        });
      };
      await change("1");
      // The child comes back: this subscription stays here, one watcher.
      down.setEndpoint(child.endpoint());
      await down.call("runner.describe", {});
      await change("2");
      expect(here).toHaveBeenCalledTimes(1);
      let closed = false;
      channel.onClose(() => (closed = true));
      channel.close();
      expect(closed).toBe(true);
    } finally {
      here.mockRestore();
      down.close();
      await rm(join(repo, "watched.txt"), { force: true });
    }
  }, 30_000);
});

describe("a read the child answers", () => {
  it("keeps a timeout the child answers with: a read's own result, not missed", async () => {
    const timedOut = {
      connection: { state: "ready", epoch: 9, onChange: () => () => {} },
      call: vi.fn(async (op: string) => {
        if (op === "workspace.describe")
          return { path: repo, checkoutRoot: repo, moved: false };
        throw new RunnerCallError({
          code: "timeout",
          message: "git timed out",
        });
      }),
    } as unknown as Runner;
    const here = vi.spyOn(inProcessPorts().checkoutWorkload, "run");
    try {
      for (const op of ["checkout.read", "checkout.write"] as const)
        expect(
          await outcome(() =>
            adapter(() => timedOut).call(op, {
              target,
              path: "a.txt",
              ...(op === "checkout.read"
                ? { encoding: "utf8", maxBytes: null }
                : { data: "x", expectedDigest: null }),
            } as never)
          ),
          op
        ).toEqual({ error: "timeout" });
      expect(here).not.toHaveBeenCalled();
    } finally {
      here.mockRestore();
    }
  });
});
