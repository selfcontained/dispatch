import path from "node:path";
import { realpath } from "node:fs/promises";

const PROTECTED_HOME_RELATIVE_DIRS = [
  "Desktop",
  "Documents",
  "Downloads",
  "Movies",
  "Music",
  "Pictures",
  path.join("Library", "CloudStorage"),
  path.join("Library", "Mobile Documents"),
] as const;

function normalizeForComparison(
  value: string,
  platform: NodeJS.Platform
): string {
  const resolved = path.resolve(value);
  return platform === "darwin" ? resolved.toLocaleLowerCase("en-US") : resolved;
}

async function canonicalizePath(
  candidatePath: string,
  platform: NodeJS.Platform
): Promise<string> {
  const resolved = path.resolve(candidatePath);
  const canonical = await realpath(resolved).catch(() => resolved);
  return normalizeForComparison(canonical, platform);
}

function isSameOrChildPath(candidate: string, parent: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}${path.sep}`);
}

export async function isMacProtectedPath(
  candidatePath: string,
  homeDir: string,
  platform: NodeJS.Platform = process.platform
): Promise<boolean> {
  const [canonicalCandidate, protectedRoots] = await Promise.all([
    canonicalizePath(candidatePath, platform),
    Promise.all(
      PROTECTED_HOME_RELATIVE_DIRS.map(async (segment) =>
        canonicalizePath(path.join(homeDir, segment), platform)
      )
    ),
  ]);

  return protectedRoots.some((protectedRoot) =>
    isSameOrChildPath(canonicalCandidate, protectedRoot)
  );
}

export async function shouldSkipAutomaticMacPathProbe(
  candidatePath: string,
  homeDir: string,
  platform: NodeJS.Platform = process.platform
): Promise<boolean> {
  return (
    platform === "darwin" &&
    (await isMacProtectedPath(candidatePath, homeDir, platform))
  );
}
