import { existsSync } from "node:fs";
import path from "node:path";

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
  shell = process.env.SHELL || "/bin/bash"
): { bin: string; args: string[] } {
  const base = path.basename(shell);
  // ~/.dispatch/env is the documented place for agent-session overrides;
  // it is read after the profile so it wins.
  const posix =
    '[ -f "$HOME/.dispatch/env" ] && . "$HOME/.dispatch/env"; exec "$@"';
  if (base === "fish") {
    return {
      bin: shell,
      args: [
        "-lc",
        'test -f "$HOME/.dispatch/env"; and source "$HOME/.dispatch/env"; exec $argv',
        ...command,
      ],
    };
  }
  if (base === "bash" || base === "zsh" || base === "sh") {
    return {
      bin: shell,
      args: ["-lc", posix, "dispatch-agent-host", ...command],
    };
  }
  return {
    bin: "/bin/bash",
    args: ["-lc", posix, "dispatch-agent-host", ...command],
  };
}

/** What the host must not inherit from the server process. */
const ENV_DENY_EXACT = new Set([
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "DATABASE_URL",
  "TEST_DATABASE_URL",
  "PGPASSWORD",
  "PGUSER",
  "PGHOST",
  "PGPORT",
  "PGDATABASE",
  "DISPATCH_FILES_ROOT",
  "TLS_CERT",
  "TLS_KEY",
  "TLS_CA",
]);

/** The fake ACP adapter test seam must reach the detached host process. */
const ENV_ALLOW_DISPATCH = new Set(["DISPATCH_ACP_ADAPTER_COMMAND"]);

export function hostProcessEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (
      ENV_DENY_EXACT.has(key) ||
      (key.startsWith("DISPATCH_") &&
        !ENV_ALLOW_DISPATCH.has(key) &&
        !/^DISPATCH_OWNED_[a-f0-9]{32}$/.test(key))
    )
      continue;
    env[key] = value;
  }
  return env;
}
