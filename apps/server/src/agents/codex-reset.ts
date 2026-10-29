import { randomUUID } from "node:crypto";
import type { ProviderPlansResponse } from "@dispatch/shared";
import { CodexResetError, type CodexResetOutcome } from "./provider-plans.js";

export type CodexResetResult = {
  outcome: CodexResetOutcome | null;
  error: { reason: string; message: string; possiblyConsumed: boolean } | null;
  usage: ProviderPlansResponse | null;
  refreshError: string | null;
};
export type RedeemCodexReset = (
  idempotencyKey?: string
) => Promise<CodexResetResult>;

/** Process-local, account-wide protection shared by HTTP and MCP. Entries (including
 * ambiguous failures) live for ten minutes after completion. Never evict a live
 * entry to admit work. Restarting this process loses protection; callers must reuse
 * their UUID on retries, including after a lost response. No automatic retries.
 * Legacy UI clients without a key share one retained operation for this interval,
 * except definitive no-spend outcomes/auth failures, which can safely be retried.
 */
export function createCodexResetCoordinator(deps: {
  consume: (requestId: string) => Promise<CodexResetOutcome>;
  providerPlans: ((request?: {
    force?: boolean;
  }) => Promise<ProviderPlansResponse>) & { invalidate?: () => void };
  now?: () => number;
}): RedeemCodexReset {
  const retentionMs = 10 * 60_000;
  const maxEntries = 1024;
  const now = deps.now ?? Date.now;
  const entries = new Map<
    string,
    { expiresAt: number; result: Promise<CodexResetResult> }
  >();
  let active = false;
  return (idempotencyKey) => {
    const key = idempotencyKey ?? "legacy-ui";
    for (const [id, entry] of entries) {
      if (entry.expiresAt <= now()) entries.delete(id);
    }
    const previous = entries.get(key);
    if (previous) return previous.result;
    if (active || entries.size >= maxEntries) {
      return Promise.resolve({
        outcome: null,
        error: {
          reason: active ? "reset_in_progress" : "idempotency_capacity",
          message: active
            ? "Another account-shared reset is in progress. Check usage before making a new request."
            : "Reset replay protection is full. Wait ten minutes before making a new request.",
          possiblyConsumed: false,
        },
        usage: null,
        refreshError: null,
      });
    }
    active = true;
    const entry = {
      expiresAt: Infinity,
      result: undefined! as Promise<CodexResetResult>,
    };
    // Defer execution so synchronous callbacks cannot run before the entry exists.
    entry.result = Promise.resolve()
      .then(async () => {
        let outcome: CodexResetOutcome | null = null;
        let error: CodexResetResult["error"] = null;
        let usage: ProviderPlansResponse | null = null;
        let refreshError: string | null = null;
        try {
          outcome = await deps.consume(idempotencyKey ?? randomUUID());
        } catch (failure) {
          error = {
            reason:
              failure instanceof CodexResetError
                ? failure.reason
                : "unexpected",
            message:
              failure instanceof CodexResetError
                ? failure.message
                : "Reset execution failed; whether a credit was spent is unknown. Check usage before retrying.",
            possiblyConsumed: !(
              failure instanceof CodexResetError &&
              ["not_signed_in", "login_expired"].includes(failure.reason)
            ),
          };
        }
        try {
          if (outcome || (error && error.reason !== "not_signed_in"))
            deps.providerPlans.invalidate?.();
          usage = await deps.providerPlans({ force: true });
          const codex = usage.providers.find((plan) => plan.engine === "codex");
          refreshError = !codex
            ? "Refreshed usage did not include Codex."
            : (codex.unavailableReason ?? null);
        } catch (failure) {
          refreshError =
            failure instanceof Error
              ? failure.message
              : "Usage refresh failed.";
        }
        if (
          !idempotencyKey &&
          (error?.possiblyConsumed === false ||
            outcome?.code === "nothing_to_reset" ||
            outcome?.code === "no_credit")
        ) {
          entries.delete(key);
        }
        return { outcome, error, usage, refreshError };
      })
      .finally(() => {
        active = false;
        entry.expiresAt = now() + retentionMs;
      });
    entries.set(key, entry);
    return entry.result;
  };
}
