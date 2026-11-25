/*
 * T14: a local agent's repo tools and stop hooks run Dispatch → Runners →
 * the local runner session → the child's socket → the core → the workload,
 * when the child holds the session's checkout; otherwise in process with the
 * same workload. The child here is the real socket server, core handlers,
 * binding store, fence and workload, in this process; commands are real
 * child processes.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyBaseLogger } from "fastify";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import {
  runnerIdFromWire,
  sessionFromWire as sessionOf,
  type Runner,
} from "@dispatch/runner-protocol/contract";
import { LocalRunnerSession } from "@dispatch/runner-client/session";
import { serveSocket } from "../../../packages/runner/src/local/socket-server.js";
import { BindingStore } from "../../../packages/runner/src/local/bindings.js";
import { WriteFence } from "../../../packages/runner/src/local/fence.js";
import { checkoutHandlers } from "../../../packages/runner/src/core/checkout.js";
import { checkoutWorkload } from "./helpers/checkout-workload.js";
import { requestCheckoutCommand } from "../src/agents/checkout-commands.js";
import { runLifecycleHook } from "../src/agents/lifecycle-hooks.js";
import { controllerPlacement } from "../src/runners/placement.js";
import type { AgentRecord } from "../src/agents/types.js";

const dirs: string[] = [];
const temp = (prefix: string) => {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

let repo: string;
let other: string;
let socket: { close(): void };
let session: LocalRunnerSession;
let fence: WriteFence;
const runs: string[] = [];
const pids: number[] = [];
const bound = "agt_bound";

const agent = (id: string, cwd = repo) =>
  ({
    id,
    cwd,
    worktreePath: null,
    workspacePath: null,
    placement: controllerPlacement,
  }) as AgentRecord;
const runners = { child: (): Runner => session };
const tools = {
  checkout: "effective",
  path: ".dispatch/tools.json",
} as const;

async function manifest(dir: string, body: object) {
  await mkdir(path.join(dir, ".dispatch"), { recursive: true });
  await writeFile(
    path.join(dir, ".dispatch", "tools.json"),
    JSON.stringify(body)
  );
}

async function tool(record: AgentRecord, argv: string[], signal?: AbortSignal) {
  const file = await requestCheckoutCommand(runners, record, {
    ...tools,
    kind: "read",
  });
  return requestCheckoutCommand(
    runners,
    record,
    { ...tools, kind: "run", state: file!.state, argv },
    signal
  );
}

const alive = (pid: number) => {
  try {
    const stat = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], {
      encoding: "utf8",
    }).trim();
    return /^[^Z]/.test(stat);
  } catch {
    return false;
  }
};

beforeAll(async () => {
  repo = temp("child-commands-repo-");
  other = temp("child-commands-other-");
  await manifest(repo, {});
  await manifest(other, {});
  const store = new BindingStore(temp("child-commands-state-"));
  await store.import([
    { session: bound, path: repo, currentPath: null, worktree: null },
  ]);
  fence = new WriteFence(false);
  const workload = {
    run: ((...args: Parameters<typeof checkoutWorkload.run>) => {
      runs.push(args[0]);
      return checkoutWorkload.run(...args);
    }) as typeof checkoutWorkload.run,
  };
  const runtime = temp("child-commands-sock-");
  const socketPath = path.join(runtime, "s");
  const nonce = randomUUID();
  socket = await serveSocket(
    socketPath,
    nonce,
    { calls: checkoutHandlers(store, { workload }) },
    fence
  );
  session = new LocalRunnerSession({
    description: {
      runnerId: runnerIdFromWire("local"),
      displayName: "Local",
      build: { version: "test" },
      protocol: 1,
      engines: [],
      capabilities: {},
    },
  });
  session.setEndpoint({ socket: socketPath, nonce });
});

afterEach(() => {
  runs.length = 0;
  fence.thaw();
  vi.restoreAllMocks();
});

afterAll(() => {
  for (const pid of pids)
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  session?.close();
  socket?.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

it("runs a bound session's repo tool in the child, uncapped, with its agent id", async () => {
  const result = await tool(agent(bound), [
    "sh",
    "-c",
    'printf %200000s "" | tr " " x; printf "$DISPATCH_AGENT_ID" >&2',
  ]);
  expect(runs).toEqual(["checkout.exec"]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toHaveLength(200_000);
  expect(result.stderr).toBe(bound);
  expect(result).not.toHaveProperty("truncated");
});

it("runs an unbound session's tool in process with the same workload", async () => {
  const result = await tool(agent("agt_unbound", other), ["pwd"]);
  expect(runs).toEqual([]);
  expect(result.stdout).toBe(await realpath(other));
});

it("answers stale through the child when the manifest changed after the read", async () => {
  const record = agent(bound);
  const file = await requestCheckoutCommand(runners, record, {
    ...tools,
    kind: "read",
  });
  await manifest(repo, { changed: true });
  try {
    await expect(
      requestCheckoutCommand(runners, record, {
        ...tools,
        kind: "run",
        state: file!.state,
        argv: ["true"],
      })
    ).rejects.toMatchObject({ code: "stale" });
  } finally {
    await manifest(repo, {});
  }
});

it("leaves a cancelled tool's process running, as main did", async () => {
  const abort = new AbortController();
  const pidFile = path.join(repo, "tool.pid");
  const call = tool(
    agent(bound),
    ["sh", "-c", 'sleep 60 & echo "$!" > tool.pid; wait'],
    abort.signal
  ).catch((error: unknown) => error);
  let pid = 0;
  await vi.waitFor(async () => {
    pid = Number(await readFile(pidFile, "utf8"));
    expect(pid).toBeGreaterThan(0);
  });
  pids.push(pid);
  abort.abort();
  await expect(call).resolves.toMatchObject({ code: "cancelled" });
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(alive(pid)).toBe(true);
  await rm(pidFile, { force: true });
});

it("kills only a timed-out stop hook in the child, leaving what it started", async () => {
  const launch = temp("child-commands-hook-");
  await manifest(launch, {
    hooks: {
      stop: {
        command: [
          "sh",
          "-c",
          "sleep 60 >/dev/null 2>&1 & echo $! > child.pid; wait",
        ],
      },
    },
  });
  const store = new BindingStore(temp("child-commands-hook-state-"));
  await store.import([
    { session: "agt_hook", path: launch, currentPath: null, worktree: null },
  ]);
  const runtime = temp("child-commands-hook-sock-");
  const socketPath = path.join(runtime, "s");
  const nonce = randomUUID();
  const hookRuns: string[] = [];
  const server = await serveSocket(
    socketPath,
    nonce,
    {
      calls: checkoutHandlers(store, {
        workload: {
          run: ((...args: Parameters<typeof checkoutWorkload.run>) => {
            hookRuns.push(args[0]);
            return checkoutWorkload.run(...args);
          }) as typeof checkoutWorkload.run,
        },
      }),
    },
    new WriteFence(false)
  );
  const child = new LocalRunnerSession({
    description: {
      runnerId: runnerIdFromWire("local"),
      displayName: "Local",
      build: { version: "test" },
      protocol: 1,
      engines: [],
      capabilities: {},
    },
  });
  child.setEndpoint({ socket: socketPath, nonce });
  // Shorten only the hook's 15 s deadline.
  const realSetTimeout = globalThis.setTimeout;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ) =>
    realSetTimeout(
      callback,
      delay === 15_000 ? 300 : delay,
      ...args
    )) as typeof setTimeout);
  const warn = vi.fn();
  try {
    await runLifecycleHook(
      "stop",
      { ...agent("agt_hook", launch), worktreePath: launch },
      { info: vi.fn(), warn } as unknown as FastifyBaseLogger,
      { child: () => child }
    );
    expect(hookRuns).toEqual(["checkout.exec"]);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.objectContaining({
          code: "timeout",
          message: "Checkout command timed out.",
        }),
      }),
      expect.any(String)
    );
    const pid = Number(await readFile(path.join(launch, "child.pid"), "utf8"));
    pids.push(pid);
    await new Promise((resolve) => realSetTimeout(resolve, 200));
    expect(alive(pid)).toBe(true);
  } finally {
    child.close();
    server.close();
  }
});

it("refuses a command with fenced while the child is frozen; reads still serve", async () => {
  const record = agent(bound);
  const file = await requestCheckoutCommand(runners, record, {
    ...tools,
    kind: "read",
  });
  await fence.freeze();
  await expect(
    requestCheckoutCommand(runners, record, {
      ...tools,
      kind: "run",
      state: file!.state,
      argv: ["true"],
    })
  ).rejects.toMatchObject({ code: "fenced" });
  expect(runs).toEqual([]);
  await expect(
    session.call("checkout.read", {
      target: { session: sessionOf(bound), checkout: "current" },
      path: ".dispatch/tools.json",
      encoding: "utf8",
      maxBytes: null,
    })
  ).resolves.toMatchObject({ data: "{}" });
});
