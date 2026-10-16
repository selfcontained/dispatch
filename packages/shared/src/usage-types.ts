/**
 * A live session's config options (model, effort, mode) and what an agent
 * has used. Served by `/api/v1/agents/:id/config`, `/api/v1/agents/:id/usage`
 * and `/api/v1/usage/plans`.
 */

/** One value a select option can take; `group` is the engine's heading for it. */
export type AgentConfigChoice = {
  value: string;
  name: string;
  description?: string;
  group?: string;
};

/** A select option the engine publishes on its ACP session. */
export type AgentConfigOption = {
  id: string;
  name: string;
  /** ACP's semantic category: `model`, `thought_level`, `mode`, or the engine's own. */
  category: string | null;
  currentValue: string;
  choices: AgentConfigChoice[];
};

export type AgentConfigResponse = {
  /** False without a live session; `options` is then empty. */
  running: boolean;
  options: AgentConfigOption[];
};

export type AgentConfigUpdateRequest = { configId: string; value: string };

export type TokenCounts = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Every kind together. */
  total: number;
};

export type AgentUsageResponse = {
  /** How full the context window was at the newest report; null before any. */
  context: { used: number; size: number } | null;
  /** The engine's running cost for the current session, when it reports one (Claude). */
  sessionCost: { amount: number; currency: string } | null;
  /** Tokens this agent's current session has used, across models. */
  session: TokenCounts;
  /** Tokens per model this session, largest first. */
  byModel: Array<{ model: string; tokens: TokenCounts }>;
};

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

/** Credits that reset a reached rate limit early (Codex); no expiry is reported. */
export type PlanLimitResets = {
  available: number;
  /** How many of them apply to the limit state right now. */
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
