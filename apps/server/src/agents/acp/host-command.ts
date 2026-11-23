import { existsSync } from "node:fs";
import path from "node:path";
import { childProcessEnv } from "../../shared/process/child-environment.js";
import {
  killOwnedProcesses,
  ownedEnvironment,
} from "../../shared/process/owned-processes.js";

/**
 * The command that runs the host: the same executable as the server. Under
 * `bun src/main.ts` that is bun plus the script; a compiled binary is
 * itself. `DISPATCH_AGENT_HOST_COMMAND` (JSON array or whitespace-separated)
 * overrides both, for tests and e2e.
 */
export function hostCommand(env: NodeJS.ProcessEnv = process.env): string[] {
  const override = env.DISPATCH_AGENT_HOST_COMMAND;
  if (override) {
    try {
      const parsed = JSON.parse(override);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      // Not JSON: a plain command line.
    }
    return override.split(/\s+/).filter(Boolean);
  }
  return selfCommand("agent-host");
}

/**
 * This executable plus one of its modes. Under `bun src/main.ts` that is bun
 * plus the script; a compiled binary is itself. Both the agent host and the
 * bundled ACP adapters are modes of this binary, so both are spawned this way.
 */
export function selfCommand(mode: string): string[] {
  const script = process.argv[1];
  if (script && /\.[cm]?[jt]s$/.test(script) && existsSync(script)) {
    return [process.execPath, script, mode];
  }
  return [process.execPath, mode];
}

/**
 * Wrap a command so it runs through the user's login shell: the host, and
 * so the engine, gets the PATH, ssh agent and tool config the user's own
 * shell has.
 */
export function loginShellCommand(
  command: string[],
  shell = process.env.SHELL || "/bin/bash",
  fallbackPath?: string
): { bin: string; args: string[] } {
  const base = path.basename(shell);
  // ~/.dispatch/env is the documented place for agent-session overrides;
  // it is read after the profile so it wins.
  const posixProfile =
    '[ -f "$HOME/.dispatch/env" ] && . "$HOME/.dispatch/env"; ';
  const fishProfile =
    'test -f "$HOME/.dispatch/env"; and source "$HOME/.dispatch/env"; ';
  const extraArgs = fallbackPath ? [fallbackPath] : [];
  if (base === "fish") {
    const appendPath = fallbackPath
      ? 'set -gx PATH $PATH (string split : -- "$argv[1]"); set -e argv[1]; '
      : "";
    return {
      bin: shell,
      args: [
        "-lc",
        fishProfile + appendPath + "exec $argv",
        ...extraArgs,
        ...command,
      ],
    };
  }
  const appendPath = fallbackPath
    ? 'export PATH="${PATH:+$PATH:}$1"; shift; '
    : "";
  return {
    bin: ["bash", "zsh", "sh"].includes(base) ? shell : "/bin/bash",
    args: [
      "-lc",
      posixProfile + appendPath + 'exec "$@"',
      "dispatch-agent-host",
      ...extraArgs,
      ...command,
    ],
  };
}

/**
 * The agent host as the local runner child starts and identifies it (its
 * `posix-user` host entry): this binary's `agent-host` mode through the
 * user's login shell, with an ownership marker whose processes are cleaned
 * up after the host.
 */
export function localHostEntry() {
  return {
    command: () => hostCommand(),
    wrap: (command: string[]) => loginShellCommand(command),
    env: () => childProcessEnv(),
    ownership: {
      create: (env: NodeJS.ProcessEnv) => ownedEnvironment(env),
      cleanup: (marker: string) => killOwnedProcesses(marker),
    },
  };
}
