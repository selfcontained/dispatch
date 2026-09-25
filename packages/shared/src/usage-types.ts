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
  /** Tokens this agent has used since the start of the month (UTC). */
  month: TokenCounts;
  /** Tokens per model this session, largest first. */
  byModel: Array<{ model: string; tokens: TokenCounts }>;
};

/** One rate-limit window of a subscription plan (5-hour, weekly…). */
export type PlanWindow = {
  id: string;
  label: string;
  usedPercent: number;
  resetsAt: string | null;
};

export type PlanSpend = { used: number; limit: number; currency: string };

export type ProviderPlan = {
  engine: "claude" | "codex";
  /** The plan's name when the provider says it ("Pro", "Max"). */
  plan: string | null;
  observedAt: string | null;
  windows: PlanWindow[];
  spend?: PlanSpend;
  /** Why there is nothing to show, when there is not. */
  unavailableReason?: string;
};

export type ProviderPlansResponse = {
  checkedAt: string;
  providers: ProviderPlan[];
};
