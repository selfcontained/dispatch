import { access, constants } from "node:fs/promises";
import path from "node:path";

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
 * Where an engine's CLI is, or null. PATH first, because a service that
 * inherited a login shell's PATH should honour it; then the usual install
 * locations, because launchd and systemd often do not.
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
  const fromPath = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
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
        install: engine.install,
      };
    })
  );
}

/** The sentence shown when someone tries to use an engine that is not here. */
export function missingEngineMessage(status: EngineStatus): string {
  return `${status.label} is not installed on this machine. Install it with \`${status.install}\` and sign in, then try again.`;
}
