/*
 * The app's real local runner child for tests that drive local agent hosts:
 * the runtime attaches, checks and reads local hosts through it. One child
 * per state root (the root's lock admits one), supervised and restarted as
 * the app does, reached through a `LocalRunnerSession`.
 */
import { fileURLToPath } from "node:url";
import {
  superviseRunner,
  type LaunchedRunner,
  type RunnerSupervisor,
} from "@dispatch/runner-client/launcher";
import { LocalRunnerSession } from "@dispatch/runner-client/session";
import type { LocalEndpoint } from "@dispatch/runner-client/transport/local-socket";
import { RunnerCallError } from "@dispatch/runner-protocol/contract";
import { createSessionCore, localSessionHandlers } from "@dispatch/runner/cli";
import { embeddedBuild } from "../../src/agents/build-identity.js";
import { hostCommand } from "../../src/agents/acp/host-command.js";
import { localHostEntry } from "../../src/agents/acp/local-host-entry.js";
import type { LocalSessionRunner } from "../../src/runners/local.js";

const entry = fileURLToPath(
  new URL("../fixtures/local-runner-entry.ts", import.meta.url)
);
const bun = process.versions.bun
  ? process.execPath
  : (process.env.BUN_BINARY ?? "bun");
const build = {
  version: embeddedBuild.version,
  ...(embeddedBuild.revision && { revision: embeddedBuild.revision }),
};

export type TestLocalRunner = {
  session: LocalRunnerSession;
  /** Every child pid that came up, oldest first. */
  pids: number[];
  /** The child running now. */
  current(): LaunchedRunner | null;
  /** The endpoint of the child running now, for another process to use. */
  endpoint(): LocalEndpoint;
  /** Resolves when a child (after `after` pids) is ready. */
  ready(after?: number): Promise<void>;
  stop(): Promise<void>;
};

export function sessionFor(endpoint: LocalEndpoint | null) {
  const session = new LocalRunnerSession({
    description: {
      runnerId: "local" as never,
      displayName: "Local",
      build,
      protocol: 1 as never,
      engines: [],
      capabilities: {},
    },
    retry: { initialMs: 50, maxMs: 200 },
  });
  session.setEndpoint(endpoint);
  return session;
}

/**
 * Start the child for `stateRoot`; it restarts after a crash. The session is
 * usable at once: calls wait for the child.
 */
export function startTestLocalRunner(
  stateRoot: string,
  options: { env?: Record<string, string>; backoffMs?: number } = {}
): TestLocalRunner {
  const session = sessionFor(null);
  const pids: number[] = [];
  let current: LaunchedRunner | null = null;
  const waiters: Array<() => void> = [];
  const supervisor: RunnerSupervisor = superviseRunner({
    command: [bun, entry, "local-runner"],
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      SHELL: process.env.SHELL,
      BUN_RUNTIME_TRANSPILER_CACHE_PATH:
        process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH,
      ...options.env,
    },
    start: {
      build,
      roots: { state: stateRoot, files: stateRoot },
      config: {
        runnerId: "local",
        displayName: "Local",
        engines: [],
        // As the app sends it: the host argv from the app's environment.
        hostCommand: hostCommand(),
      },
    },
    backoff: {
      initialMs: options.backoffMs ?? 50,
      maxMs: options.backoffMs ?? 200,
    },
    onState(state) {
      if (state.state === "ready") {
        current = state.runner;
        pids.push(state.runner.pid);
        session.setEndpoint({
          socket: state.runner.ready.socket,
          nonce: state.runner.ready.nonce,
        });
        for (const resolve of waiters.splice(0)) resolve();
      } else if (state.state !== "starting") {
        current = null;
        session.setEndpoint(null);
      }
    },
  });
  const ready = async (after = 0) => {
    while (pids.length <= after || !current)
      await new Promise<void>((resolve) => waiters.push(resolve));
  };
  return {
    session,
    pids,
    current: () => current,
    endpoint() {
      if (!current) throw new Error("No local runner child is running");
      return { socket: current.ready.socket, nonce: current.ready.nonce };
    },
    ready,
    async stop() {
      session.close();
      await supervisor.stop(2_000);
    },
  };
}

const shared = new Map<string, TestLocalRunner>();

/** The child for `stateRoot`, started on first use and shared after. */
export function localRunnerFor(stateRoot: string) {
  let child = shared.get(stateRoot);
  if (!child) shared.set(stateRoot, (child = startTestLocalRunner(stateRoot)));
  return child;
}

/** Stop every shared child (call from `afterAll`). */
export async function stopLocalRunners() {
  const children = [...shared.values()];
  shared.clear();
  await Promise.all(children.map((child) => child.stop()));
}

/**
 * The child's session family run in this process, for tests about the
 * runtime's queue and holds rather than the child process: the same
 * handlers, called directly.
 */
export function inProcessLocalRunner(stateRoot: string): LocalSessionRunner {
  const handlers = localSessionHandlers({
    root: stateRoot,
    entry: localHostEntry(),
    command: hostCommand(),
    createSessions: createSessionCore,
  });
  const context = {
    receiveBlob: () => Promise.reject(new Error("No blobs in process")),
    emit: () => {},
  };
  return {
    async call(op, input) {
      const handler = (
        handlers.calls as Record<
          string,
          ((input: unknown, ctx: typeof context) => unknown) | undefined
        >
      )[op];
      if (!handler)
        throw new RunnerCallError({
          code: "unsupported",
          message: `Unsupported operation: ${op}`,
        });
      return (await handler(input, context)) as never;
    },
    async openStream(op, input) {
      const handler = handlers.opens?.[op as "session.attach"];
      if (!handler)
        throw new RunnerCallError({
          code: "unsupported",
          message: `Unsupported operation: ${op}`,
        });
      return (await handler(input as never, context)) as never;
    },
  };
}

const inProcess = new Map<string, LocalSessionRunner>();

/** `inProcessLocalRunner` for `stateRoot`, one per root, as a runtime getter. */
export function localRunnerIn(stateRoot: string) {
  let runner = inProcess.get(stateRoot);
  if (!runner)
    inProcess.set(stateRoot, (runner = inProcessLocalRunner(stateRoot)));
  return () => runner;
}
