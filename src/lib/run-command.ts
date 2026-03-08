import { spawn } from "node:child_process";

type RunCommandOptions = {
  cwd?: string;
  allowedExitCodes?: number[];
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

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      const exitCode = code ?? 1;
      const allowedExitCodes = options.allowedExitCodes ?? [0];

      if (!allowedExitCodes.includes(exitCode)) {
        reject(
          new Error(
            `Command failed (${command} ${args.join(" ")}), exitCode=${exitCode}, stderr=${stderr.trim()}`
          )
        );
        return;
      }

      resolve({
        exitCode,
        stdout: stdout.trim(),
        stderr: stderr.trim()
      });
    });
  });
}
