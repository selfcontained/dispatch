import { inProcessPorts } from "../src/runners/in-process.js";
/*
 * A read sent to the local child is waited for, as main's read is, until it
 * answers, its connection is lost, or the caller cancels: never read twice.
 * The port here answers only when the child is provably not running it
 * (connection lost, never sent, or fenced). A live child that is merely slow
 * or stopped keeps its read; nothing kills it.
 */
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  open,
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
  type Req,
  type Runner,
} from "@dispatch/runner-protocol/contract";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runnerDirectory } from "../src/runners/directory.js";
import { controllerPlacement } from "../src/runners/placement.js";
import {
  startTestLocalRunner,
  type TestLocalRunner,
} from "./helpers/local-runner-child.js";

let root: string;
let child: TestLocalRunner;
let stopped: number | undefined;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "read-wait-")));
  await mkdir(join(root, "state"));
  await writeFile(join(root, "a.md"), "content");
  // A long restart backoff: any wait for a restarted child shows as time.
  child = startTestLocalRunner(join(root, "state"), { backoffMs: 60_000 });
  await child.ready();
  await child.session.call("runner.describe", {});
}, 60_000);

afterEach(async () => {
  if (stopped) process.kill(stopped, "SIGCONT");
  stopped = undefined;
  vi.restoreAllMocks();
  await child.stop();
  await rm(root, { recursive: true, force: true });
});

const adapter = () =>
  runnerDirectory({ child: () => child.session }).for(controllerPlacement);

/** A folder's native read (persona folders): it opens what it finds. */
const nativeRead = (path: string, signal?: AbortSignal) =>
  adapter().call(
    "checkout.read",
    {
      target: { path: pathFromWire(root) },
      path,
      mode: "native",
      encoding: "utf8",
      maxBytes: null,
    } as Req<"checkout.read">,
    signal && { signal }
  ) as Promise<{ data: string }>;

const readsHere = (here: ReturnType<typeof vi.spyOn>) =>
  here.mock.calls.filter(([op]) => op === "checkout.read").length;

it("waits on a live child's slow read: one reader, all the bytes", async () => {
  const fifo = join(root, "slow.fifo");
  execFileSync("mkfifo", [fifo]);
  const here = vi.spyOn(inProcessPorts().checkoutWorkload, "run");
  const read = nativeRead("slow.fifo");
  await delay(1_000);
  const payload = "x".repeat(1024 * 1024);
  await writeFile(fifo, payload);
  expect((await read).data).toBe(payload);
  expect(readsHere(here)).toBe(0);
}, 30_000);

it("a stopped child resumed before the writer finishes completes its own read", async () => {
  const fifo = join(root, "slow.fifo");
  execFileSync("mkfifo", [fifo]);
  const here = vi.spyOn(inProcessPorts().checkoutWorkload, "run");
  const read = nativeRead("slow.fifo");
  const writer = await open(fifo, "w");
  const prefix = "p".repeat(256 * 1024);
  const suffix = "s".repeat(256 * 1024);
  try {
    await writer.writeFile(prefix);
    stopped = child.current()!.pid;
    process.kill(stopped, "SIGSTOP");
    await delay(1_000);
    process.kill(stopped, "SIGCONT");
    stopped = undefined;
    await writer.writeFile(suffix);
  } finally {
    await writer.close();
  }
  expect((await read).data).toBe(prefix + suffix);
  expect(readsHere(here)).toBe(0);
}, 30_000);

it("a stopped child that dies loses its connection: the read is made here once", async () => {
  const here = vi.spyOn(inProcessPorts().checkoutWorkload, "run");
  const pid = child.current()!.pid;
  // Stopped: the request is written, never read.
  process.kill(pid, "SIGSTOP");
  stopped = pid;
  const read = nativeRead("a.md");
  await delay(500);
  expect(readsHere(here)).toBe(0);
  process.kill(pid, "SIGKILL");
  stopped = undefined;
  expect((await read).data).toBe("content");
  expect(readsHere(here)).toBe(1);
}, 30_000);

it("cancelling a read at a stopped child rejects at once, with no read here", async () => {
  const here = vi.spyOn(inProcessPorts().checkoutWorkload, "run");
  stopped = child.current()!.pid;
  process.kill(stopped, "SIGSTOP");
  const controller = new AbortController();
  const read = nativeRead("a.md", controller.signal);
  const rejected = expect(read).rejects.toMatchObject({ code: "cancelled" });
  await delay(300);
  const started = performance.now();
  controller.abort();
  await rejected;
  expect(performance.now() - started).toBeLessThan(500);
  expect(readsHere(here)).toBe(0);
}, 30_000);

it("a read a frozen child refuses (fenced) is made here, as before", async () => {
  const fenced = {
    connection: { state: "ready", epoch: 1, onChange: () => () => {} },
    call: vi.fn(async () => {
      throw new RunnerCallError({ code: "fenced", message: "frozen" });
    }),
  } as unknown as Runner;
  const here = vi.spyOn(inProcessPorts().checkoutWorkload, "run");
  const read = runnerDirectory({ child: () => fenced })
    .for(controllerPlacement)
    .call("checkout.read", {
      target: { path: pathFromWire(root) },
      path: "a.md",
      mode: "native",
      encoding: "utf8",
      maxBytes: null,
    } as Req<"checkout.read">) as Promise<{ data: string }>;
  expect((await read).data).toBe("content");
  expect(readsHere(here)).toBe(1);
});
