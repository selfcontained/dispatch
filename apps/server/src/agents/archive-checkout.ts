import {
  isCheckoutObservation,
  remotePlacement,
  type CheckoutObservation,
  type CheckoutReleaseResult,
} from "@dispatch/runner-protocol";
import type { Pool } from "pg";
import type { createLocalRunner } from "./local-runner.js";
import { observeBoundCheckout } from "./checkout-observation.js";
import { AgentError } from "./errors.js";
import type { RemoteRunnerService } from "./remote/service.js";
import type { AgentRecord, WorktreeCleanupMode } from "./types.js";

export type ArchiveCheckoutAgent = Pick<
  AgentRecord,
  "id" | "cwd" | "worktreePath" | "baseBranch" | "worktreeBranch"
>;

export type LocalArchiveRunner = Pick<
  ReturnType<typeof createLocalRunner>,
  "checkoutRelease" | "requestedWorktree"
>;

export async function nativeBorrowers(
  pool: Pool,
  agent: ArchiveCheckoutAgent,
  canonicalPath: string,
  localRunner: Pick<LocalArchiveRunner, "requestedWorktree">
) {
  const path = agent.worktreePath;
  if (!path) return [];
  const checkoutPaths = new Set([path, canonicalPath]);
  const { rows } = await pool.query<{
    id: string;
    worktreePath: string | null;
    workspacePath: string | null;
  }>(
    `SELECT id, worktree_path AS "worktreePath", workspace_path AS "workspacePath"
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
    // nothing.
    if (
      !row.worktreePath &&
      (!row.workspacePath || !checkoutPaths.has(row.workspacePath)) &&
      (await localRunner.requestedWorktree(row.id))
    )
      continue;
    borrowers.push(row.id);
  }
  return borrowers;
}

export async function observeArchiveCheckout(
  pool: Pool,
  agent: ArchiveCheckoutAgent,
  localRunner: LocalArchiveRunner,
  remote?: RemoteRunnerService
): Promise<CheckoutObservation> {
  const placement = remotePlacement(agent.cwd);
  if (placement) {
    if (!remote)
      throw new AgentError("The session runner is unavailable.", 503);
    return observeRemoteCheckout(agent, remote, placement);
  }
  let binding = agent;
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
  const observed = await localRunner.checkoutRelease(binding, {
    kind: "observe",
  });
  const checkoutPath =
    observed.checkout?.path ??
    (binding.id !== agent.id ? binding.worktreePath : null);
  if (observed.ownership !== "owned" || !checkoutPath) return observed;
  return observeBoundCheckout(
    agent.id,
    binding.id,
    await nativeBorrowers(pool, binding, checkoutPath, localRunner),
    observed.checkout
  );
}

async function observeRemoteCheckout(
  agent: ArchiveCheckoutAgent,
  remote: RemoteRunnerService,
  placement: NonNullable<ReturnType<typeof remotePlacement>>
): Promise<CheckoutObservation> {
  const { value } = await remote.requestSession(placement, {
    kind: "checkoutRelease",
    agentId: agent.id,
    operation: { kind: "observe" },
  });
  const observation: unknown =
    typeof value === "string" ? JSON.parse(value) : null;
  if (!isCheckoutObservation(observation))
    throw new AgentError("Invalid checkout observation from the runner.", 502);
  return observation;
}

export async function archiveCheckoutState(pool: Pool, id: string) {
  const { rows } = await pool.query<{ archive_checkout_state: string | null }>(
    "SELECT archive_checkout_state FROM agents WHERE id = $1",
    [id]
  );
  return rows[0]?.archive_checkout_state ?? null;
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

/** The snapshot to release, or null when the archive should keep the checkout. */
export function archiveReleaseState(
  mode: WorktreeCleanupMode,
  checkout: CheckoutObservation["checkout"],
  expectedState: string | null
): string | null {
  if (!checkout || mode === "keep") return null;
  if (expectedState !== null && checkout.stateId !== expectedState) return null;
  if (
    mode === "auto" &&
    (checkout.unmerged || checkout.uncommittedFiles.length)
  )
    return null;
  return checkout.stateId;
}

export async function releaseRemoteCheckout(
  pool: Pool,
  agent: ArchiveCheckoutAgent,
  mode: WorktreeCleanupMode,
  remote: RemoteRunnerService
): Promise<CheckoutReleaseResult> {
  const placement = remotePlacement(agent.cwd);
  if (!placement) throw new Error("Missing remote runner placement.");
  let expectedState =
    mode === "keep" ? null : await archiveCheckoutState(pool, agent.id);
  if (mode === "auto" || (mode === "force" && expectedState === null)) {
    const { checkout, ownership } = await observeRemoteCheckout(
      agent,
      remote,
      placement
    );
    if (ownership === "owned") {
      expectedState = archiveReleaseState(mode, checkout, expectedState);
    }
    if (ownership === "owned" && expectedState !== null) {
      // Record the observation before sending a request that can outlive
      // the connection or be deferred while a borrower still holds it.
      await rememberArchiveCheckoutState(pool, agent.id, expectedState);
    } else if (ownership === "owned") {
      // Persist the keep decision across a lost reply or server restart.
      await pool.query(
        "UPDATE agents SET archive_cleanup_mode = 'keep' WHERE id = $1",
        [agent.id]
      );
    }
  }
  const { value } = await remote.requestSession(placement, {
    kind: "checkoutRelease",
    agentId: agent.id,
    operation: { kind: "release", expectedState },
  });
  if (value !== "released" && value !== "retained" && value !== "inUse")
    throw new Error("Invalid checkout release result from the runner.");
  return value;
}
