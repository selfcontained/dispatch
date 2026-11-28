import {
  UNOBSERVED_STATE,
  type CheckoutObservation,
} from "@dispatch/runner-protocol";
import type { Pool } from "pg";
import {
  displayPath,
  sessionFromWire,
  type Placement,
  type Res,
  type Runner,
} from "@dispatch/runner-protocol/contract";
import {
  checkoutRunners,
  type CheckoutCommandRunners,
  type RunnerComposition,
} from "../runners/directory.js";
import { observeBoundCheckout } from "@dispatch/runner-protocol";
import type { RemoteRunnerService } from "./remote/service.js";
import type { AgentRecord, WorktreeCleanupMode } from "./types.js";

export type ArchiveCheckoutAgent = Pick<
  AgentRecord,
  "id" | "cwd" | "worktreePath" | "baseBranch" | "worktreeBranch"
> & { repositorySource?: boolean };

/** A row's session on the agent's runner, through the directory. */
export function archiveRunner(
  runners: Pick<CheckoutCommandRunners, "child" | "remote">,
  row: ArchiveCheckoutAgent,
  placement: Placement
): Runner & Pick<RunnerComposition, "archive" | "cleanupBudgetMs"> {
  const { directory } = checkoutRunners(runners, {
    ...row,
    workspacePath: null,
    placement,
  });
  return directory.for(placement);
}

/** Repository-owned checkouts keep release retryable, including interrupted preparation. */
export async function withRepositorySource<T extends ArchiveCheckoutAgent>(
  pool: Pool,
  agent: T
): Promise<T> {
  const result = await pool.query<{ repositorySource: boolean }>(
    `SELECT COALESCE(runner_preparation->'source' ? 'repository', false) AS "repositorySource" FROM agents WHERE id = $1`,
    [agent.id]
  );
  return {
    ...agent,
    repositorySource: result.rows[0]?.repositorySource ?? false,
  };
}

/** The contract's observation in the archive's terms. */
export function archiveObservation(
  observed: Res<"workspace.observe">
): CheckoutObservation {
  return {
    ...observed,
    checkout: observed.checkout && {
      ...observed.checkout,
      path: displayPath(observed.checkout.path),
    },
  };
}

export async function nativeBorrowers(
  pool: Pool,
  agent: ArchiveCheckoutAgent,
  canonicalPath: string
) {
  const path = agent.worktreePath;
  if (!path) return [];
  const checkoutPaths = new Set([path, canonicalPath]);
  const { rows } = await pool.query<{
    id: string;
    worktreePath: string | null;
    workspacePath: string | null;
    requested: boolean;
  }>(
    `SELECT id, worktree_path AS "worktreePath", workspace_path AS "workspacePath",
            COALESCE(runner_preparation->'source' ? 'directory', false) AS requested
       FROM agents
       WHERE deleted_at IS NULL AND id <> $1
         AND (worktree_path = ANY($2::text[])
           OR workspace_path = ANY($2::text[])
           OR cwd = ANY($2::text[])) ORDER BY id`,
    [agent.id, [...checkoutPaths]]
  );
  const borrowers: string[] = [];
  for (const row of rows) {
    // A launch that asked for its own worktree but never got one only kept
    // its launch cwd; like a runner session that never bound, it borrows
    // nothing. Its row records the request.
    if (
      !row.worktreePath &&
      (!row.workspacePath || !checkoutPaths.has(row.workspacePath)) &&
      row.requested
    )
      continue;
    borrowers.push(row.id);
  }
  return borrowers;
}

/**
 * The status read before archive, on the agent's runner, by the borrower
 * rule the composition gives that runner.
 */
export async function observeArchiveCheckout(
  pool: Pool,
  agent: ArchiveCheckoutAgent & Pick<AgentRecord, "placement">,
  remote?: RemoteRunnerService,
  child?: () => Runner | undefined
): Promise<CheckoutObservation> {
  return borrowerAsMain(
    await observeOnRunner(
      pool,
      await withRepositorySource(pool, agent),
      remote,
      child
    )
  );
}

/**
 * Main's answer for a borrower on every runner: a row that borrows another
 * session's checkout has no worktree of its own to report (347eb0c3 reported
 * the owner's; reverted). It stays `borrowed`, with its borrowers; what the
 * runner observed is unchanged.
 */
function borrowerAsMain(observed: CheckoutObservation): CheckoutObservation {
  return observed.ownership === "borrowed"
    ? { ...observed, checkout: null }
    : observed;
}

async function observeOnRunner(
  pool: Pool,
  agent: ArchiveCheckoutAgent & Pick<AgentRecord, "placement">,
  remote?: RemoteRunnerService,
  child?: () => Runner | undefined
): Promise<CheckoutObservation> {
  const runner = archiveRunner({ child, remote }, agent, agent.placement);
  if (runner.archive.borrowers === "observed")
    return archiveObservation(
      await runner.call("workspace.observe", {
        session: sessionFromWire(agent.id),
      })
    );
  let binding: ArchiveCheckoutAgent = agent;
  if (!agent.worktreePath) {
    // A local borrower launches in the owner's worktree but has no worktree
    // path of its own. A deleted owner can still be holding it for borrowers.
    const { rows } = await pool.query<ArchiveCheckoutAgent>(
      `SELECT id, cwd, worktree_path AS "worktreePath", base_branch AS "baseBranch",
              worktree_branch AS "worktreeBranch"
       FROM agents
       WHERE worktree_path = $1 AND (deleted_at IS NULL OR runner_cleanup_pending)
       ORDER BY deleted_at NULLS FIRST, id LIMIT 1`,
      [agent.cwd]
    );
    binding = rows[0] ?? agent;
  }
  const observed = archiveObservation(
    await archiveRunner({ child, remote }, binding, agent.placement).call(
      "workspace.observe",
      { session: sessionFromWire(binding.id) }
    )
  );
  const checkoutPath =
    observed.checkout?.path ??
    (binding.id !== agent.id ? binding.worktreePath : null);
  if (observed.ownership !== "owned" || !checkoutPath) return observed;
  return observeBoundCheckout(
    agent.id,
    binding.id,
    await nativeBorrowers(pool, binding, checkoutPath),
    observed.checkout
  );
}

export async function rememberArchiveCheckoutState(
  pool: Pool,
  id: string,
  state: string
) {
  await pool.query(
    "UPDATE agents SET archive_checkout_state = $2 WHERE id = $1",
    [id, state]
  );
}

export function authorizesArchiveRelease(
  mode: WorktreeCleanupMode,
  checkout: CheckoutObservation["checkout"]
): boolean {
  return (
    mode !== "keep" &&
    !(
      mode === "auto" &&
      checkout &&
      (checkout.unmerged || checkout.uncommittedFiles.length)
    )
  );
}

/** The snapshot to release, or null when the archive should keep the checkout. */
export function archiveReleaseState(
  mode: WorktreeCleanupMode,
  checkout: CheckoutObservation["checkout"]
): string | null {
  if (!authorizesArchiveRelease(mode, checkout)) return null;
  return checkout?.stateId ?? UNOBSERVED_STATE;
}
