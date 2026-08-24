import { spawn } from "node:child_process";

type RunCommandOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  allowedExitCodes?: number[];
  timeoutMs?: number;
};

export type RunCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

/** Injectable runner shape used by git/gh helpers so tests can fake commands. */
export type CommandRunner = (
  command: string,
  args: string[],
  options?: { cwd?: string; allowedExitCodes?: number[]; timeoutMs?: number }
) => Promise<RunCommandResult>;

export async function runCommand(
  command: string,
  args: string[],
  options: RunCommandOptions = {}
): Promise<RunCommandResult> {
  return await new Promise<RunCommandResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
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
      reject(error);
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
          new Error(
            `Command timed out (${command} ${args.join(" ")}), timeoutMs=${options.timeoutMs}`
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

    child.on("close", (code) => {
      const exitCode = code ?? 1;
      const allowedExitCodes = options.allowedExitCodes ?? [0];

      if (!allowedExitCodes.includes(exitCode)) {
        fail(
          new Error(
            `Command failed (${command} ${args.join(" ")}), exitCode=${exitCode}, stderr=${stderr.trim()}`
          )
        );
        return;
      }

      succeed({
        exitCode,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });
  });
}
