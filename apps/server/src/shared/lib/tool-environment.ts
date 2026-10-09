import { readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

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
    path.join(home, ".opencode", "bin"),
    path.join(home, ".bun", "bin"),
    path.join(home, ".volta", "bin"),
    ...nvm,
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
}

/**
 * Agent engines, MCP servers, and repo commands share these runtime fallbacks.
 * Preserve the caller's PATH precedence and add the same installation locations
 * used by engine discovery for services and packaged apps with a minimal PATH.
 * Pass this environment to the child only; never mutate the server environment.
 */
export function withToolSearchPath(
  inherited: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const home = inherited.HOME || os.homedir();
  const fallback = defaultSearchDirs(home);
  const nvmRoot = path.join(home, ".nvm", "versions", "node");
  const isNvmBin = (dir: string) => path.dirname(path.dirname(dir)) === nvmRoot;
  // Without a shell-selected version, prefer the newest installed Node.
  // Sort only nvm slots: keep other install locations and engine discovery's
  // original ordering intact. The inherited PATH still wins over all fallbacks.
  const nvmBins = fallback
    .filter(isNvmBin)
    .sort((a, b) => b.localeCompare(a, "en", { numeric: true }));
  let nvmIndex = 0;
  const dirs = [
    ...(inherited.PATH ?? "").split(path.delimiter).filter(Boolean),
    ...fallback
      .map((dir) => (isNvmBin(dir) ? nvmBins[nvmIndex++]! : dir))
      .filter(path.isAbsolute),
  ];
  return {
    ...inherited,
    PATH: [...new Set(dirs)].join(path.delimiter),
  };
}

/** Repo tools also identify the agent that owns the command. */
export function repoCommandEnvironment(
  agentId: string,
  inherited: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  return { ...withToolSearchPath(inherited), DISPATCH_AGENT_ID: agentId };
}
