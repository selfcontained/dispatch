/*
 * One repository identity (D5, revised by D8) for Brain, task scope, the
 * agent list, PR-risk visibility and loop handoffs. Every caller passes the
 * same fields for every agent: its placement, a way to read the repository
 * root its runner reports, and its project.
 *
 * - A root on the controller's machine is its own key, byte for byte what
 *   main stores (Brain memory and task boards are found by these bytes).
 * - Any other runner's session takes its project's key: the primary root's
 *   path key when the project has a folder, else its repository. With no
 *   project, it takes its recorded repository, normalized as a project's
 *   repository is. A runner's own paths are that machine's and never become
 *   keys. No origin search, and no project lookup by repository.
 */
import { sameRunner, type Placement } from "@dispatch/runner-protocol/contract";

import { projectRepositoryUrl } from "../agents/remote/repository.js";
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
  /**
   * The repository the session's checkout was made from
   * (`agents.runner_repository.url`, its checkout owner's for a borrowed
   * one); read only for another runner's session with no project.
   */
  repository?: () => Promise<string | null>;
};

/** The key of a recorded repository: the bytes a project for it stores. */
export function sessionRepositoryKey(url: string | null): string | null {
  if (!url) return null;
  try {
    return projectRepositoryUrl(url);
  } catch {
    return null;
  }
}

/** The session's repository key, or null when it has none. */
export async function repositoryKey(
  session: RepositorySession
): Promise<string | null> {
  if (sameRunner(session.placement, controllerPlacement))
    return session.repositoryRoot();
  const project = await session.project();
  if (project) return projectKey(project);
  // Owner decision (T34, option A): no recorded repository, no key, as a
  // local folder outside Git has none.
  return sessionRepositoryKey((await session.repository?.()) ?? null);
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

/** A session's recorded repository URL, by agent id (its checkout owner's when borrowed). */
export const SESSION_REPOSITORY_SQL =
  "SELECT owner.runner_repository->>'url' AS url FROM agents a JOIN agents owner ON owner.id = COALESCE(a.runner_worktree_owner, a.id) WHERE a.id = $1";

/**
 * Persist the session's canonical repository identity alongside its clone URL.
 * Clone URLs retain their semantics; identity never parses URLs in SQL. Local
 * records retain main's exact bytes. Current runners write this at creation;
 * earlier development rows are deliberately not backfilled.
 */
export function repositoryRecord<T extends { url: string }>(
  placement: Placement,
  repository: T | null
): T | (T & { identityKey: string | null }) | null {
  if (!repository || sameRunner(placement, controllerPlacement))
    return repository;
  return { ...repository, identityKey: sessionRepositoryKey(repository.url) };
}

/**
 * SQL twin of the launch-folder identity rule, for an agents row aliased `a`.
 * The local arm is main's expression verbatim. Project identities are already
 * canonical at their write boundary; a session without a project uses its
 * checkout owner's persisted canonical repository identity.
 * Correlated lookups are only evaluated for other runners, preserving local
 * scans and indexes without joining or materializing the history table.
 */
export const HISTORY_IDENTITY_SQL = `CASE WHEN a.runner_id = 'local'
  THEN COALESCE(a.launch_cwd, a.git_context->>'repoRoot', a.cwd)
  ELSE (SELECT CASE WHEN p.id IS NOT NULL
      THEN COALESCE(p.repo_root, p.repository)
      ELSE owner.runner_repository->>'identityKey' END
    FROM agents owner LEFT JOIN projects p ON p.id = a.project_id
    WHERE owner.id = COALESCE(a.runner_worktree_owner, a.id))
  END`;

/** History presentation data; local response objects retain main's shape. */
export function historyProjectFields(
  placement: Placement,
  project: string | null
): { project?: string | null } {
  return sameRunner(placement, controllerPlacement) ? {} : { project };
}
