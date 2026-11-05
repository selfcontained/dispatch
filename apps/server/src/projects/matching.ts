import { realpath } from "node:fs/promises";
import { relative, isAbsolute } from "node:path";
import { resolveTilde } from "../shared/lib/resolve-tilde.js";
import { resolveProjectRoot } from "./resolve-root.js";

type Project = { id: string; name: string; repoRoot: string };

/** Match canonical checkouts (including linked worktrees) or contained folders. */
export async function matchingProjects(
  cwd: string,
  projects: Project[]
): Promise<Project[]> {
  if (!projects.length) return [];
  const directory = await realpath(resolveTilde(cwd));
  const root = await resolveProjectRoot(directory);
  const matches = await Promise.all(
    projects.map(async (project) => {
      // A stale/offline project must not prevent an unrelated launch.
      const projectRoot = await realpath(project.repoRoot).catch(() => null);
      if (!projectRoot) return null;
      const suffix = relative(projectRoot, directory);
      return projectRoot === root ||
        suffix === "" ||
        (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith("../"))
        ? project
        : null;
    })
  );
  return matches.filter((project): project is Project => project !== null);
}
