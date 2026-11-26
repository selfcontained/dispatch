import { Duplex, PassThrough, Writable } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
  isTerminalInfo,
  MANAGED_WORKSPACE,
  TERMINAL_UPDATE_MESSAGE,
} from "@dispatch/runner-protocol";
import {
  RunnerCallError,
  sessionToWire,
  type Req,
} from "@dispatch/runner-protocol/contract";
import type { OpenHandlers } from "../../../handlers.js";
import type { SharedCheckoutWatches } from "../checkout-watch.js";
import type { createSessionSupervisor } from "./session-supervisor.js";
import type { UpdateAdmission } from "./update-admission.js";

type Supervisor = Pick<
  Awaited<ReturnType<typeof createSessionSupervisor>>,
  "checkoutDirectory"
>;
type StartTerminal = (
  cwd: string,
  cols: number,
  rows: number
) => ChildProcessWithoutNullStreams;

export function enrolledChannels(
  supervisor: Supervisor,
  watches: SharedCheckoutWatches,
  admission: Pick<UpdateAdmission, "onTerminal">,
  startTerminal: StartTerminal
) {
  const terminals = new Map<AbortController, string>();
  let watchCount = 0;
  async function directory(target: Req<"terminal.open">["target"]) {
    if (!("session" in target))
      throw new RunnerCallError({
        code: "invalid",
        message: "Invalid checkout binding.",
      });
    return supervisor.checkoutDirectory(
      sessionToWire(target.session),
      MANAGED_WORKSPACE
    );
  }
  return {
    closeSession(id: string) {
      for (const [controller, session] of terminals)
        if (session === id) controller.abort();
    },
    opens: {
      "checkout.watch": async ({ target }, { signal }) => {
        const cwd = await directory(target);
        signal?.throwIfAborted();
        if (watchCount >= 512)
          throw new RunnerCallError({
            code: "busy",
            message: "Too many open checkout watches.",
          });
        let stop = () => {};
        const channel = new Duplex({
          allowHalfOpen: false,
          read() {},
          write(_, __, done) {
            done();
          },
          final(done) {
            channel.destroy();
            done();
          },
          destroy(error, done) {
            stop();
            watchCount--;
            done(error);
          },
        });
        watchCount++;
        try {
          stop = watches.subscribe(
            cwd,
            () => {
              if (!channel.destroyed) channel.push(Buffer.from("1"));
            },
            () => channel.push(null)
          );
        } catch (error) {
          channel.destroy();
          throw error;
        }
        return { info: {}, channel };
      },
      "terminal.open": async ({ target, cols, rows }, { signal }) => {
        if (!("session" in target))
          throw new RunnerCallError({
            code: "invalid",
            message: "Invalid checkout binding.",
          });
        const controller = new AbortController();
        const active = signal
          ? AbortSignal.any([controller.signal, signal])
          : controller.signal;
        terminals.set(controller, sessionToWire(target.session));
        let handedOff = false;
        let stop = () => {};
        try {
          const cwd = await directory(target);
          active.throwIfAborted();
          const child = startTerminal(cwd, cols, rows);
          const { stdin, stdout, stderr: readiness } = child;
          const events = new PassThrough();
          stop = () => {
            stdin.destroy();
            stdout.destroy();
            readiness.destroy();
            child.kill();
          };
          active.addEventListener("abort", stop, { once: true });
          child.once("error", () => controller.abort());
          stdin.on("error", () => {});
          stdout.on("error", () => controller.abort());
          child.once("close", () => {
            terminals.delete(controller);
            active.removeEventListener("abort", stop);
          });
          const controls = new Writable({
            write(chunk, _, done) {
              if (stdin.destroyed) return done();
              stdin.write(chunk, () => done());
            },
            final(done) {
              stdin.end(done);
            },
            destroy(error, done) {
              stdin.destroy();
              done(error);
            },
          });
          let ready = "";
          for await (const chunk of readiness) ready += chunk.toString();
          active.throwIfAborted();
          const info: unknown = ready ? JSON.parse(ready) : undefined;
          if (!isTerminalInfo(info))
            throw new Error(
              "The runner could not start a terminal in this checkout."
            );
          const channel = Duplex.from({ readable: events, writable: controls });
          stdout.pipe(events);
          stdout.once("close", () => {
            if (!events.writableEnded) events.end();
          });
          const unfenced = admission.onTerminal(() => {
            stdout.unpipe(events);
            events.end(
              JSON.stringify({
                type: "error",
                reason: "update",
                message: TERMINAL_UPDATE_MESSAGE,
              }) + "\n"
            );
            controller.abort();
          });
          channel.once("close", () => {
            unfenced();
            controller.abort();
            terminals.delete(controller);
          });
          handedOff = true;
          return { info, channel };
        } finally {
          if (!handedOff) {
            controller.abort();
            terminals.delete(controller);
          }
        }
      },
    } satisfies OpenHandlers,
  };
}
