import { relative, isAbsolute } from "node:path";

type Project = {
  id: string;
  name: string;
  repoRoot: string | null;
  extraRoots?: string[];
};

export async function matchProjectIdentity(
  directory: string,
  root: string,
  projects: Project[],
  canonicalPath: (path: string) => Promise<string | null>
): Promise<Project[]> {
  const matches = await Promise.all(
    projects.map(async (project) => {
      // A stale/offline project must not prevent an unrelated launch.
      for (const candidate of [
        project.repoRoot,
        ...(project.extraRoots ?? []),
      ]) {
        if (!candidate) continue;
        const projectRoot = await canonicalPath(candidate);
        if (!projectRoot) continue;
        const suffix = relative(projectRoot, directory);
        if (
          projectRoot === root ||
          suffix === "" ||
          (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith("../"))
        )
          return project;
      }
      return null;
    })
  );
  return matches.filter((project): project is Project => project !== null);
}
