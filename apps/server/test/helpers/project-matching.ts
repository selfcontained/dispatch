// Compatibility wiring for the former local test convenience wrapper.
import { realpath } from "node:fs/promises";
import { resolveTilde } from "../../src/shared/lib/resolve-tilde.js";
import { resolveProjectRoot } from "../../../../packages/runner/src/workload/projects/resolve-root.js";
import { matchProjectIdentity } from "../../src/projects/matching.js";

type Project = {
  id: string;
  name: string;
  repoRoot: string | null;
  extraRoots?: string[];
};

/** Match canonical checkouts (including linked worktrees) or contained folders. */
export async function matchingProjects(
  cwd: string,
  projects: Project[]
): Promise<Project[]> {
  if (!projects.length) return [];
  const directory = await realpath(resolveTilde(cwd));
  const root = await resolveProjectRoot(directory);
  return matchProjectIdentity(directory, root, projects, (root) =>
    realpath(root).catch(() => null)
  );
}
