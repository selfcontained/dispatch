/** One rate-limit window of a subscription plan (5-hour, weekly…). */
export type PlanWindow = {
  id: string;
  label: string;
  usedPercent: number;
  resetsAt: string | null;
  /** The provider's own warning level for the window ("normal", "warning", …), when it gives one. */
  severity?: string;
};

export type PlanSpend = {
  used: number;
  limit: number;
  currency: string;
  /** False when the provider has extra usage switched off; absent when it does not say. */
  enabled?: boolean;
  /** The provider's reason it is off ("out_of_credits"), when it gives one. */
  disabledReason?: string;
};

/** Credits for resetting usage limits early (Codex). */
export type PlanLimitResets = {
  available: number;
  /** Raw provider applicable_available_count; semantics are undocumented.
   * Do not use as a redemption eligibility gate or expose in agent usage. */
  applicable: number;
  /** When the first of them lapses; absent when the provider gave no detail. */
  oldestExpiresAt?: string | null;
  /** Each reset held, oldest first — the one a redeem spends is the first. */
  items?: Array<{
    id: string;
    title: string;
    grantedAt: string | null;
    expiresAt: string | null;
  }>;
};

/** Prepaid credits the plan can keep running on once a window is spent (Codex). */
export type PlanCredits = {
  /** Null when the provider does not say how many. */
  balance: number | null;
  unlimited: boolean;
};

export type ProviderPlan = {
  engine: "claude" | "codex";
  /** The plan's name when the provider says it ("Pro", "Max"). */
  plan: string | null;
  observedAt: string | null;
  /**
   * Where the newest report came from: the provider's API asked just now
   * (`live`), or a report the engine left on this machine (`local`), which
   * is only as fresh as the engine's last model response here.
   */
  source?: "live" | "local";
  windows: PlanWindow[];
  spend?: PlanSpend;
  credits?: PlanCredits;
  limitResets?: PlanLimitResets;
  /**
   * The provider says requests are refused right now: a window spent with
   * no credits to fall back on, or a spend cap reached. Absent when the
   * provider does not report it; the windows' percentages decide then.
   */
  limitReached?: boolean;
  /** Why there is nothing to show, when there is not. */
  unavailableReason?: string;
};

export type ProviderPlansResponse = {
  checkedAt: string;
  providers: ProviderPlan[];
};

export type RefreshFailureReason =
  | "account_changed"
  | "not_signed_in"
  | "login_expired"
  | "login_rejected"
  | "request_failed"
  | "http_error"
  | "no_usage_reported"
  | "unexpected";

/** What ChatGPT answered to a redeem: `ok`, `nothing_to_reset`, `no_credit`, or its own word. */
export type CodexResetOutcome = {
  code: string;
  windowsReset: number;
  /** The reset spent, when one was. */
  credit: { id: string; title: string; expiresAt: string | null } | null;
};

export class CodexResetError extends Error {
  constructor(
    readonly reason: RefreshFailureReason,
    message: string
  ) {
    super(message);
  }
}
