import { spawn } from "node:child_process";

type RunCommandOptions = {
  cwd?: string;
  allowedExitCodes?: number[];
  timeoutMs?: number;
};

export type RunCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export async function runCommand(
  command: string,
  args: string[],
  options: RunCommandOptions = {}
): Promise<RunCommandResult> {
  return await new Promise<RunCommandResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let settled = false;
    let stdout = "";
    let stderr = "";
    let timeout: NodeJS.Timeout | null = null;

    const fail = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
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
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      resolve(result);
    };

    if (typeof options.timeoutMs === "number" && options.timeoutMs > 0) {
      timeout = setTimeout(() => {
        try {
          child.kill("SIGTERM");
        } catch {}
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
        stderr: stderr.trim()
      });
    });
  });
}
