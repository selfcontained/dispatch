import { loginShellCommand } from "./acp/host-command.js";
import { RunnerCallError } from "@dispatch/runner-protocol/contract";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  type CheckoutCommand,
  type CheckoutCommandFile,
  type CheckoutCommandResult,
  type CheckoutExecution,
} from "@dispatch/runner-protocol";
import { Writable, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { repoCommandEnvironment } from "../shared/lib/tool-environment.js";

/** A child's output, trimmed, and cut at `limit` bytes when one is given. */
export function capture(stream: Readable, limit: number | null) {
  const max = limit ?? Infinity;
  const chunks: Buffer[] = [];
  let used = 0;
  let truncated = false;
  stream.on("data", (chunk: Buffer) => {
    const kept = chunk.subarray(0, max - used);
    if (kept.length < chunk.length) truncated = true;
    used += kept.length;
    chunks.push(kept);
  });
  return () => {
    const text = Buffer.concat(chunks).toString("utf8").trim();
    const encoded = Buffer.from(text);
    if (encoded.length <= max) return { text, truncated };
    return {
      text: new TextDecoder().decode(encoded.subarray(0, max), {
        stream: true,
      }),
      truncated: true,
    };
  };
}

/**
 * The workload's base environment for a command: main's repo command
 * environment without its agent identity, which the caller adds.
 */
export function commandBaseEnvironment(): NodeJS.ProcessEnv {
  const { DISPATCH_AGENT_ID: _agent, ...base } = repoCommandEnvironment("");
  return base;
}

/** The v1 runner's command executor (`runner-checkout-command`). */
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
  const { root, content, state } = await checkoutCommandGuard(
    cwd,
    session,
    operation,
    read
  );
  if (operation.kind === "read")
    return content === null ? null : { content, state };

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
  const stdout = capture(child.stdout, outputLimit ?? null);
  const stderr = capture(child.stderr, outputLimit ?? null);
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

export async function checkoutCommandGuard(
  cwd: string,
  session: string,
  operation: CheckoutCommand,
  read: (path: string) => Promise<{ root: string; content: string | null }>
) {
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
  if (
    operation.kind === "run" &&
    (content === null || operation.state !== state)
  )
    throw new RunnerCallError({
      code: "stale",
      message:
        "Checkout command authorization is stale. Read the checkout file again.",
    });
  return { root, content, state };
}

export async function executeStreamedCheckoutCommand(
  cwd: string,
  session: string,
  operation: Extract<CheckoutCommand, { kind: "run" }>,
  execution: CheckoutExecution,
  loginPath: string | undefined,
  read: Parameters<typeof checkoutCommandGuard>[3]
) {
  const { root } = await checkoutCommandGuard(cwd, session, operation, read);
  const inherited = loginPath
    ? { ...process.env, PATH: loginPath }
    : process.env;
  const env = {
    ...repoCommandEnvironment(session, inherited),
    ...execution.env,
  };
  const [command, ...args] = operation.argv;
  const launch =
    execution.shell === "login"
      ? loginShellCommand(
          operation.argv,
          process.env.SHELL || "/bin/bash",
          env.PATH
        )
      : { bin: command!, args };
  const child = spawn(launch.bin, launch.args, {
    cwd: root,
    env,
    // Inherited Bun descriptors can be nonblocking. Give the program its own
    // blocking pipe ends and forward bytes from the worker with backpressure.
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
  const forward = (input: Readable, output: Writable) =>
    pipeline(
      input,
      new Writable({
        write(chunk: Buffer, _encoding, done) {
          output.write(chunk, done);
        },
      })
    );
  const [code] = await Promise.all([
    exited,
    forward(child.stdout, process.stdout),
    forward(child.stderr, process.stderr),
  ]);
  return code;
}
