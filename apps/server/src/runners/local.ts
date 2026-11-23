import {
  RunnerCallError,
  runnerIdToWire,
  sessionToWire,
  type CallName,
  type Req,
  type Res,
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
} from "@dispatch/runner-client/launcher";
import { LocalRunnerSession } from "@dispatch/runner-client/session";
import { childProcessEnv } from "../shared/process/child-environment.js";
import { LOCAL_RUNNER_ID } from "./placement.js";

export function createLocalCheckoutRunner(
  local: LocalCheckoutRunner,
  agent: CheckoutSession | undefined,
  description: RunnerDescription
): CheckoutRunner {
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
    async call<K extends CallName>(op: K, input: Req<K>): Promise<Res<K>> {
      if (op === "runner.describe") return description as Res<K>;
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

export type LocalRunnerProcess = LocalRunnerFence & {
  /** The child as a `Runner`: one connection, retried while unavailable. */
  runner: LocalRunnerSession;
  stop(graceMs?: number): Promise<void>;
};

const FENCE_ANSWER_MS = 10_000;
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
}): LocalRunnerProcess {
  const { log } = options;
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
    thaw: fence.thaw,
    frozenSessions: fence.frozenSessions,
    async stop(graceMs = 3_000) {
      runner.close();
      await supervisor.stop(graceMs);
    },
  };
}
