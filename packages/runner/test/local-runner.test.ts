/*
 * The local runner child with real processes: a fixture app (bun) supervises
 * the runner (bun) on a temp state root. Every process a test starts is
 * tracked by pid and must be gone when the test ends.
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { once } from "node:events";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  pathFromWire,
  runnerIdFromWire,
  runnerIdToWire,
  sessionFromWire,
  RunnerCallError,
} from "@dispatch/runner-protocol/contract";
import { LocalRunnerSession } from "@dispatch/runner-client/session";
import {
  callLocalSocket,
  jsonLines,
} from "@dispatch/runner-client/transport/local-socket";

const app = fileURLToPath(new URL("./fixtures/app.ts", import.meta.url));
const bun = process.env.BUN_BINARY ?? "bun";

type Event = {
  app: number;
  event: string;
  pid?: number;
  socket?: string;
  nonce?: string;
  reason?: string | null;
  message?: string;
  retryInMs?: number;
  at?: number;
};

const started = new Set<number>();
const temps: string[] = [];
/** Runtime files a killed runner could not remove (its socket and holder record). */
const runtimeFiles = new Set<string>();

function temp() {
  const dir = mkdtempSync(join(tmpdir(), "local-runner-test-"));
  temps.push(dir);
  return dir;
}

/** Whether a pid is a live, non-zombie process. */
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

async function gone(pid: number, withinMs: number) {
  const began = Date.now();
  while (Date.now() - began < withinMs) {
    if (!alive(pid)) return Date.now() - began;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`pid ${pid} still running after ${withinMs} ms`);
}

function startApp(
  env: Record<string, string>,
  argv: string[] = [app]
): {
  child: ChildProcess;
  events: Event[];
  next(match: (e: Event) => boolean, ms?: number): Promise<Event>;
} {
  const child = spawn(bun, argv, {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  started.add(child.pid!);
  const events: Event[] = [];
  const waiters: {
    match: (e: Event) => boolean;
    resolve: (e: Event) => void;
  }[] = [];
  let seen = 0;
  let pending = "";
  child.stdout!.on("data", (chunk: Buffer) => {
    pending += chunk.toString();
    let newline: number;
    while ((newline = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (!line.startsWith("{")) continue;
      const event = JSON.parse(line) as Event;
      if (event.pid) started.add(event.pid);
      if (event.socket)
        for (const file of [
          event.socket,
          event.socket.replace(/\.sock$/, ".holder"),
        ])
          runtimeFiles.add(file);
      events.push(event);
      for (const waiter of [...waiters])
        if (waiter.match(event)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(event);
        }
    }
  });
  let stderr = "";
  child.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  return {
    child,
    events,
    /** The next event after those already consumed that matches. */
    next(match, ms = 5_000) {
      const found = events.slice(seen).find(match);
      if (found) {
        seen = events.indexOf(found) + 1;
        return Promise.resolve(found);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(
              new Error(
                `No matching event in ${ms} ms: ${JSON.stringify(events)} ${stderr}`
              )
            ),
          ms
        );
        waiters.push({
          match,
          resolve: (event) => {
            clearTimeout(timer);
            seen = events.indexOf(event) + 1;
            resolve(event);
          },
        });
      });
    },
  };
}

const ready = (e: Event) => e.event === "ready";
const waiting = (e: Event) => e.event === "waiting";

afterEach(async () => {
  const survivors = [...started].filter(alive);
  for (const pid of survivors) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* gone */
    }
  }
  started.clear();
  for (const dir of temps.splice(0))
    rmSync(dir, { recursive: true, force: true });
  for (const file of runtimeFiles) rmSync(file, { force: true });
  runtimeFiles.clear();
  expect(survivors).toEqual([]);
});

describe("local runner child (real processes)", () => {
  it("negotiates stream framing on the authenticated child socket and still serves calls", async () => {
    const a = startApp({ STATE_ROOT: temp() });
    const r = await a.next(ready);
    const socket = connect(r.socket!);
    const frames: unknown[] = [];
    try {
      await once(socket, "connect", { signal: AbortSignal.timeout(2_000) });
      const replied = new Promise<void>((resolve) => {
        jsonLines(socket, (frame) => {
          frames.push(frame);
          if (frames.length === 3) resolve();
        });
      });
      const requests = [
        { nonce: r.nonce, streamCredit: true },
        { type: "stream", action: "open", id: "unregistered" },
        { id: 1, op: "runner.describe", input: {} },
      ];
      socket.write(
        requests.map((request) => JSON.stringify(request) + "\n").join("")
      );
      await Promise.race([
        replied,
        once(socket, "close", { signal: AbortSignal.timeout(2_000) }),
      ]);
      expect(frames).toEqual([
        { type: "stream", action: "accept" },
        {
          type: "stream",
          action: "cancel",
          id: "unregistered",
          code: "invalid",
        },
        {
          id: 1,
          ok: true,
          value: expect.objectContaining({ runnerId: "local" }),
        },
      ]);
    } finally {
      socket.destroy();
      a.child.kill("SIGTERM");
      await gone(r.pid!, 3_000);
    }
  });

  it("starts, completes the handshake, and serves describe and health to the spawn's nonce only", async () => {
    const root = temp();
    const began = Date.now();
    const a = startApp({ STATE_ROOT: root });
    const r = await a.next(ready);
    const startupMs = Date.now() - began;

    const description = await callLocalSocket(
      r.socket!,
      r.nonce!,
      "runner.describe",
      {}
    );
    expect(runnerIdToWire(description.runnerId)).toBe("local");
    expect(description.build).toEqual({ version: "0.0.0-test" });
    expect(description.capabilities).toEqual({
      sources: { directory: true, repository: true, defaultBaseBranch: "main" },
    });
    const health = await callLocalSocket(
      r.socket!,
      r.nonce!,
      "runner.health",
      {}
    );
    expect(health).toMatchObject({
      version: "0.0.0-test",
      sessions: 0,
      working: 0,
    });
    expect(health.memoryTotal).toBeGreaterThan(0);

    await expect(
      callLocalSocket(r.socket!, r.nonce!, "session.alive", {
        session: "x",
      } as never)
    ).rejects.toMatchObject({ code: "unsupported" });
    const wrong = await callLocalSocket(
      r.socket!,
      "not-the-nonce",
      "runner.describe",
      {}
    ).catch((error: unknown) => error);
    expect(wrong).toBeInstanceOf(RunnerCallError);

    expect(statSync(r.socket!).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(r.socket!)).mode & 0o777).toBe(0o700);
    console.info(`startup to ready: ${startupMs} ms`);

    a.child.kill("SIGTERM");
    console.info(`runner exit after app stop: ${await gone(r.pid!, 3_000)} ms`);
  });

  it("SIGKILL of the app: the runner exits promptly by its lifeline", async () => {
    const a = startApp({ STATE_ROOT: temp() });
    const r = await a.next(ready);
    a.child.kill("SIGKILL");
    const ms = await gone(r.pid!, 1_000);
    console.info(`runner exit after app SIGKILL: ${ms} ms`);
  });

  it("SIGKILL of the runner: the app restarts it with doubling backoff", async () => {
    const a = startApp({ STATE_ROOT: temp(), BACKOFF_MS: "200" });
    const first = await a.next(ready);
    process.kill(first.pid!, "SIGKILL");
    const w1 = await a.next(waiting);
    expect(w1.retryInMs).toBe(200);
    const second = await a.next(ready);
    expect(second.pid).not.toBe(first.pid);
    process.kill(second.pid!, "SIGKILL");
    const w2 = await a.next(waiting);
    expect(w2.retryInMs).toBe(400);
    const third = await a.next(ready);
    expect(third.pid).not.toBe(second.pid);
    a.child.kill("SIGTERM");
    await gone(third.pid!, 3_000);
  });

  it("two apps on one state root: the second app's runner is refused and the first keeps serving", async () => {
    const root = temp();
    const first = startApp({ STATE_ROOT: root });
    const r = await first.next(ready);
    const second = startApp({ STATE_ROOT: root, BACKOFF_MS: "5000" });
    const refused = await second.next(waiting);
    expect(refused.reason).toBe("locked");
    expect(refused.message).toMatch(/in use by another app's runner/);
    expect(second.events.some(ready)).toBe(false);
    await callLocalSocket(r.socket!, r.nonce!, "runner.describe", {});
    second.child.kill("SIGTERM");
    first.child.kill("SIGTERM");
    await gone(r.pid!, 3_000);
  });

  it("a build mismatch is refused with a clear error and leaves no runner", async () => {
    const a = startApp({
      STATE_ROOT: temp(),
      APP_BUILD: JSON.stringify({ version: "1.0.0", revision: "a".repeat(40) }),
      RUNNER_TEST_BUILD: JSON.stringify({
        version: "1.0.1",
        revision: "b".repeat(40),
      }),
      BACKOFF_MS: "5000",
    });
    const refused = await a.next(waiting);
    expect(refused.reason).toBe("mismatch");
    expect(refused.message).toMatch(
      /Build mismatch: the app is 1\.0\.0 \(a{40}\).*this runner is 1\.0\.1 \(b{40}\)/
    );
    a.child.kill("SIGTERM");
  });

  it("a leftover runner from a dead app is detected and replaced", async () => {
    const root = temp();
    const first = startApp({ STATE_ROOT: root });
    const leftover = await first.next(ready);
    // Stopped, it cannot see its lifeline: it outlives its app holding the lock.
    process.kill(leftover.pid!, "SIGSTOP");
    first.child.kill("SIGKILL");
    await gone(first.child.pid!, 1_000);
    expect(alive(leftover.pid!)).toBe(true);

    const began = Date.now();
    const second = startApp({ STATE_ROOT: root });
    const replacement = await second.next(ready, 10_000);
    console.info(`leftover replaced in ${Date.now() - began} ms`);
    expect(alive(leftover.pid!)).toBe(false);
    await callLocalSocket(
      replacement.socket!,
      replacement.nonce!,
      "runner.health",
      {}
    );
    second.child.kill("SIGTERM");
    await gone(replacement.pid!, 3_000);
  }, 15_000);

  it("a dev watch restart of the app leaves no orphan runner", async () => {
    const dir = temp();
    const wrapper = join(dir, "watched-app.ts");
    writeFileSync(wrapper, `import ${JSON.stringify(app)};\n`);
    const a = startApp({ STATE_ROOT: join(dir, "state") }, [
      "--watch",
      wrapper,
    ]);
    const first = await a.next(ready);
    appendFileSync(wrapper, "// touched\n");
    const second = await a.next(ready, 8_000);
    expect(second.app).toBe(first.app); // bun --watch re-executes in place.
    expect(second.pid).not.toBe(first.pid);
    expect(alive(first.pid!)).toBe(false);
    a.child.kill("SIGKILL");
    await gone(second.pid!, 1_000);
  }, 15_000);

  it("child killed mid-call: callers see unavailable, retries follow each operation's rule, a queued call is delivered once", async () => {
    const root = temp();
    const a = startApp({
      STATE_ROOT: root,
      BACKOFF_MS: "300",
      RUNNER_ENTRY: "./counting-runner-entry.ts",
    });
    const session = new LocalRunnerSession({
      description: {
        runnerId: runnerIdFromWire("local"),
        displayName: "Local",
        build: { version: "0.0.0-test" },
        protocol: 1,
        engines: [],
        capabilities: {},
      },
    });
    const states: string[] = [];
    session.connection.onChange((state) => states.push(state));
    const first = await a.next(ready);
    session.setEndpoint({ socket: first.socket!, nonce: first.nonce! });

    const received = () =>
      existsSync(join(root, "received.jsonl"))
        ? readFileSync(join(root, "received.jsonl"), "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as { key: string; pid: number })
        : [];
    const effects = () =>
      existsSync(join(root, "effects.jsonl"))
        ? readFileSync(join(root, "effects.jsonl"), "utf8")
            .trim()
            .split("\n")
            .map((line) => (JSON.parse(line) as { key: string }).key)
        : [];
    const launch = (launchId: string) =>
      session.call("session.launch", {
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
    const exec = (key: string) =>
      session.call("checkout.exec", {
        target: { path: pathFromWire("/tmp") },
        guard: { path: "/tmp", digest: "d" },
        argv: [key],
        env: {},
        timeoutMs: null,
        maxOutput: null,
        shell: "direct",
      });

    // Two calls in flight when the child dies: a keyed one and a `none` one.
    const keyed = launch("hang-keyed");
    const unkeyed = exec("hang-unkeyed").catch((error: unknown) => error);
    await until(() => received().length === 2);
    process.kill(first.pid!, "SIGKILL");
    await a.next(waiting);
    session.setEndpoint(null);
    expect(session.connection.state).toBe("unavailable");
    await expect(
      session.call("runner.describe", {}, { wait: false })
    ).rejects.toMatchObject({ code: "unavailable" });
    // Sent after the loss: queued until the runner is back.
    const queued = launch("queued");

    const second = await a.next(ready);
    expect(second.pid).not.toBe(first.pid);
    session.setEndpoint({ socket: second.socket!, nonce: second.nonce! });
    await expect(keyed).resolves.toEqual({});
    await expect(queued).resolves.toEqual({});
    const lost = (await unkeyed) as RunnerCallError;
    expect(lost).toBeInstanceOf(RunnerCallError);
    expect(lost.code).toBe("unknown_outcome");

    const byKey = (key: string) => received().filter((r) => r.key === key);
    // The keyed call was repeated by its rule; the runner applied it once.
    expect(byKey("hang-keyed").map((r) => r.pid)).toEqual([
      first.pid,
      second.pid,
    ]);
    // A `none` call is never repeated; a queued call is sent exactly once.
    expect(byKey("hang-unkeyed").map((r) => r.pid)).toEqual([first.pid]);
    expect(byKey("queued").map((r) => r.pid)).toEqual([second.pid]);
    expect(effects().sort()).toEqual(["hang-keyed", "queued"]);
    expect(states).toContain("unavailable");
    expect(session.connection.state).toBe("ready");
    expect(session.connection.epoch).toBe(2);

    session.close();
    a.child.kill("SIGTERM");
    await gone(second.pid!, 3_000);
  }, 15_000);
});

async function until(condition: () => boolean, ms = 5_000) {
  const began = Date.now();
  while (!condition()) {
    if (Date.now() - began > ms) throw new Error("Condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
