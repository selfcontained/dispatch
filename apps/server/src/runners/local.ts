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
import { selfCommand, superviseRunner } from "@dispatch/runner-client/launcher";
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

export type LocalRunnerProcess = {
  /** The child as a `Runner`: one connection, retried while unavailable. */
  runner: LocalRunnerSession;
  stop(graceMs?: number): Promise<void>;
};

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
    onStderr: (line) => log.info({ localRunner: line }, "Local runner output"),
    onState(state) {
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
    async stop(graceMs = 3_000) {
      runner.close();
      await supervisor.stop(graceMs);
    },
  };
}
