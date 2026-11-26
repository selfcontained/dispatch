import {
  operations,
  sessionToWire,
  RunnerCallError,
} from "@dispatch/runner-protocol/contract";
import {
  isCheckoutCommand,
  isCheckoutExecutionOptions,
  MAX_CHECKOUT_COMMAND_OUTPUT_BYTES,
} from "@dispatch/runner-protocol";
import {
  executeCheckoutCommand,
  executeStreamedCheckoutCommand,
  reportCheckoutWorkerStatus,
} from "../checkout-command-executor.js";
import { readCheckoutCommandFile } from "../checkout-inspection.js";

export async function runCheckoutCommandCli(
  cwd: string,
  session: string,
  configuredRoot: string | undefined,
  loginPath: string | undefined
) {
  let streamed = false;
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const input of process.stdin) {
      const chunk = Buffer.from(input);
      size += chunk.length;
      if (size > 32 * 1024 * 1024)
        throw new Error("Checkout command request is too large.");
      chunks.push(chunk);
    }
    const operation: unknown = JSON.parse(
      Buffer.concat(chunks).toString("utf8")
    );
    const read = (file: string) =>
      readCheckoutCommandFile(cwd, file, { configuredRoot });
    if (operations["checkout.exec"].request.check(operation)) {
      const { target, guard, argv } = operation;
      if (
        !("session" in target) ||
        sessionToWire(target.session) !== session ||
        !("digest" in guard) ||
        !isCheckoutExecutionOptions(operation)
      )
        throw new Error("Invalid checkout command binding.");
      const bound = {
        kind: "run",
        checkout:
          target.checkout === "launch" || target.checkout === "moved"
            ? target.checkout
            : "effective",
        path: guard.path,
        state: guard.digest,
        argv,
      } as const;
      if (!isCheckoutCommand(bound))
        throw new Error("Invalid checkout command.");
      streamed = true;
      const exitCode = await executeStreamedCheckoutCommand(
        cwd,
        session,
        bound,
        operation,
        loginPath,
        read
      );
      await reportCheckoutWorkerStatus({ exitCode });
      return;
    }
    if (!isCheckoutCommand(operation))
      throw new Error("Invalid checkout command.");
    if (operation.kind === "run" && operation.execution) {
      streamed = true;
      const exitCode = await executeStreamedCheckoutCommand(
        cwd,
        session,
        operation,
        operation.execution,
        loginPath,
        read
      );
      await reportCheckoutWorkerStatus({ exitCode });
      return;
    }
    process.stdout.write(
      JSON.stringify(
        await executeCheckoutCommand(cwd, session, operation, read, {
          outputLimit: MAX_CHECKOUT_COMMAND_OUTPUT_BYTES,
          loginShell: process.env.SHELL || "/bin/bash",
        })
      )
    );
  } catch (error) {
    const message = (
      error instanceof Error ? error.message : "Checkout command failed."
    ).slice(0, 1024);
    if (streamed)
      await reportCheckoutWorkerStatus({
        error: message,
        ...(error instanceof RunnerCallError &&
          error.code === "stale" && { code: "stale" }),
      });
    else process.stderr.write(message);
    process.exitCode = 1;
  }
}
