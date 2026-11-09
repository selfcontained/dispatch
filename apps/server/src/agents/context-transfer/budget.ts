import { createHash } from "node:crypto";
import {
  BudgetSnapshotSchema,
  RuntimeIdentitySchema,
  type RuntimeIdentity,
  type BudgetSnapshot,
} from "./types.js";

export function budgetProfileHash(
  b: Pick<
    BudgetSnapshot,
    | "contextTokens"
    | "inputLimitTokens"
    | "outputTokens"
    | "toolReserveTokens"
    | "handoffReserveTokens"
    | "tokenizerHash"
    | "templateHash"
  >
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        b.contextTokens,
        b.inputLimitTokens,
        b.outputTokens,
        b.toolReserveTokens,
        b.handoffReserveTokens,
        b.tokenizerHash,
        b.templateHash,
      ])
    )
    .digest("hex");
}

export type BudgetDecision =
  | { action: "blocked"; reason: string }
  | { action: "continue" | "compact" | "prepare"; inputCeiling: number };

/** Expected identity/counts must come from a trusted adapter, not a summary. */
export function evaluateBudget(
  input: unknown,
  expected: { identity: RuntimeIdentity; boundary: number },
  now: number,
  maxAgeMs = 30_000
): BudgetDecision {
  const parsed = BudgetSnapshotSchema.safeParse(input);
  if (!parsed.success) return { action: "blocked", reason: "invalid_snapshot" };
  const b = parsed.data;
  const wanted = RuntimeIdentitySchema.safeParse(expected.identity);
  if (!wanted.success) return { action: "blocked", reason: "invalid_identity" };
  if (
    JSON.stringify(b.identity) !== JSON.stringify(wanted.data) ||
    b.boundary !== expected.boundary
  )
    return { action: "blocked", reason: "stale_identity" };
  if (b.identity.budgetProfileHash !== budgetProfileHash(b)) {
    return { action: "blocked", reason: "profile_mismatch" };
  }
  const age = now - Date.parse(b.observedAt);
  if (
    !Number.isFinite(now) ||
    age < 0 ||
    age > maxAgeMs ||
    !Number.isFinite(maxAgeMs) ||
    maxAgeMs < 0
  ) {
    return { action: "blocked", reason: "stale_observation" };
  }
  if (
    b.source !== "exact-render" ||
    b.renderedInputTokens === null ||
    Object.values(b.counted).some((value) => !value)
  ) {
    return { action: "blocked", reason: "incomplete_accounting" };
  }
  if (b.cachedInputTokens > b.renderedInputTokens) {
    return { action: "blocked", reason: "invalid_cache_subset" };
  }
  const margin = b.outputTokens + b.toolReserveTokens + b.handoffReserveTokens;
  const inputCeiling = Math.min(
    b.inputLimitTokens ?? b.contextTokens,
    b.contextTokens - margin
  );
  if (!Number.isSafeInteger(margin) || margin >= b.contextTokens) {
    return { action: "blocked", reason: "invalid_reserve" };
  }
  if (b.renderedInputTokens <= inputCeiling)
    return { action: "continue", inputCeiling };
  return {
    action: b.phase === "before-compaction" ? "compact" : "prepare",
    inputCeiling,
  };
}
