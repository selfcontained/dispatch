import type { FastifyBaseLogger } from "fastify";
import type { Pool } from "pg";

import {
  remotePlacement,
  type CheckoutObservation,
  type CheckoutReleaseResult,
} from "@dispatch/runner-protocol";
import {
  displayPath,
  sessionFromWire,
  type Runner,
} from "@dispatch/runner-protocol/contract";
import {
  archiveObservation,
  archiveReleaseState,
  authorizesArchiveRelease,
  parseRemoteArchiveObservation,
  rememberArchiveCheckoutState,
  type ArchiveCheckoutAgent,
} from "./archive-checkout.js";
import { enrolledArchiveCheckout } from "../runners/enrolled/checkout.js";
import type { RemoteRunnerService } from "./remote/service.js";
import type { WorktreeCleanupMode } from "./types.js";
import type { ArchivePolicy, RunnerComposition } from "../runners/directory.js";

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

/** A parent's archive authorizes cleanup of all of its children's checkouts. */
export function cascadeMode(): WorktreeCleanupMode {
  return "force";
}

/** Placement-specific steps of the one archive sequence. */
export type ArchiveExecutor = {
  /** False while the executor cannot act; the release stays pending. */
  ready: boolean;
  observe(
    mode: Exclude<WorktreeCleanupMode, "keep">
  ): Promise<CheckoutObservation>;
  /** Live sessions the observation says still use the checkout. */
  borrowers(observation: CheckoutObservation | null): string[];
  /** Another live agent that would lose work if this checkout went; kept. */
  coOwner?(): Promise<string | null>;
  /**
   * Finalize the session and apply the removal decision. The runner checks
   * `expectedState` before removing. Null keeps the checkout.
   */
  release(expectedState: string | null): Promise<CheckoutReleaseResult>;
  /** Capable peers carry out the caller's decision without a snapshot. */
  releaseBound?: () => Promise<boolean>;
  observedCoOwner?: (
    observation: CheckoutObservation
  ) => Promise<string | null>;
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
    const observation = mode === "keep" ? null : await executor.observe(mode);
    if (executor.releaseBound) {
      if (hooks.durations && observation)
        hooks.durations.outstandingChangesCheck = Date.now() - started;
      if (
        observation?.ownership === "owned" &&
        (await executor.observedCoOwner?.(observation))
      )
        return { kind: "kept", reason: "coOwner" };
      if (
        !observation ||
        !(
          observation.ownership === "none" ||
          (observation.ownership === "owned" &&
            authorizesArchiveRelease(mode, observation.checkout))
        )
      ) {
        if (observation?.ownership === "owned")
          await pool.query(
            "UPDATE agents SET archive_cleanup_mode = 'keep' WHERE id = $1",
            [agent.id]
          );
        return { kind: "kept", reason: "notAuthorized" };
      }
      await hooks.onCleanupStart?.();
      const releaseStarted = Date.now();
      const removed = await executor.releaseBound();
      if (hooks.durations)
        hooks.durations.worktreeCleanup = Date.now() - releaseStarted;
      return removed
        ? { kind: "released" }
        : { kind: "kept", reason: "changed" };
    }
    const owned = observation?.ownership === "owned";
    const expectedState = owned
      ? archiveReleaseState(mode, observation.checkout)
      : null;
    if (hooks.durations && observation)
      hooks.durations.outstandingChangesCheck = Date.now() - started;
    if (expectedState !== null) {
      // Record the authorization before a release that can outlive the
      // connection or be deferred while a borrower still holds it.
      await rememberArchiveCheckoutState(pool, agent.id, expectedState);
      if (executor.borrowers(observation).length)
        return { kind: "pending", reason: "borrowed" };
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

/** Main's co-owner rule for a row that records its worktree (exported for its pin). */
export async function localCoOwner(
  pool: Pool,
  agent: ArchiveCheckoutAgent,
  runner: Runner
) {
  const worktreePath = agent.worktreePath;
  if (!worktreePath) return null;
  // Main's realpathOrSelf: one realpath on the agent's runner, no Git.
  const { canonicalPath } = await runner.call("path.resolve", {
    path: worktreePath,
    git: false,
  });
  const worktreeSpellings = [
    ...new Set([
      worktreePath,
      canonicalPath ? displayPath(canonicalPath) : worktreePath,
    ]),
  ];
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id
       FROM agents
       WHERE deleted_at IS NULL
         AND id <> $1
         AND (worktree_path = $2
              OR workspace_path = ANY($4::text[])
              OR (role = 'review' AND cwd = ANY($4::text[]))
              OR ($3::text IS NOT NULL AND worktree_branch = $3))
       LIMIT 1`,
    [agent.id, worktreePath, agent.worktreeBranch, worktreeSpellings]
  );
  return rows[0]?.id ?? null;
}

/** N35's co-owner rule: the runner's borrowers, or a row on the same runner checkout. */
export async function observedCoOwner(
  pool: Pool,
  agent: ArchiveCheckoutAgent,
  observation: CheckoutObservation
) {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM agents WHERE deleted_at IS NULL AND id <> $1
      AND ((role = 'review' AND id = ANY($2::text[])) OR (cwd = $3 AND
        (worktree_path = $4 OR workspace_path = $4 OR worktree_branch = $5)))
      LIMIT 1`,
    [
      agent.id,
      observation.borrowers,
      agent.cwd,
      // Shown on the row only: this legacy rule (N35) is decided at T40.
      null,
      agent.worktreeBranch,
    ]
  );
  return rows[0]?.id ?? null;
}

/** What an error anywhere in the cleanup means, by the runner's policy. */
export function archiveFailure(
  policy: ArchivePolicy
): ArchiveExecutor["onError"] {
  return policy.failure === "kept"
    ? {
        outcome: { kind: "kept", reason: "failed" },
        message: "Worktree cleanup failed; leaving on disk.",
      }
    : {
        outcome: { kind: "pending", reason: "unavailable" },
        message: "Runner checkout release remains pending.",
      };
}

/**
 * The archive's steps on the agent's runner, by the archive policy the
 * composition gives that runner. It never reads the placement to choose.
 */
export function archiveExecutor(
  pool: Pool,
  agent: ArchiveCheckoutAgent,
  runner: Runner & Pick<RunnerComposition, "archive">,
  /** The agent's host stopped. */
  stopped: boolean
): ArchiveExecutor {
  const policy = runner.archive;
  const session = sessionFromWire(agent.id);
  const decision = {
    deleteBranch: Boolean(
      agent.worktreeBranch && agent.worktreeBranch !== agent.baseBranch
    ),
    originalBranch: agent.worktreeBranch,
  };
  const executor: ArchiveExecutor = {
    ready: stopped || !policy.awaitsStoppedHost,
    async observe(mode) {
      // Force needs no Git status or fetch to authorize removal.
      if (mode === "force" && policy.forceSkipsObserve)
        return {
          ownership: "owned",
          owner: agent.id,
          borrowers: [],
          checkout: null,
        };
      return archiveObservation(
        await runner.call("workspace.observe", { session })
      );
    },
    borrowers: () => [],
    async release(expectedState) {
      if (expectedState === null) return "retained";
      const { removed } = await runner.call("workspace.release", {
        session,
        ...decision,
      });
      return removed ? "released" : "retained";
    },
    onError: archiveFailure(policy),
  };
  if (policy.coOwner === "recorded")
    return { ...executor, coOwner: () => localCoOwner(pool, agent, runner) };
  return {
    ...executor,
    releaseBound: async () =>
      (await runner.call("workspace.release", { session, ...decision }))
        .removed,
    observedCoOwner: (observation) => observedCoOwner(pool, agent, observation),
  };
}

/**
 * The snapshot release on a runner that does not serve bound release
 * (`checkoutRelease`'s expected state), as before the archive seam.
 */
export function runnerArchiveExecutor(
  agent: ArchiveCheckoutAgent,
  remote: RemoteRunnerService | undefined,
  /** The guest host stopped; the runner refuses to release a live host. */
  stopped: boolean,
  policy: ArchivePolicy
): ArchiveExecutor {
  const placement = remotePlacement(agent.cwd);
  const transport =
    placement && remote
      ? enrolledArchiveCheckout(remote, placement, agent.id)
      : undefined;
  return {
    ready: Boolean(stopped && remote),
    async observe(mode) {
      if (!transport) throw new Error("Missing remote runner placement.");
      const { value } = await transport.observe(
        mode === "force" ? "ownership" : "changes"
      );
      return parseRemoteArchiveObservation(value);
    },
    borrowers: () => [],
    async release(expectedState) {
      if (!transport) throw new Error("Missing remote runner placement.");
      return transport.release(expectedState);
    },
    onError: archiveFailure(policy),
  };
}
