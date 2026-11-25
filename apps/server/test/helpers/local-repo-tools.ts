// Test-only compatibility adapter for the pre-seal local loaders. Production
// discovers manifests and executes commands through the Runner interface.
import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import { repoCommandEnvironment } from "../../src/shared/lib/tool-environment.js";
import { runCommand } from "../../src/shared/lib/run-command.js";
import {
  parseRepoTools,
  parseRepoToolFile,
  parseRepoHooks,
  REPO_TOOL_MANIFEST_PATH,
  type RepoHooks,
  type RepoToolDefinition,
} from "../../src/shared/mcp/repo-tools.js";
const hooksCache = new Map<string, { mtime: number; hooks: RepoHooks }>();
export async function loadRepoTools(
  repoRoot: string
): Promise<RepoToolDefinition[]> {
  const config = await readRepoToolFile(
    path.join(repoRoot, REPO_TOOL_MANIFEST_PATH)
  );
  return parseRepoTools(config, runLocalRepoCommand);
}

function runLocalRepoCommand(
  [command, ...args]: string[],
  cwd: string,
  agentId: string
) {
  return runCommand(command, args, {
    cwd,
    env: repoCommandEnvironment(agentId),
    // Return output and exit status even on failure.
    allowedExitCodes: Array.from({ length: 256 }, (_, i) => i),
  });
}

async function readRepoToolFile(
  filePath: string
): Promise<ReturnType<typeof parseRepoToolFile>> {
  try {
    return parseRepoToolFile(await readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

export async function loadRepoHooks(repoRoot: string): Promise<RepoHooks> {
  const manifestPath = path.join(repoRoot, REPO_TOOL_MANIFEST_PATH);

  // Check mtime for cache invalidation.
  let mtime: number;
  try {
    mtime = (await stat(manifestPath)).mtimeMs;
  } catch {
    return {};
  }

  const cached = hooksCache.get(manifestPath);
  if (cached && cached.mtime === mtime) {
    return cached.hooks;
  }

  const config = await readRepoToolFile(manifestPath);
  const hooks = parseRepoHooks(config);
  hooksCache.set(manifestPath, { mtime, hooks });
  return hooks;
}
