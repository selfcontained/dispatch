import { access, constants } from "node:fs/promises";
import path from "node:path";

import { runCommand } from "../shared/lib/run-command.js";
import { ACP_ENGINE_IDS, type AcpEngineId } from "./acp/engine-spec.js";

/**
 * An engine Dispatch can drive, and whether this machine has it. The ACP
 * adapters ship inside the Dispatch binary, so the only thing that can be
 * missing is the engine's own CLI, which the person installs and logs into
 * themselves. Reported so the UI can say "Claude Code isn't installed"
 * before someone launches an agent, rather than failing at spawn time.
 */
export type EngineStatus = {
  id: AcpEngineId;
  /** What people call it, for the message. */
  label: string;
  installed: boolean;
  /** Where it was found; null when it was not. */
  path: string | null;
  /**
   * What the CLI at `path` says its version is, when asked for it (see
   * withEngineVersions); null when it was not asked or would not say.
   */
  version: string | null;
  /** How to get it, when it is missing. */
  install: string;
};

const ENGINES: Record<
  AcpEngineId,
  { label: string; bin: string; install: string }
> = {
  claude: {
    label: "Claude Code",
    bin: "claude",
    install: "npm i -g @anthropic-ai/claude-code",
  },
  codex: {
    label: "Codex",
    bin: "codex",
    install: "npm i -g @openai/codex",
  },
};

/**
 * Directories to try beyond PATH: where these CLIs usually land. A service
 * started by launchd or systemd gets a minimal PATH that has none of them.
 * Passed in rather than read from the machine so a test can search a
 * directory it controls.
 */
export function defaultSearchDirs(home: string): string[] {
  return [
    path.join(home, ".local", "bin"),
    path.join(home, ".bun", "bin"),
    path.join(home, ".volta", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
}

async function executable(candidate: string): Promise<boolean> {
  try {
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * A package manager's bin directory (`…/node_modules/.bin`). A CLI there is
 * some project's build dependency — codex-acp pulls in its own
 * @openai/codex — never the engine a person installed and signed into.
 * `pnpm run`, `npm run` and `bun run` put these at the front of PATH, so a
 * server started through one (every dev stack) would otherwise drive the
 * dependency's older CLI and learn its model list instead of the real one.
 */
function isPackageBinDir(dir: string): boolean {
  const normalized = path.normalize(dir).replace(/[\\/]+$/, "");
  return (
    path.basename(normalized) === ".bin" &&
    path.basename(path.dirname(normalized)) === "node_modules"
  );
}

/**
 * Where an engine's CLI is, or null. PATH first, because a service that
 * inherited a login shell's PATH should honour it; then the usual install
 * locations, because launchd and systemd often do not. Package bin
 * directories on PATH are passed over (see isPackageBinDir); an absolute
 * path someone configured is taken as given.
 */
export async function findEngineBin(
  bin: string,
  env: NodeJS.ProcessEnv = process.env,
  searchDirs?: readonly string[]
): Promise<string | null> {
  if (bin.includes("/")) {
    return (await executable(bin)) ? bin : null;
  }
  const fallback = searchDirs ?? defaultSearchDirs(env.HOME ?? "");
  const fromPath = (env.PATH ?? "")
    .split(path.delimiter)
    .filter((dir) => dir && !isPackageBinDir(dir));
  for (const dir of [...fromPath, ...fallback]) {
    const candidate = path.join(dir, bin);
    if (await executable(candidate)) return candidate;
  }
  return null;
}

/** Every engine and whether this machine has it, for the UI and for launch. */
export async function engineStatuses(
  overrides: Partial<Record<AcpEngineId, string>> = {},
  env: NodeJS.ProcessEnv = process.env,
  searchDirs?: readonly string[]
): Promise<EngineStatus[]> {
  return Promise.all(
    ACP_ENGINE_IDS.map(async (id) => {
      const engine = ENGINES[id];
      const found = await findEngineBin(
        overrides[id] ?? engine.bin,
        env,
        searchDirs
      );
      return {
        id,
        label: engine.label,
        installed: found !== null,
        path: found,
        version: null,
        install: engine.install,
      };
    })
  );
}

/** The sentence shown when someone tries to use an engine that is not here. */
export function missingEngineMessage(status: EngineStatus): string {
  return `${status.label} is not installed on this machine. Install it with \`${status.install}\` and sign in, then try again.`;
}

/**
 * The CLI's own answer to `--version`, reduced to the version number
 * ("codex-cli 0.155.1" -> "0.155.1", "2.1.280 (Claude Code)" -> "2.1.280").
 * Which binary is half of what decides the models on offer; which release
 * it is decides the rest. Null when the CLI fails, hangs or says nothing.
 */
export async function engineVersion(bin: string): Promise<string | null> {
  try {
    const { stdout } = await runCommand(bin, ["--version"], {
      timeoutMs: 5_000,
    });
    const line = stdout.trim().split("\n")[0]?.trim() ?? "";
    if (!line) return null;
    return /\d+\.\d+(?:\.\d+)?[\w.+-]*/.exec(line)?.[0] ?? line;
  } catch {
    return null;
  }
}

/** Statuses with each installed engine's version, for the UI. Launch skips this. */
export async function withEngineVersions(
  statuses: readonly EngineStatus[],
  version: (bin: string) => Promise<string | null> = engineVersion
): Promise<EngineStatus[]> {
  return Promise.all(
    statuses.map(async (status) => ({
      ...status,
      version: status.path ? await version(status.path) : null,
    }))
  );
}
