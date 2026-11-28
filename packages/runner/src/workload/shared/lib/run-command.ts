import { spawn } from "node:child_process";
import { childProcessEnv } from "../process/child-environment.js";

type RunCommandOptions = {
  cwd?: string;
  /** Explicit overrides for the filtered inherited environment. */
  env?: NodeJS.ProcessEnv;
  allowedExitCodes?: number[];
  timeoutMs?: number;
  /** Preserve NUL-delimited filenames and other whitespace-sensitive output. */
  trimOutput?: boolean;
};

export type RunCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

const stderrTailLength = 8 * 1024;

/** Bun's native process handle avoids its node:child_process bridge. */
async function runBunCommand(
  command: string,
  args: string[],
  options: RunCommandOptions
): Promise<RunCommandResult> {
  const child = Bun.spawn([command, ...args], {
    cwd: options.cwd,
    env: { ...childProcessEnv(), ...options.env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let stdout = "";
  let stderr = "";
  const read = async (
    stream: ReadableStream<Uint8Array>,
    append: (text: string) => void
  ) => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        append(decoder.decode(chunk.value, { stream: true }));
      }
      append(decoder.decode());
    } finally {
      reader.releaseLock();
    }
  };
  // Start both drains before waiting for exit: either socket can fill while
  // the other is quiet. Keep draining even after a timeout until the child dies.
  const completed = Promise.all([
    child.exited,
    read(child.stdout, (text) => (stdout += text)),
    read(child.stderr, (text) => (stderr += text)),
  ]);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let hardKill: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    if (typeof options.timeoutMs !== "number" || options.timeoutMs <= 0) return;
    timeout = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {}
      hardKill = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {}
      }, 5_000);
      hardKill.unref();
      reject(
        Object.assign(
          new Error(
            `Command timed out (${command} ${args.join(" ")}), timeoutMs=${options.timeoutMs}`
          ),
          {
            timedOut: true,
            timeoutMs: options.timeoutMs,
            stderrTail: stderr.trim().slice(-stderrTailLength),
          }
        )
      );
    }, options.timeoutMs);
  });
  void child.exited.then(() => {
    if (hardKill) clearTimeout(hardKill);
  });
  try {
    const [exitCode] = await Promise.race([completed, timedOut]);
    if (!(options.allowedExitCodes ?? [0]).includes(exitCode)) {
      throw Object.assign(
        new Error(
          `Command failed (${command} ${args.join(" ")}), exitCode=${exitCode}, stderr=${stderr.trim()}`
        ),
        {
          timedOut: false,
          exitCode,
          signal: child.signalCode,
          stderrTail: stderr.trim().slice(-stderrTailLength),
        }
      );
    }
    return {
      exitCode,
      stdout: options.trimOutput === false ? stdout : stdout.trim(),
      stderr: stderr.trim(),
    };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/** Injectable runner shape used by git/gh helpers so tests can fake commands. */
export type CommandRunner = (
  command: string,
  args: string[],
  options?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    allowedExitCodes?: number[];
    timeoutMs?: number;
    trimOutput?: boolean;
  }
) => Promise<RunCommandResult>;

export async function runCommand(
  command: string,
  args: string[],
  options: RunCommandOptions = {}
): Promise<RunCommandResult> {
  if (typeof Bun !== "undefined")
    return await runBunCommand(command, args, options);
  return await new Promise<RunCommandResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...childProcessEnv(), ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let settled = false;
    let stdout = "";
    let stderr = "";
    let timeout: NodeJS.Timeout | null = null;
    // SIGTERM is a request, not a guarantee — a child that's mid-syscall (a
    // hung `git fetch`, for instance) can simply not act on it. Escalate to
    // SIGKILL if it hasn't exited shortly after. This only reaches the
    // direct child (no process-group kill) — a grandchild process the child
    // itself spawned can still outlive us, which a `detached: true` +
    // group-kill would close, but that changes kill semantics for every
    // caller of this shared utility, not just the timeout path, so it's left
    // out here deliberately.
    let hardKill: NodeJS.Timeout | null = null;

    const stopListening = (): void => {
      child.stdout.removeAllListeners("data");
      child.stderr.removeAllListeners("data");
    };

    const fail = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      stopListening();
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      reject(
        Object.assign(error, {
          stderrTail: stderr.trim().slice(-stderrTailLength),
        })
      );
    };

    const succeed = (result: RunCommandResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      stopListening();
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      if (hardKill) {
        clearTimeout(hardKill);
        hardKill = null;
      }
      resolve(result);
    };

    if (typeof options.timeoutMs === "number" && options.timeoutMs > 0) {
      timeout = setTimeout(() => {
        try {
          child.kill("SIGTERM");
        } catch {}
        hardKill = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {}
        }, 5_000);
        hardKill.unref();
        fail(
          Object.assign(
            new Error(
              `Command timed out (${command} ${args.join(" ")}), timeoutMs=${options.timeoutMs}`
            ),
            { timedOut: true, timeoutMs: options.timeoutMs }
          )
        );
      }, options.timeoutMs);
    }

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", (error) => {
      fail(error);
    });

    child.on("close", (code, signal) => {
      const exitCode = code ?? 1;
      const allowedExitCodes = options.allowedExitCodes ?? [0];

      if (!allowedExitCodes.includes(exitCode)) {
        fail(
          Object.assign(
            new Error(
              `Command failed (${command} ${args.join(" ")}), exitCode=${exitCode}, stderr=${stderr.trim()}`
            ),
            { timedOut: false, exitCode, signal }
          )
        );
        return;
      }

      succeed({
        exitCode,
        stdout: options.trimOutput === false ? stdout : stdout.trim(),
        stderr: stderr.trim(),
      });
    });
  });
}
