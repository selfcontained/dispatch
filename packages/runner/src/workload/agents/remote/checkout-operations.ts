import { checkoutCommandTimeoutMs } from "./checkout-timeout.js";
import { Readable } from "node:stream";
import {
  isCheckoutExecutionOptions,
  scheduleDeadline,
  isCheckoutCommand,
  isCheckoutCommandArgv,
  isCheckoutCommandFile,
  isCheckoutReadRequest,
  type CheckoutCommand,
  type GitQueryName,
} from "@dispatch/runner-protocol";
import {
  RunnerCallError,
  displayPath,
  operations,
  runnerError,
  sessionToWire,
  type Req,
  type Res,
} from "@dispatch/runner-protocol/contract";
import type {
  CallHandlers,
  ConnectionContext,
  Handlers,
} from "../../../handlers.js";
import type { createSessionSupervisor } from "./session-supervisor.js";

type Supervisor = Pick<
  Awaited<ReturnType<typeof createSessionSupervisor>>,
  "checkoutDirectory" | "withCommandCheckout"
>;
type Query =
  | GitQueryName
  | "path.resolve"
  | "path.complete"
  | "git.remoteHeads";
export type CheckoutWorkers = {
  run(
    op: Query | "write" | "read",
    cwd: string | undefined,
    input: unknown,
    signal: AbortSignal
  ): Promise<string>;
  read(cwd: string, input: unknown, signal: AbortSignal): Readable;
  manifest(
    cwd: string,
    session: string,
    operation: Extract<CheckoutCommand, { kind: "read" }>,
    signal: AbortSignal
  ): Promise<string>;
  repositoryClone?(repository: string): Promise<string>;
};

const missing = () =>
  new RunnerCallError({ code: "not_found", message: "Checkout unavailable." });
const invalid = () =>
  new RunnerCallError({
    code: "invalid",
    message: "Invalid checkout binding.",
  });
const commandSelector = (selector?: "current" | "launch" | "moved") =>
  selector === "launch" || selector === "moved" ? selector : "effective";

function workerData<K extends Query | "checkout.write">(
  op: K,
  text: string
): Res<K> {
  const reply = JSON.parse(text);
  if (runnerError.check(reply?.error)) throw new RunnerCallError(reply.error);
  if (!reply || !operations[op].response.check(reply.data))
    throw new RunnerCallError({
      code: "failed",
      message: `Invalid ${op} worker response.`,
    });
  return reply.data as Res<K>;
}

export function enrolledCheckouts(
  supervisor: Supervisor,
  worker: CheckoutWorkers,
  connection: AbortSignal
) {
  function query<K extends Query>(op: K) {
    return async (input: Req<K>) => {
      const signal = AbortSignal.any([connection, AbortSignal.timeout(20_000)]);
      const run = (cwd?: string) => worker.run(op, cwd, input, signal);
      const target = "target" in input ? input.target : null;
      const raw =
        target && "session" in target
          ? await supervisor.withCommandCheckout(
              sessionToWire(target.session),
              commandSelector(target.checkout),
              signal,
              run
            )
          : await run(
              target && "path" in target
                ? displayPath(target.path)
                : op === "git.origin"
                  ? (input as Req<"git.origin">).path
                  : undefined
            );
      if (raw === null) throw missing();
      return workerData(op, raw);
    };
  }
  const calls = {
    "git.origin": query("git.origin"),
    "git.base": query("git.base"),
    "git.defaultBranch": query("git.defaultBranch"),
    "git.branches": query("git.branches"),
    "git.roots": query("git.roots"),
    "git.remoteHeads": query("git.remoteHeads"),
    "path.complete": query("path.complete"),
    "path.resolve": query("path.resolve"),
    "checkout.write": async ({ target, ...request }) => {
      if (!("session" in target)) throw invalid();
      const signal = AbortSignal.any([connection, AbortSignal.timeout(20_000)]);
      const raw = await supervisor.withCommandCheckout(
        sessionToWire(target.session),
        "effective",
        signal,
        (cwd) => worker.run("write", cwd, request, signal)
      );
      if (raw === null) throw missing();
      return workerData("checkout.write", raw);
    },
  } satisfies CallHandlers;

  const checkoutRead: NonNullable<Handlers["checkoutRead"]> = async (
    op,
    input,
    signal
  ) => {
    const { target, ...request } = input;
    const reply = (text: string) => Readable.from([Buffer.from(text)]);
    if (op === "checkout.defaultFiles" && "repository" in target) {
      if (!worker.repositoryClone)
        throw new RunnerCallError({
          code: "unsupported",
          message: "This runner does not read repository files.",
        });
      const cwd = await worker.repositoryClone(target.repository);
      return reply(
        await worker.run(
          "read",
          cwd,
          { op, request },
          AbortSignal.any([signal, AbortSignal.timeout(90_000)])
        )
      );
    }
    if (!("session" in target)) throw invalid();
    const session = sessionToWire(target.session);
    const manifest = input as Req<"checkout.read">;
    if (op === "checkout.read" && manifest.mode === "command-manifest") {
      const operation = {
        kind: "read",
        checkout: commandSelector(manifest.target.checkout),
        path: manifest.path,
      } as const;
      if (!isCheckoutCommand(operation)) throw invalid();
      const timeoutMs = checkoutCommandTimeoutMs(operation.checkout);
      const timeout = AbortSignal.timeout(timeoutMs);
      const active = AbortSignal.any([signal, timeout]);
      const text = await supervisor
        .withCommandCheckout(session, operation.checkout, active, (cwd) =>
          worker.manifest(cwd, session, operation, active)
        )
        .catch((error: unknown) => {
          if (timeout.aborted && active.reason === timeout.reason)
            throw new RunnerCallError({
              code: "timeout",
              message: `Runner checkout command timed out after ${timeoutMs / 1000} seconds.`,
            });
          throw error;
        });
      const file: unknown = text === null ? null : JSON.parse(text);
      if (!isCheckoutCommandFile(file))
        throw new RunnerCallError({
          code: "failed",
          message: "Invalid runner checkout command response.",
        });
      if (
        file &&
        manifest.maxBytes !== null &&
        Buffer.byteLength(file.content) > manifest.maxBytes
      )
        throw new RunnerCallError({
          code: "too_large",
          message: `The file is larger than ${manifest.maxBytes} bytes`,
        });
      return reply(
        JSON.stringify({
          data: file && { data: file.content, digest: file.state },
        })
      );
    }
    const selection = { op, request, checkout: target.checkout ?? "current" };
    if (!isCheckoutReadRequest(selection, session)) throw invalid();
    const cwd = await supervisor.checkoutDirectory(session, selection.checkout);
    signal.throwIfAborted();
    return worker.read(cwd, selection, signal);
  };
  return { calls, checkoutRead };
}

type ExecWorker = (
  cwd: string,
  session: string,
  input: Req<"checkout.exec">,
  send: NonNullable<ConnectionContext["sendOutput"]>,
  signal: AbortSignal
) => Promise<{ exitCode: number; truncated: boolean }>;

/** Hold both checkout locks until the workload exits and its output is acknowledged. */
export function enrolledCommand(
  supervisor: Supervisor,
  execute: ExecWorker
): NonNullable<CallHandlers["checkout.exec"]> {
  return async (input, { sendOutput, signal }) => {
    if (!sendOutput || !signal || !("session" in input.target)) throw invalid();
    const session = sessionToWire(input.target.session);
    const checkout = commandSelector(input.target.checkout);
    if (
      !isCheckoutExecutionOptions(input) ||
      !isCheckoutCommandArgv(input.argv) ||
      ("path" in input.guard &&
        !isCheckoutCommand({
          kind: "run",
          checkout,
          path: input.guard.path,
          state: input.guard.digest,
          argv: input.argv,
        }))
    )
      throw invalid();
    const deadline = new AbortController();
    const { timeoutMs } = input;
    const clear =
      timeoutMs === null
        ? undefined
        : scheduleDeadline(timeoutMs, () =>
            deadline.abort(
              new RunnerCallError({
                code: "timeout",
                message: `Runner checkout command timed out after ${timeoutMs / 1000} seconds.`,
              })
            )
          );
    const active = AbortSignal.any([signal, deadline.signal]);
    try {
      const result = await supervisor.withCommandCheckout(
        session,
        checkout,
        active,
        (cwd) => execute(cwd, session, input, sendOutput, active)
      );
      if (!result)
        throw new RunnerCallError({
          code: "stale",
          message: "The moved checkout is no longer selected.",
        });
      return {
        exitCode: result.exitCode,
        stdout: "",
        stderr: "",
        ...(input.maxOutput !== null && { truncated: result.truncated }),
      };
    } catch (error) {
      if (deadline.signal.aborted) throw deadline.signal.reason;
      throw error;
    } finally {
      clear?.();
    }
  };
}
