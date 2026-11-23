import {
  displayPath,
  RunnerCallError,
  runnerIdToWire,
  sessionToWire,
  type CallName,
  type CallOptions,
  type Req,
  type Res,
  type Runner,
  type RunnerDescription,
} from "@dispatch/runner-protocol/contract";
import {
  RUNNER_WIRE_VERSION,
  type CheckoutCommand,
  type CheckoutCommandFile,
  type CheckoutCommandResult,
} from "@dispatch/runner-protocol";
import type {
  CheckoutRunner,
  CheckoutSession,
  LocalCheckoutRunner,
} from "./directory.js";
import {
  selfCommand,
  superviseRunner,
  type LaunchedRunner,
  type LauncherBinding,
} from "@dispatch/runner-client/launcher";
import { LocalRunnerSession } from "@dispatch/runner-client/session";
import { childProcessEnv } from "../shared/process/child-environment.js";
import { LOCAL_RUNNER_ID } from "./placement.js";
import { checkoutWorkload } from "../agents/checkout-worker.js";
import {
  agentDiffPath,
  agentWorkspaceDir,
} from "../agents/workspace-target.js";

/** Checkout reads the local runner child serves (T09). */
const CHILD_READS = new Set<CallName>([
  "checkout.list",
  "checkout.preview",
  "checkout.index",
  "checkout.read",
  "checkout.stats",
  "checkout.diff",
  "checkout.changes",
]);
type ChildRead =
  | "checkout.list"
  | "checkout.preview"
  | "checkout.index"
  | "checkout.read"
  | "checkout.stats"
  | "checkout.diff"
  | "checkout.changes";

/** How long a read waits for a child that is restarting. */
const CHILD_WAIT_MS = 15_000;

/**
 * Each child's answers to `workspace.describe`, per connection epoch. A
 * binding the child holds never changes (import never replaces one), so a
 * found path is kept until the child reconnects; not found is asked again.
 */
const bound = new WeakMap<
  Runner,
  { epoch: number; paths: Map<string, string> }
>();

async function childBinding(
  child: Runner,
  session: Req<"workspace.describe">["session"],
  signal: AbortSignal
): Promise<string | null> {
  let cache = bound.get(child);
  if (!cache || cache.epoch !== child.connection.epoch)
    bound.set(
      child,
      (cache = { epoch: child.connection.epoch, paths: new Map() })
    );
  const known = cache.paths.get(sessionToWire(session));
  if (known !== undefined) return known;
  try {
    const binding = await child.call(
      "workspace.describe",
      { session },
      { signal }
    );
    const path = displayPath(binding.path);
    cache.paths.set(sessionToWire(session), path);
    return path;
  } catch (error) {
    if (error instanceof RunnerCallError && error.code === "not_found")
      return null;
    throw error;
  }
}

export function createLocalCheckoutRunner(
  local: LocalCheckoutRunner,
  agent: CheckoutSession | undefined,
  description: RunnerDescription,
  child?: Runner
): CheckoutRunner {
  /**
   * A checkout read for the bound session: through the child when it holds
   * this session's checkout at the directory the agent row names, else in
   * process with the same workload. The second case is temporary (R3, T18):
   * sessions launched after the import, or moved since, have no current
   * binding in the child until launches and moves write one.
   */
  async function read<K extends ChildRead>(
    op: K,
    input: Req<K>,
    options?: CallOptions<K>
  ): Promise<Res<K>> {
    const { target, ...request } = input as Req<ChildRead>;
    if (!("session" in target) || sessionToWire(target.session) !== agent?.id)
      throw new RunnerCallError({
        code: "invalid",
        message: "Invalid native checkout binding.",
      });
    const views = op !== "checkout.read" && op !== "checkout.changes";
    const row = { baseBranch: null, ...agent };
    const directory =
      op === "checkout.stats" || op === "checkout.diff"
        ? agentDiffPath(row)
        : agentWorkspaceDir(row);
    if (!directory) {
      if (op === "checkout.stats") return null as Res<K>;
      throw new RunnerCallError({
        code: "not_found",
        message: views
          ? "This agent has no workspace."
          : "The session checkout is unavailable.",
        details: { status: views ? 404 : 409, class: "agent" },
      });
    }
    if (child) {
      const signal = AbortSignal.any([
        AbortSignal.timeout(CHILD_WAIT_MS),
        ...(options?.signal ? [options.signal] : []),
      ]);
      if ((await childBinding(child, target.session, signal)) === directory)
        return child.call(
          op,
          {
            ...input,
            target: { session: target.session, checkout: "current" },
          },
          options
        );
    }
    return checkoutWorkload.run(op, { directory, request } as never, {
      signal: options?.signal,
    });
  }

  async function requestCheckout(operation: CheckoutCommand) {
    if (!agent)
      throw new RunnerCallError({
        code: "invalid",
        message: "Invalid native checkout command binding.",
      });
    const { value } = await local.requestSession(
      { kind: "checkoutCommand", agentId: agent.id, operation },
      { checkout: agent }
    );
    try {
      return typeof value === "string"
        ? (JSON.parse(value) as unknown)
        : undefined;
    } catch {
      throw new Error("Invalid runner checkout command response.");
    }
  }

  return {
    describe: () => description,
    connection: { state: "ready", epoch: 0, onChange: () => () => {} },
    async readManifest(operation) {
      return (await requestCheckout(operation)) as CheckoutCommandFile | null;
    },
    async call<K extends CallName>(
      op: K,
      input: Req<K>,
      options?: CallOptions<K>
    ): Promise<Res<K>> {
      if (op === "runner.describe") return description as Res<K>;
      if (CHILD_READS.has(op))
        return read(
          op as ChildRead,
          input as Req<ChildRead>,
          options as CallOptions<ChildRead>
        ) as Promise<Res<K>>;
      if (op !== "checkout.exec")
        throw new RunnerCallError({
          code: "unsupported",
          message: `Unsupported operation: ${op}`,
        });

      const { target, guard, argv } = input as Req<"checkout.exec">;
      if (!("session" in target) || sessionToWire(target.session) !== agent?.id)
        throw new RunnerCallError({
          code: "invalid",
          message: "Invalid native checkout command binding.",
        });
      return (await requestCheckout({
        checkout:
          target.checkout === "current"
            ? "effective"
            : (target.checkout ?? "effective"),
        path: guard.path,
        kind: "run",
        state: guard.digest,
        argv,
      })) as CheckoutCommandResult as Res<K>;
    },
    async open(op) {
      throw new RunnerCallError({
        code: "unsupported",
        message: `Unsupported operation: ${op}`,
      });
    },
  };
}

export type LocalRunnerLog = {
  info(object: object, message: string): void;
  warn(object: object, message: string): void;
};

/**
 * The updater's view of the child. Every answer is fresh; anything the child
 * cannot confirm in time is an error, never a guess.
 */
export type LocalRunnerFence = {
  /** `idle`, or why the child cannot be counted idle (`unavailable` included). */
  activity(): Promise<"idle" | "unavailable" | "busy">;
  /** Freeze the child's writes; resolves only on the child's confirmation. */
  freeze(): Promise<void>;
  /** Release the fence; a child started later starts thawed. */
  thaw(): Promise<void>;
  /**
   * The frozen child's own session count, read now. Throws when the child is
   * not confirmed frozen or does not answer.
   */
  frozenSessions(): Promise<number>;
};

/** The child as a `Runner`, while the app has one. */
export function localRunnerOf(process: LocalRunnerProcess | undefined) {
  return process?.runner;
}

export type LocalRunnerProcess = LocalRunnerFence & {
  /** The child as a `Runner`: one connection, retried while unavailable. */
  runner: LocalRunnerSession;
  stop(graceMs?: number): Promise<void>;
};

const FENCE_ANSWER_MS = 10_000;
const IMPORT_ANSWER_MS = 60_000;
const READ_MS = 5_000;

/** The child as the fence sees it: the launcher's handle. */
type FenceChild = Pick<LaunchedRunner, "pid" | "fence"> & {
  ready: Pick<LaunchedRunner["ready"], "frozen">;
};

/**
 * The fence over one supervised child. `wanted` is read at each (re)start so
 * a restarted child stays frozen; `ready` records each child that came up.
 * Reads go through the session without waiting: unavailable is an answer of
 * its own, never treated as idle or empty.
 */
export function createLocalRunnerFence(input: {
  runner: Pick<LocalRunnerSession, "call">;
  /** The child running now, or null while it is down. */
  current: () => FenceChild | null;
  frozen: boolean;
  log: LocalRunnerLog;
}): LocalRunnerFence & {
  readonly wanted: boolean;
  ready(child: FenceChild | null): void;
} {
  const { runner, current, log } = input;
  let frozen = input.frozen;
  // The running child that confirmed it is frozen, by `fence` or `ready`.
  let confirmed: FenceChild | null = null;
  const health = () =>
    runner.call(
      "runner.health",
      {},
      { wait: false, signal: AbortSignal.timeout(READ_MS) }
    );
  return {
    get wanted() {
      return frozen;
    },
    ready(child) {
      confirmed = child?.ready.frozen ? child : null;
    },
    async activity() {
      try {
        return (await health()).working > 0 ? "busy" : "idle";
      } catch {
        return "unavailable";
      }
    },
    async freeze() {
      frozen = true;
      const child = current();
      if (!child) throw new Error("The local runner is unavailable");
      await child.fence(true, FENCE_ANSWER_MS);
      if (!frozen || current() !== child)
        throw new Error("The local runner changed while freezing");
      confirmed = child;
      log.info({ pid: child.pid }, "Local runner frozen");
    },
    async thaw() {
      frozen = false;
      confirmed = null;
      const child = current();
      if (!child) return;
      await child.fence(false, FENCE_ANSWER_MS);
      log.info({ pid: child.pid }, "Local runner thawed");
    },
    async frozenSessions() {
      const child = current();
      if (!frozen || !child || confirmed !== child)
        throw new Error("The local runner is not confirmed frozen");
      const sample = await health();
      // The answer must come from the child that confirmed the fence.
      if (current() !== child || confirmed !== child)
        throw new Error("The local runner changed while it was read");
      return sample.sessions;
    },
  };
}

/**
 * Start this app's local runner as a child (`<this executable> local-runner`)
 * and keep it running: exact build handshake, EOF lifeline, restart with
 * backoff. It never blocks start-up, and nothing is routed through it yet:
 * if it cannot start, the app logs, backs off and retries.
 */
export function startLocalRunnerProcess(options: {
  stateRoot: string;
  filesRoot: string;
  build: { version: string; revision: string | null };
  log: LocalRunnerLog;
  /** Start frozen (an update's probation): writes are refused until `thaw`. */
  frozen?: boolean;
  /**
   * Bindings for sessions older builds started, read fresh each time. Sent
   * to every child that comes up thawed and again after `thaw`; the child
   * keeps any binding it already holds, so repeating is safe.
   */
  bindings?: () => Promise<LauncherBinding[]>;
}): LocalRunnerProcess {
  const { log } = options;
  const importBindings = async (child: LaunchedRunner) => {
    if (!options.bindings) return;
    try {
      const answer = await child.importBindings(
        await options.bindings(),
        IMPORT_ANSWER_MS
      );
      if (answer.error || answer.invalid)
        log.warn(
          { pid: child.pid, ...answer },
          "Local runner did not store every binding"
        );
      else if (!answer.frozen)
        log.info(
          {
            pid: child.pid,
            added: answer.added,
            kept: answer.kept,
          },
          "Local runner bindings imported"
        );
    } catch (err) {
      log.warn({ pid: child.pid, err }, "Local runner binding import failed");
    }
  };
  const runnerId = runnerIdToWire(LOCAL_RUNNER_ID);
  const runner = new LocalRunnerSession({
    description: {
      runnerId: LOCAL_RUNNER_ID,
      displayName: "Local",
      build: {
        version: options.build.version,
        ...(options.build.revision && { revision: options.build.revision }),
      },
      protocol: RUNNER_WIRE_VERSION,
      engines: [],
      capabilities: {},
    },
  });
  const fence = createLocalRunnerFence({
    runner,
    current: () =>
      supervisor.state.state === "ready" ? supervisor.state.runner : null,
    frozen: options.frozen === true,
    log,
  });
  const supervisor = superviseRunner({
    command: selfCommand("local-runner"),
    // Main's child-environment scrub: no database URL, tokens or API keys.
    env: childProcessEnv(),
    start: {
      build: {
        version: options.build.version,
        ...(options.build.revision && { revision: options.build.revision }),
      },
      roots: { state: options.stateRoot, files: options.filesRoot },
      config: {
        runnerId,
        displayName: "Local",
        engines: [],
      },
    },
    frozen: () => fence.wanted,
    onStderr: (line) => log.info({ localRunner: line }, "Local runner output"),
    onState(state) {
      fence.ready(state.state === "ready" ? state.runner : null);
      if (state.state === "ready") {
        const { pid, ready } = state.runner;
        log.info({ pid }, "Local runner ready");
        runner.setEndpoint({ socket: ready.socket, nonce: ready.nonce });
        // A frozen child stores nothing; `thaw` sends the import instead.
        if (!ready.frozen) void importBindings(state.runner);
        // A start-up self-check over the socket; nothing else uses it yet.
        const signal = AbortSignal.timeout(10_000);
        void Promise.all([
          runner.call("runner.describe", {}, { signal }),
          runner.call("runner.health", {}, { signal }),
        ])
          .then(([description, health]) =>
            log.info(
              {
                pid,
                build: description.build,
                sessions: health.sessions,
                memoryUsed: health.memoryUsed,
              },
              "Local runner answered describe and health"
            )
          )
          .catch((err: unknown) =>
            log.warn(
              { pid, err },
              "Local runner did not answer describe and health"
            )
          );
      } else if (state.state === "waiting") {
        runner.setEndpoint(null);
        log.warn(
          {
            reason: (state.error as { reason?: string }).reason,
            err: state.error.message,
            retryInMs: state.retryInMs,
          },
          "Local runner is not running; retrying"
        );
      }
    },
  });
  return {
    runner,
    activity: fence.activity,
    freeze: fence.freeze,
    async thaw() {
      await fence.thaw();
      const child =
        supervisor.state.state === "ready" ? supervisor.state.runner : null;
      if (child) void importBindings(child);
    },
    frozenSessions: fence.frozenSessions,
    async stop(graceMs = 3_000) {
      runner.close();
      await supervisor.stop(graceMs);
    },
  };
}
