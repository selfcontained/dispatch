import { loginShellCommand } from "./acp/host-command.js";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:os";
import {
  MAX_CHECKOUT_COMMAND_OUTPUT_BYTES,
  type CheckoutCommand,
  type CheckoutCommandFile,
  type CheckoutCommandResult,
} from "@dispatch/runner-protocol";
import type { Readable } from "node:stream";
import { repoCommandEnvironment } from "../shared/lib/tool-environment.js";

function capture(stream: Readable) {
  const limit = MAX_CHECKOUT_COMMAND_OUTPUT_BYTES;
  const buffer = Buffer.alloc(limit);
  let used = 0;
  let truncated = false;
  stream.on("data", (chunk: Buffer) => {
    const size = chunk.copy(buffer, used);
    used += size;
    if (size < chunk.length) truncated = true;
  });
  return () => {
    const decoded = buffer.toString("utf8", 0, used).trim();
    const encoded = Buffer.from(decoded);
    return {
      text: new TextDecoder().decode(encoded.subarray(0, limit), {
        stream: true,
      }),
      truncated: truncated || encoded.length > limit,
    };
  };
}

export async function executeCheckoutCommand(
  cwd: string,
  session: string,
  operation: CheckoutCommand,
  read: (path: string) => Promise<{ root: string; content: string | null }>,
  cancellation?: AbortSignal,
  loginShell?: string
): Promise<CheckoutCommandFile | CheckoutCommandResult | null> {
  cancellation?.throwIfAborted();
  const { root, content } = await read(operation.path);
  cancellation?.throwIfAborted();
  const state = createHash("sha256")
    .update(
      JSON.stringify([
        session,
        operation.checkout,
        cwd,
        root,
        operation.path,
        content,
      ])
    )
    .digest("hex");
  if (operation.kind === "read")
    return content === null ? null : { content, state };
  if (content === null || operation.state !== state)
    throw new Error(
      "Checkout command authorization is stale. Read the checkout file again."
    );

  const [command, ...args] = operation.argv;
  const env = repoCommandEnvironment(session);
  const launch = loginShell
    ? loginShellCommand(operation.argv, loginShell, env.PATH)
    : { bin: command!, args };
  const child = spawn(launch.bin, launch.args, {
    cwd: root,
    detached: cancellation !== undefined,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = capture(child.stdout);
  const stderr = capture(child.stderr);
  return new Promise((resolve, reject) => {
    const cancel = () => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // The process group may already have exited.
      }
    };
    cancellation?.addEventListener("abort", cancel, { once: true });
    child.once("error", () =>
      reject(new Error("Could not start checkout command."))
    );
    child.once("close", (code, signal) => {
      cancellation?.removeEventListener("abort", cancel);
      if (cancellation?.aborted) {
        reject(cancellation.reason);
        return;
      }
      const output = stdout();
      const errors = stderr();
      resolve({
        exitCode: code ?? (signal ? 128 + constants.signals[signal] : 1),
        stdout: output.text,
        stderr: errors.text,
        truncated: output.truncated || errors.truncated,
      });
    });
  });
}
