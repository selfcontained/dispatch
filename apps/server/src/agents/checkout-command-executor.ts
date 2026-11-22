import { loginShellCommand } from "./acp/host-command.js";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  type CheckoutCommand,
  type CheckoutCommandFile,
  type CheckoutCommandResult,
} from "@dispatch/runner-protocol";
import type { Readable } from "node:stream";
import { repoCommandEnvironment } from "../shared/lib/tool-environment.js";

function capture(stream: Readable, limit = Infinity) {
  const chunks: Buffer[] = [];
  let used = 0;
  let truncated = false;
  stream.on("data", (chunk: Buffer) => {
    const kept = chunk.subarray(0, limit - used);
    if (kept.length < chunk.length) truncated = true;
    used += kept.length;
    chunks.push(kept);
  });
  return () => {
    const text = Buffer.concat(chunks).toString("utf8").trim();
    const encoded = Buffer.from(text);
    if (encoded.length <= limit) return { text, truncated };
    return {
      text: new TextDecoder().decode(encoded.subarray(0, limit), {
        stream: true,
      }),
      truncated: true,
    };
  };
}

export async function executeCheckoutCommand(
  cwd: string,
  session: string,
  operation: CheckoutCommand,
  read: (path: string) => Promise<{ root: string; content: string | null }>,
  {
    timeoutMs,
    outputLimit,
    loginShell,
  }: { timeoutMs?: number; outputLimit?: number; loginShell?: string } = {}
): Promise<CheckoutCommandFile | CheckoutCommandResult | null> {
  const { root, content } = await read(operation.path);
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
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = capture(child.stdout, outputLimit);
  const stderr = capture(child.stderr, outputLimit);
  return new Promise((resolve, reject) => {
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            // Only the direct child, like runCommand: what it started keeps running.
            child.kill("SIGTERM");
            setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
            reject(new Error("Checkout command timed out."));
          }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      const output = stdout();
      const errors = stderr();
      resolve({
        exitCode: code ?? 1,
        stdout: output.text,
        stderr: errors.text,
        ...(outputLimit !== undefined && {
          truncated: output.truncated || errors.truncated,
        }),
      });
    });
  });
}
