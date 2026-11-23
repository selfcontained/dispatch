import { loginShellCommand } from "../agents/acp/host-command.js";
import { withToolSearchPath } from "../shared/lib/tool-environment.js";
import { userInfo } from "node:os";
import { captureTerminalSession } from "./process-session.js";

/** Start from a small allowlist: never inherit Dispatch/agent tokens or hooks. */
export function terminalEnvironment(
  source = process.env
): Record<string, string> {
  const env: Record<string, string> = {
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
  };
  for (const key of [
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "PATH",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    "TMPDIR",
  ]) {
    if (source[key]) env[key] = source[key]!;
  }
  return env;
}

export type PtyProcess = {
  pid: number;
  terminal: {
    write(data: string): number;
    resize(cols: number, rows: number): void;
    close(): void;
  };
  exited: Promise<number>;
  kill(): void;
};
export function spawnTerminal(
  cwd: string,
  output: (data: Uint8Array) => void,
  workloadShell?: string,
  { cols, rows } = { cols: 80, rows: 24 }
): PtyProcess {
  if (
    typeof Bun === "undefined" ||
    typeof Bun.Terminal !== "function" ||
    process.platform === "win32"
  ) {
    throw new Error(
      "Human terminals require Bun 1.3.13 or newer on macOS or Linux."
    );
  }
  if (process.getuid?.() === 0)
    throw new Error(
      "Human terminals require Dispatch to run as an ordinary OS user."
    );
  const shell = workloadShell ?? (userInfo().shell || "/bin/sh");
  const env = terminalEnvironment();
  const login = workloadShell
    ? loginShellCommand(
        [workloadShell, "-i"],
        workloadShell,
        withToolSearchPath(env).PATH
      )
    : { bin: shell, args: ["-l"] };
  const proc = Bun.spawn([login.bin, ...login.args], {
    cwd,
    env,
    terminal: { cols, rows, data: (_terminal, data) => output(data) },
  });
  let cleanup: () => void;
  try {
    cleanup = captureTerminalSession(proc.pid);
  } catch (error) {
    proc.terminal?.close();
    proc.kill("SIGKILL");
    throw error;
  }
  return {
    pid: proc.pid,
    terminal: proc.terminal!,
    exited: proc.exited,
    kill() {
      try {
        cleanup();
      } finally {
        proc.terminal?.close();
      }
    },
  };
}
