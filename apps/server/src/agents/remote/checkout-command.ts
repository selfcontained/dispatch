import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:os";
import {
  isCheckoutCommand,
  MAX_CHECKOUT_COMMAND_OUTPUT_BYTES,
  type CheckoutCommand,
  type CheckoutCommandFile,
  type CheckoutCommandResult,
} from "@dispatch/runner-protocol";
import type { Readable } from "node:stream";
import { repoCommandEnvironment } from "../../shared/lib/tool-environment.js";
import { readCheckoutCommandFile } from "../checkout-inspection.js";

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
  configuredRoot?: string
): Promise<CheckoutCommandFile | CheckoutCommandResult | null> {
  const { root, content } = await readCheckoutCommandFile(
    cwd,
    operation.path,
    configuredRoot
  );
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
  const child = spawn(command!, args, {
    cwd: root,
    env: repoCommandEnvironment(session),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = capture(child.stdout);
  const stderr = capture(child.stderr);
  return new Promise((resolve, reject) => {
    child.once("error", () =>
      reject(new Error("Could not start checkout command."))
    );
    child.once("close", (code, signal) => {
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

export async function runCheckoutCommandCli(
  cwd: string,
  session: string,
  configuredRoot?: string
) {
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const input of process.stdin) {
      const chunk = Buffer.from(input);
      size += chunk.length;
      if (size > 96 * 1024)
        throw new Error("Checkout command request is too large.");
      chunks.push(chunk);
    }
    const operation: unknown = JSON.parse(
      Buffer.concat(chunks).toString("utf8")
    );
    if (!isCheckoutCommand(operation))
      throw new Error("Invalid checkout command.");
    process.stdout.write(
      JSON.stringify(
        await executeCheckoutCommand(cwd, session, operation, configuredRoot)
      )
    );
  } catch (error) {
    process.stderr.write(
      (error instanceof Error
        ? error.message
        : "Checkout command failed."
      ).slice(0, 1024)
    );
    process.exitCode = 1;
  }
}
