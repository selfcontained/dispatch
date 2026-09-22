import { readdirSync } from "node:fs";
import { access, constants, stat } from "node:fs/promises";
import path from "node:path";

import { runCommand } from "../shared/lib/run-command.js";
import { ACP_ENGINE_IDS, type AcpEngineId } from "./acp/engine-spec.js";
import { isPackageBinDir } from "./acp/package-bin-dir.js";

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
 * Every nvm-installed Node's bin is one, since `npm i -g` under nvm lands
 * there. Passed in rather than read from the machine so a test can search a
 * directory it controls.
 */
export function defaultSearchDirs(home: string): string[] {
  let nvm: string[] = [];
  try {
    const root = path.join(home, ".nvm", "versions", "node");
    nvm = readdirSync(root).map((version) => path.join(root, version, "bin"));
  } catch {
    // No nvm here.
  }
  return [
    path.join(home, ".local", "bin"),
    path.join(home, ".bun", "bin"),
    path.join(home, ".volta", "bin"),
    ...nvm,
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

/** Numeric order of two version strings ("0.155.1" > "0.154.0"); unknown sorts lowest. */
function compareVersions(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  const pa = a.split(/\D+/).filter(Boolean).map(Number);
  const pb = b.split(/\D+/).filter(Boolean).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Where an engine's CLI is, or null; always an absolute path.
 *
 * - An absolute path someone configured is taken as given.
 * - PATH comes first, in its own order: a service that inherited a login
 *   shell's PATH should run what that shell runs. Package bin directories
 *   (see isPackageBinDir) and relative entries are passed over.
 * - Failing that, the usual install locations. These have no order that
 *   means anything — Homebrew, a version manager and an npm prefix are all
 *   equally "installed" — so when several have the CLI, the newest release
 *   wins (its --version), and the list order only breaks ties. Newest is the
 *   one whose models a person would expect to see.
 */
export async function findEngineBin(
  bin: string,
  env: NodeJS.ProcessEnv = process.env,
  searchDirs?: readonly string[],
  version: (bin: string) => Promise<string | null> = engineVersion
): Promise<string | null> {
  if (bin.includes("/")) {
    return path.isAbsolute(bin) && (await executable(bin)) ? bin : null;
  }
  const fromPath = (env.PATH ?? "")
    .split(path.delimiter)
    .filter((dir) => path.isAbsolute(dir) && !isPackageBinDir(dir));
  for (const dir of fromPath) {
    const candidate = path.join(dir, bin);
    if (await executable(candidate)) return candidate;
  }
  const fallback = searchDirs ?? defaultSearchDirs(env.HOME ?? "");
  const found: string[] = [];
  for (const dir of fallback) {
    const candidate = path.join(dir, bin);
    if (path.isAbsolute(candidate) && (await executable(candidate))) {
      found.push(candidate);
    }
  }
  if (found.length <= 1) return found[0] ?? null;
  const versions = await Promise.all(
    found.map((candidate) => version(candidate))
  );
  let best = 0;
  for (let i = 1; i < found.length; i += 1) {
    if (compareVersions(versions[i]!, versions[best]!) > 0) best = i;
  }
  return found[best]!;
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
const versionCache = new Map<
  string,
  { mtimeMs: number; version: string | null }
>();

export async function engineVersion(bin: string): Promise<string | null> {
  // Asked on every launch and every engines check; the answer only changes
  // when the file does.
  let mtimeMs: number;
  try {
    mtimeMs = (await stat(bin)).mtimeMs;
  } catch {
    return null;
  }
  const cached = versionCache.get(bin);
  if (cached && cached.mtimeMs === mtimeMs) return cached.version;
  const version = await readVersion(bin);
  versionCache.set(bin, { mtimeMs, version });
  return version;
}

async function readVersion(bin: string): Promise<string | null> {
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
