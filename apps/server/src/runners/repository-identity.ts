/*
 * One repository identity (D5, revised by D8) for Brain, task scope, the
 * agent list, PR-risk visibility and loop handoffs. Every caller passes the
 * same fields for every agent: its placement, a way to read the repository
 * root its runner reports, and its project.
 *
 * - A root on the controller's machine is its own key, byte for byte what
 *   main stores (Brain memory and task boards are found by these bytes).
 * - Any other runner's session takes its project's key: the primary root's
 *   path key when the project has a folder, else its repository. A runner's
 *   own paths are that machine's and never become keys. No origin search.
 */
import { sameRunner, type Placement } from "@dispatch/runner-protocol/contract";

import { controllerPlacement } from "./placement.js";

/** A project's stored identity (`projects.repo_root`, `projects.repository`). */
export type ProjectIdentity = {
  repoRoot: string | null;
  repository: string | null;
};

/**
 * A reported root as a key: the root itself on the controller's machine,
 * nothing on any other runner. A value, not a placement test.
 */
export function identityKey(
  placement: Placement,
  root: string | null
): string | null {
  return sameRunner(placement, controllerPlacement) ? root : null;
}

/** D8: the primary root's path key when the project has a folder, else its repository. */
export function projectKey(project: ProjectIdentity | null): string | null {
  return project?.repoRoot ?? project?.repository ?? null;
}

export type RepositorySession = {
  placement: Placement;
  /** The session's repository root as its runner reports it; read only on the controller's machine. */
  repositoryRoot: () => Promise<string | null>;
  /** The session's project, or null when it has none; read only for other runners. */
  project: () => Promise<ProjectIdentity | null>;
};

/** The session's repository key, or null when it has none. */
export async function repositoryKey(
  session: RepositorySession
): Promise<string | null> {
  if (sameRunner(session.placement, controllerPlacement))
    return session.repositoryRoot();
  return projectKey(await session.project());
}

/** Reads one project's identity, at most once per id. */
export function projectIdentities(
  read: (id: string) => Promise<ProjectIdentity | null>
) {
  const cache = new Map<string, Promise<ProjectIdentity | null>>();
  return (id: string | null | undefined): Promise<ProjectIdentity | null> => {
    if (!id) return Promise.resolve(null);
    let found = cache.get(id);
    if (!found) {
      found = read(id);
      cache.set(id, found);
    }
    return found;
  };
}

/** The project identity row, by id (`projects`). */
export const PROJECT_IDENTITY_SQL =
  'SELECT repo_root AS "repoRoot", repository FROM projects WHERE id = $1';
