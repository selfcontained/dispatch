import type { FastifyBaseLogger } from "fastify";
import type { Pool } from "pg";

import {
  remotePlacement,
  type CheckoutObservation,
  type CheckoutReleaseResult,
} from "@dispatch/runner-protocol";
import {
  archiveCheckoutState,
  archiveReleaseState,
  nativeBorrowers,
  observeArchiveCheckout,
  observeRemoteCheckout,
  rememberArchiveCheckoutState,
  type ArchiveCheckoutAgent,
  type LocalArchiveRunner,
} from "./archive-checkout.js";
import type { RemoteRunnerService } from "./remote/service.js";
import type { WorktreeCleanupMode } from "./types.js";

/**
 * What archiving did with an agent's checkout. `pending` is the only outcome
 * the archive retries: the executor could not act yet (runner offline, host
 * still running, release failed on the runner) or another live session still
 * borrows the checkout.
 */
export type ArchiveOutcome =
  | { kind: "released" }
  | {
      kind: "kept";
      reason: "notManaged" | "notAuthorized" | "changed" | "coOwner" | "failed";
    }
  | { kind: "pending"; reason: "unavailable" | "borrowed" };

export type ArchivePlacement = "local" | "runner";

/** A parent's archive authorizes cleanup of all of its children's checkouts. */
export function cascadeMode(): WorktreeCleanupMode {
  return "force";
}

/** Placement-specific steps of the one archive sequence. */
export type ArchiveExecutor = {
  placement: ArchivePlacement;
  /** False while the executor cannot act; the release stays pending. */
  ready: boolean;
  /**
   * Whether a forced release with a stored snapshot is checked here first.
   * The runner rechecks the snapshot itself when it releases.
   */
  observesAuthorizedRelease: boolean;
  observe(): Promise<CheckoutObservation>;
  /** Live sessions the observation says still use the checkout. */
  borrowers(observation: CheckoutObservation | null): string[];
  /** Another live agent that would lose work if this checkout went; kept. */
  coOwner?(): Promise<string | null>;
  /**
   * Finalize the session and remove the checkout only if it still matches
   * `expectedState`; null keeps it. `inUse` defers, like the runner.
   */
  release(expectedState: string | null): Promise<CheckoutReleaseResult>;
  /** What an error anywhere in the sequence means. */
  onError: { outcome: ArchiveOutcome; message: string };
};

export type ArchiveCheckoutHooks = {
  durations?: Record<string, number>;
  /** Runs once removal is authorized, before the executor releases. */
  onCleanupStart?: () => Promise<void>;
};

/**
 * observe → decide by mode and observation → remember → release or keep.
 * Both placements run this sequence; only the executor differs.
 */
export async function finishArchiveCheckout(
  pool: Pool,
  logger: FastifyBaseLogger,
  agent: ArchiveCheckoutAgent,
  mode: WorktreeCleanupMode,
  executor: ArchiveExecutor,
  hooks: ArchiveCheckoutHooks = {}
): Promise<ArchiveOutcome> {
  if (!executor.ready) return { kind: "pending", reason: "unavailable" };
  try {
    const started = Date.now();
    const stored =
      mode === "keep" ? null : await archiveCheckoutState(pool, agent.id);
    const observation =
      mode !== "keep" &&
      (mode === "auto" || stored === null || executor.observesAuthorizedRelease)
        ? await executor.observe()
        : null;
    const owned = observation?.ownership === "owned";
    // Without an owned observation the stored snapshot is the authorization.
    const expectedState = owned
      ? archiveReleaseState(mode, observation.checkout, stored)
      : stored;
    if (hooks.durations && observation)
      hooks.durations.outstandingChangesCheck = Date.now() - started;
    if (expectedState !== null) {
      // Record the authorization before a release that can outlive the
      // connection or be deferred while a borrower still holds it.
      await rememberArchiveCheckoutState(pool, agent.id, expectedState);
      if (executor.borrowers(observation).length)
        return { kind: "pending", reason: "borrowed" };
      const coOwner = await executor.coOwner?.();
      if (coOwner) {
        logger.warn(
          {
            agentId: agent.id,
            worktreePath: agent.worktreePath,
            worktreeBranch: agent.worktreeBranch,
            sharedWithAgentId: coOwner,
          },
          "Another live agent references this worktree; leaving it on disk."
        );
        return { kind: "kept", reason: "coOwner" };
      }
      await hooks.onCleanupStart?.();
    } else if (owned) {
      // Persist the keep decision across a lost reply or server restart.
      await pool.query(
        "UPDATE agents SET archive_cleanup_mode = 'keep' WHERE id = $1",
        [agent.id]
      );
    }
    const releaseStarted = Date.now();
    const result = await executor.release(expectedState);
    if (hooks.durations && expectedState !== null)
      hooks.durations.worktreeCleanup = Date.now() - releaseStarted;
    if (result === "inUse") return { kind: "pending", reason: "borrowed" };
    if (result === "released") return { kind: "released" };
    if (expectedState === null)
      return { kind: "kept", reason: "notAuthorized" };
    return { kind: "kept", reason: "changed" };
  } catch (err) {
    logger.warn(
      { err, agentId: agent.id, worktreePath: agent.worktreePath },
      executor.onError.message
    );
    return executor.onError.outcome;
  }
}

/**
 * Another live agent recorded on the same branch. Releasing deletes a branch
 * Dispatch created, which would take that agent's work.
 */
async function branchCoOwner(pool: Pool, agent: ArchiveCheckoutAgent) {
  if (!agent.worktreeBranch) return null;
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM agents
     WHERE deleted_at IS NULL AND id <> $1 AND worktree_branch = $2
     LIMIT 1`,
    [agent.id, agent.worktreeBranch]
  );
  return rows[0]?.id ?? null;
}

export function localArchiveExecutor(
  pool: Pool,
  agent: ArchiveCheckoutAgent,
  localRunner: LocalArchiveRunner
): ArchiveExecutor {
  let checkoutPath: string | null = null;
  return {
    placement: "local",
    ready: true,
    observesAuthorizedRelease: true,
    async observe() {
      const observation = await observeArchiveCheckout(
        pool,
        agent,
        localRunner
      );
      checkoutPath = observation.checkout?.path ?? null;
      return observation;
    },
    borrowers: (observation) => observation?.borrowers ?? [],
    // Restores origin/main's worktree_branch co-owner guard.
    coOwner: () => branchCoOwner(pool, agent),
    async release(expectedState) {
      if (expectedState === null || !checkoutPath) return "retained";
      // Recheck just before removal: a borrower may have bound since.
      if (
        (await nativeBorrowers(pool, agent, checkoutPath, localRunner)).length
      )
        return "inUse";
      return localRunner.checkoutRelease(agent, {
        kind: "release",
        expectedState,
      });
    },
    onError: {
      outcome: { kind: "kept", reason: "failed" },
      message: "Worktree cleanup failed; leaving on disk.",
    },
  };
}

export function runnerArchiveExecutor(
  agent: ArchiveCheckoutAgent,
  remote: RemoteRunnerService | undefined,
  /** The guest host stopped; the runner refuses to release a live host. */
  stopped: boolean
): ArchiveExecutor {
  const placement = remotePlacement(agent.cwd);
  return {
    placement: "runner",
    ready: Boolean(stopped && remote),
    observesAuthorizedRelease: false,
    observe() {
      if (!placement || !remote)
        throw new Error("Missing remote runner placement.");
      return observeRemoteCheckout(agent, remote, placement);
    },
    // The runner checks borrowers atomically when it releases.
    borrowers: () => [],
    async release(expectedState) {
      if (!placement || !remote)
        throw new Error("Missing remote runner placement.");
      const { value } = await remote.requestSession(placement, {
        kind: "checkoutRelease",
        agentId: agent.id,
        operation: { kind: "release", expectedState },
      });
      if (value !== "released" && value !== "retained" && value !== "inUse")
        throw new Error("Invalid checkout release result from the runner.");
      return value;
    },
    onError: {
      outcome: { kind: "pending", reason: "unavailable" },
      message: "Runner checkout release remains pending.",
    },
  };
}
