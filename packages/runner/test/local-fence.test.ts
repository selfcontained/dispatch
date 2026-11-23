/*
 * The updater's write fence in the real child: this test process is the
 * parent (supervisor) and the runner is a real bun process on a temp state
 * root, with two writing operations that record each receipt under the root
 * (`fixtures/counting-runner-entry.ts`). Every runner pid is tracked and must
 * be gone when the test ends.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  pathFromWire,
  RunnerCallError,
  sessionFromWire,
} from "@dispatch/runner-protocol/contract";
import {
  superviseRunner,
  type LaunchedRunner,
  type RunnerSupervisor,
} from "@dispatch/runner-client/launcher";
import { callLocalSocket } from "@dispatch/runner-client/transport/local-socket";

const entry = fileURLToPath(
  new URL("./fixtures/counting-runner-entry.ts", import.meta.url)
);
const bun = process.env.BUN_BINARY ?? "bun";
const build = { version: "0.0.0-test" };

const pids = new Set<number>();
const supervisors: RunnerSupervisor[] = [];
const temps: string[] = [];

function alive(pid: number) {
  try {
    const stat = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], {
      encoding: "utf8",
    }).trim();
    return stat !== "" && !stat.startsWith("Z");
  } catch {
    return false;
  }
}

afterEach(async () => {
  for (const supervisor of supervisors.splice(0)) await supervisor.stop(2_000);
  const survivors = [...pids].filter(alive);
  for (const pid of survivors) process.kill(pid, "SIGKILL");
  pids.clear();
  for (const dir of temps.splice(0))
    rmSync(dir, { recursive: true, force: true });
  expect(survivors).toEqual([]);
});

/** Supervise one runner; `next()` resolves with each ready child in turn. */
function supervise(root: string, frozen?: () => boolean) {
  const readies: LaunchedRunner[] = [];
  const waiters: Array<(runner: LaunchedRunner) => void> = [];
  const supervisor = superviseRunner({
    command: [bun, entry, "local-runner"],
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      RUNNER_TEST_BUILD: JSON.stringify(build),
    },
    start: {
      build,
      roots: { state: root, files: root },
      config: { runnerId: "local", displayName: "Local", engines: [] },
    },
    backoff: { initialMs: 50, maxMs: 200 },
    frozen,
    onState(state) {
      if (state.state !== "ready") return;
      pids.add(state.runner.pid);
      const waiter = waiters.shift();
      if (waiter) waiter(state.runner);
      else readies.push(state.runner);
    },
  });
  supervisors.push(supervisor);
  return {
    supervisor,
    next: () =>
      new Promise<LaunchedRunner>((resolve, reject) => {
        const ready = readies.shift();
        if (ready) return resolve(ready);
        const timer = setTimeout(
          () => reject(new Error("No ready runner in 10 s")),
          10_000
        );
        waiters.push((runner) => {
          clearTimeout(timer);
          resolve(runner);
        });
      }),
  };
}

function temp() {
  const dir = mkdtempSync(join(tmpdir(), "local-fence-test-"));
  temps.push(dir);
  return dir;
}

const call = (runner: LaunchedRunner, ...args: [string, unknown]) =>
  callLocalSocket(
    runner.ready.socket,
    runner.ready.nonce,
    args[0] as "runner.health",
    args[1] as never
  );

const launch = (runner: LaunchedRunner, launchId: string) =>
  callLocalSocket(runner.ready.socket, runner.ready.nonce, "session.launch", {
    session: sessionFromWire("s"),
    launchId,
    engine: "fixture",
    model: null,
    effort: null,
    access: "default",
    resume: null,
    systemText: null,
    firstText: null,
    overflowNotice: null,
    env: {},
    mcp: [],
    owner: null,
  });

const exec = (runner: LaunchedRunner, key: string, timeoutMs = 5_000) =>
  callLocalSocket(
    runner.ready.socket,
    runner.ready.nonce,
    "checkout.exec",
    {
      target: { path: pathFromWire("/tmp") },
      guard: { path: "/tmp", digest: "d" },
      argv: [key],
      env: {},
      timeoutMs: null,
      maxOutput: null,
      shell: "direct",
    },
    timeoutMs
  );

const codeOf = (promise: Promise<unknown>) =>
  promise.then(
    () => "ok",
    (error: unknown) =>
      error instanceof RunnerCallError ? error.code : String(error)
  );

/** Every file under `root` with its content hash and size. */
function tree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stat = statSync(path);
      if (stat.isDirectory()) walk(path);
      else
        out[path.slice(root.length)] =
          `${stat.size}:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
    }
  };
  walk(root);
  return out;
}

const received = (root: string) => {
  try {
    return readFileSync(join(root, "received.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
};

describe("local runner write fence (real processes)", () => {
  it("frozen: writes are refused with fenced before any handler runs, reads answer; thaw admits writes again", async () => {
    const root = temp();
    const { next } = supervise(root);
    const runner = await next();
    expect(runner.ready.frozen).toBe(false);
    expect(await codeOf(launch(runner, "before"))).toBe("ok");

    await runner.fence(true, 5_000);
    expect(await codeOf(launch(runner, "during"))).toBe("fenced");
    expect(await codeOf(exec(runner, "during-exec"))).toBe("fenced");
    expect(await codeOf(call(runner, "runner.health", {}))).toBe("ok");
    expect(await codeOf(call(runner, "runner.describe", {}))).toBe("ok");
    // No handler saw the refused writes.
    expect(received(root)).toHaveLength(1);

    await runner.fence(false, 5_000);
    expect(await codeOf(launch(runner, "after"))).toBe("ok");
    expect(received(root)).toHaveLength(2);
  });

  it("a freeze is answered only once writes admitted before it have finished", async () => {
    const root = temp();
    const { next } = supervise(root);
    const runner = await next();
    // A write that never finishes is in flight when the freeze arrives.
    void exec(runner, "hang-write", 30_000).catch(() => {});
    const began = Date.now();
    while (received(root).length === 0 && Date.now() - began < 5_000)
      await new Promise((r) => setTimeout(r, 10));
    const freeze = await runner.fence(true, 400).then(
      () => "answered",
      (error: Error) => error.message
    );
    expect(freeze).toMatch(/did not answer the fence/);
    // Refusal starts at once, even before the answer.
    expect(await codeOf(launch(runner, "late"))).toBe("fenced");
  });

  it("starts frozen when asked, says so in ready, and a restart while frozen starts frozen again; no bytes change under the state root until exit", async () => {
    const root = temp();
    const { supervisor, next } = supervise(root, () => true);
    const first = await next();
    expect(first.ready.frozen).toBe(true);
    const before = tree(root);
    expect(await codeOf(launch(first, "probation"))).toBe("fenced");
    expect(await codeOf(exec(first, "probation-exec"))).toBe("fenced");
    expect(await codeOf(call(first, "runner.health", {}))).toBe("ok");

    process.kill(first.pid, "SIGKILL");
    const second = await next();
    expect(second.pid).not.toBe(first.pid);
    expect(second.ready.frozen).toBe(true);
    expect(await codeOf(launch(second, "after-restart"))).toBe("fenced");

    await supervisor.stop(2_000);
    expect(alive(second.pid)).toBe(false);
    expect(tree(root)).toEqual(before);
    expect(received(root)).toEqual([]);
  });
});
