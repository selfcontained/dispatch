import { realpath } from "node:fs/promises";
import {
  isCheckoutObservation,
  remotePlacement,
  type CheckoutObservation,
  type CheckoutReleaseResult,
} from "@dispatch/runner-protocol";
import type { Pool } from "pg";
import { normalizePath } from "../shared/git/git-context.js";
import { observeGitCheckout } from "./checkout-inspection.js";
import { AgentError } from "./errors.js";
import type { RemoteRunnerService } from "./remote/service.js";
import type { AgentRecord, WorktreeCleanupMode } from "./types.js";

export type ArchiveCheckoutAgent = Pick<
  AgentRecord,
  "id" | "cwd" | "worktreePath" | "baseBranch" | "worktreeBranch"
>;

export async function nativeBorrowers(pool: Pool, agent: ArchiveCheckoutAgent) {
  const path = agent.worktreePath;
  if (!path) return [];
  const canonical = await realpath(path)
    .then(normalizePath)
    .catch(() => path);
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM agents
       WHERE deleted_at IS NULL AND id <> $1
         AND (worktree_path = ANY($2::text[])
           OR workspace_path = ANY($2::text[])
           OR cwd = ANY($2::text[])) ORDER BY id`,
    [agent.id, [...new Set([path, canonical])]]
  );
  return rows.map(({ id }) => id);
}

export async function observeArchiveCheckout(
  pool: Pool,
  agent: ArchiveCheckoutAgent,
  remote?: RemoteRunnerService
): Promise<CheckoutObservation> {
  const placement = remotePlacement(agent.cwd);
  if (placement) {
    if (!remote)
      throw new AgentError("The session runner is unavailable.", 503);
    const { value } = await remote.requestSession(placement, {
      kind: "checkoutRelease",
      agentId: agent.id,
      operation: { kind: "observe" },
    });
    const observation: unknown =
      typeof value === "string" ? JSON.parse(value) : null;
    if (!isCheckoutObservation(observation))
      throw new AgentError(
        "Invalid checkout observation from the runner.",
        502
      );
    return observation;
  }
  if (!agent.worktreePath)
    return {
      ownership: "external",
      owner: null,
      borrowers: [],
      checkout: null,
    };
  const [checkout, borrowers] = await Promise.all([
    observeGitCheckout(agent.worktreePath, agent.baseBranch),
    nativeBorrowers(pool, agent),
  ]);
  return { ownership: "owned", owner: agent.id, borrowers, checkout };
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
  if (mode === "auto") {
    const { checkout, ownership } = await observeArchiveCheckout(
      pool,
      agent,
      remote
    );
    if (
      ownership === "owned" &&
      checkout &&
      !checkout.unmerged &&
      !checkout.uncommittedFiles.length &&
      (expectedState === null || expectedState === checkout.stateId)
    ) {
      expectedState = checkout.stateId;
      // Record the observation before sending a request that can outlive
      // the connection or be deferred while a borrower still holds it.
      await rememberArchiveCheckoutState(pool, agent.id, expectedState);
    } else if (ownership === "owned") {
      expectedState = null;
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
