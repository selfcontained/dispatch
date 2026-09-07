import type { ChatAttachment, ChatQuestionOption } from "./chat-types.js";

/**
 * The Harness view's wire types: a stream-driven agent's activity cut into
 * turns. Assembled server-side from `agent_stream_events`; the web maps
 * them onto the PromptKit turn model it renders.
 */

export type HarnessPrompt = {
  source: "chat" | "launch" | "agent" | "system";
  text: string;
  /** Cross-agent messages: who sent it. */
  senderName?: string;
  chatMessageId?: string;
  attachments: ChatAttachment[];
};

export type HarnessStepStatus = "running" | "ok" | "error";

export type HarnessStep = {
  id: string;
  /** execute | edit | read | search | fetch | think | note | other */
  kind: string;
  label: string;
  status: HarnessStepStatus;
  startedAt: string;
  endedAt?: string;
  durMs?: number;
  detail: {
    toolKind?: string;
    locations?: { path: string; line?: number }[];
    diff?: { path: string; oldText: string | null; newText: string } | null;
    terminalOutput?: string | null;
    truncated?: boolean;
    /** The tool call's raw input (dsh sends the model's arguments). */
    input?: unknown;
    /** note and think steps: the full text. */
    text?: string;
    /** A `subagent` step: the child session it started. */
    subagentSessionId?: string;
  };
};

/**
 * A question the agent posted through dispatch_chat_post during the turn:
 * it lives in the Chat feed, which a harness agent's pane does not show,
 * so the Harness view carries it on the turn with its answer state.
 */
export type HarnessQuestion = {
  /** The chat message id; answers post against it. */
  id: string;
  text: string;
  options: ChatQuestionOption[];
  allowFreeform: boolean;
  answer: { value: string; label?: string } | null;
  createdAt: string;
};

export type HarnessTurn = {
  id: string;
  prompt: HarnessPrompt;
  trace: {
    startedAt: string;
    endedAt?: string;
    /** `interrupted`: the turn was cancelled (Stop, Ctrl+C, Send now). */
    finalResult?: "ok" | "error" | "interrupted";
    steps: HarnessStep[];
  };
  result: { text: string; streaming: boolean; truncated?: boolean } | null;
  error?: string;
  /** Questions the agent asked during this turn, oldest first. */
  questions?: HarnessQuestion[];
  /**
   * What the turn did, in the agent's own words: the message of the last
   * dispatch_event it sent during the turn ("Answered README question").
   * Absent when the agent sent none.
   */
  label?: string;
};

/**
 * A prompt waiting behind the running turn. `id` addresses it on the queue
 * routes (the chat message id for a chat prompt).
 */
export type HarnessQueuedPrompt = HarnessPrompt & {
  id: string;
  createdAt: string;
};

/**
 * A dsh subagent: a session of its own, spawned by a `subagent` tool call
 * in the parent's turn. Shaped from the child's log, so it reads as turns.
 */
export type HarnessSubagent = {
  /** The child session id, as the parent's step output names it. */
  id: string;
  /** The parent's description of the task. */
  label?: string;
  model?: string;
  status: "starting" | "running" | "finished";
  startedAt: string;
  endedAt?: string;
  parentSession?: string;
  turns: HarnessTurn[];
};

export type HarnessSubagentResponse = { subagent: HarnessSubagent };

export type HarnessTurnsResponse = {
  turns: HarnessTurn[];
  /** What waits behind the live turn, first to run first. */
  queued: HarnessQueuedPrompt[];
};

/** A skill the harness can load; the composer's slash menu lists them. */
export type HarnessSkill = {
  name: string;
  description: string;
  /** project: under the working tree; home: the harness home directory. */
  source: "project" | "home";
};

export type HarnessSkillsResponse = { skills: HarnessSkill[] };

/** One completion of the composer's "@" path picker, spelled as the user typed the prefix. */
export type HarnessPath = {
  path: string;
  kind: "dir" | "file";
};

export type HarnessPathsResponse = { paths: HarnessPath[] };

/** One selectable value of a session config option. */
export type HarnessConfigChoice = {
  value: string;
  name: string;
  description?: string | null;
};

/** dsh groups model choices by provider route. */
export type HarnessConfigGroup = {
  groupId?: string;
  group?: string;
  name: string;
  options: HarnessConfigChoice[];
};

/**
 * A session config option as the Agent Client Protocol advertises it:
 * dsh serves "model" (grouped by provider) and "reasoning_effort".
 */
export type HarnessConfigOption = {
  id: string;
  name: string;
  category?: string | null;
  type: "select" | (string & {});
  currentValue: string;
  options: (HarnessConfigChoice | HarnessConfigGroup)[];
};

export type HarnessConfigResponse = {
  /** False when the agent has no live session; options are then empty. */
  running: boolean;
  options: HarnessConfigOption[];
};

export type HarnessConfigUpdateRequest = { configId: string; value: string };

/** Token counts as the harness logs them per model call. */
export type HarnessTokenCounts = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

/**
 * How a provider route authenticates: an API key in the server environment,
 * or a sign-in stored in dsh's credential store (a ChatGPT plan). A key is
 * metered, so a dollar budget applies; a grant is a plan, so its usage is a
 * share of rate-limit windows and no budget applies.
 */
export type HarnessProviderAuth =
  | { kind: "key"; env: string }
  | { kind: "grant"; record: string; label: string };

/** One provider route the harness can use, with what is known of its usage. */
export type HarnessUsageProvider = {
  /** dsh's provider route id: openai, deepseek, openai-codex, … */
  id: string;
  label: string;
  auth: HarnessProviderAuth;
  /** Whether the key is set in the server environment, or the sign-in is stored. */
  authenticated: boolean;
  /**
   * A plan's rate-limit windows, for a route billed by subscription
   * (ChatGPT for the openai-codex route): each bar is a share used, not a
   * dollar figure. `logged.usd` then reads as what the tokens would have
   * cost at API rates.
   */
  subscription?: HarnessSubscriptionUsage;
  /** Monthly budget from Settings, in USD; null when none is set. */
  budgetUsd: number | null;
  /** Month-to-date cost from the provider's own billing API, when it has one we can read. */
  billed?: { usd: number; since: string; source: string };
  /** Prepaid balance the provider reports (DeepSeek). */
  balance?: {
    currency: string;
    total: number;
    granted: number;
    toppedUp: number;
    available: boolean;
  };
  /** Dispatch's own count from the harness session logs, this month. */
  logged: {
    since: string;
    tokens: HarnessTokenCounts;
    /** Priced with the model table the harness ships; null when no price is known. */
    usd: number | null;
    models: { model: string; tokens: HarnessTokenCounts; usd: number | null }[];
  };
  /** Why the billing call gave nothing, when it failed. */
  error?: string;
};

export type HarnessSubscriptionWindow = {
  /** "primary" is the short window (5h on ChatGPT), "secondary" the weekly one. */
  id: "primary" | "secondary";
  label: string;
  usedPercent: number;
  windowSeconds: number | null;
  /** ISO time the window resets; null when the plan did not say. */
  resetsAt: string | null;
};

export type HarnessSubscriptionUsage = {
  /** The plan name the provider reports (plus, pro, team…); null when unknown. */
  plan: string | null;
  windows: HarnessSubscriptionWindow[];
  /** Pay-as-you-go credits beside the plan, when the provider reports them. */
  credits: { balance: number | null; unlimited: boolean } | null;
  /** True when the provider says the plan's limit is currently hit. */
  limitReached: boolean;
};

export type HarnessUsageResponse = {
  generatedAt: string;
  monthStart: string;
  providers: HarnessUsageProvider[];
  /** A session log was too large to count; the logged totals understate. */
  partial?: boolean;
};

/**
 * The provider routes the harness can run on: the one list the model
 * picker's auth filter, the usage dialog, and the budget settings derive
 * from. Ids are dsh's route ids. The ChatGPT route comes first because it
 * is the default route once its sign-in is stored.
 */
export const HARNESS_USAGE_PROVIDERS = [
  {
    id: "openai-codex",
    label: "ChatGPT (Codex)",
    auth: {
      kind: "grant",
      record: "llm-pi-ai/openai-codex",
      label: "ChatGPT sign-in",
    },
  },
  {
    id: "openai",
    label: "OpenAI",
    auth: { kind: "key", env: "OPENAI_API_KEY" },
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    auth: { kind: "key", env: "DEEPSEEK_API_KEY" },
  },
  {
    id: "anthropic",
    label: "Anthropic",
    auth: { kind: "key", env: "ANTHROPIC_API_KEY" },
  },
  {
    id: "google",
    label: "Gemini",
    auth: { kind: "key", env: "GEMINI_API_KEY" },
  },
] as const satisfies readonly {
  id: string;
  label: string;
  auth: HarnessProviderAuth;
}[];

export type HarnessProviderSpec = (typeof HARNESS_USAGE_PROVIDERS)[number];

export type HarnessUsageProviderId = HarnessProviderSpec["id"];

/** A metered provider: the ones a dollar budget applies to. */
export type HarnessBudgetProviderSpec = Extract<
  HarnessProviderSpec,
  { auth: { kind: "key" } }
>;

export type HarnessBudgetProviderId = HarnessBudgetProviderSpec["id"];

/** Whether a provider is metered by a key, and so takes a dollar budget. */
export function isHarnessBudgetProvider(
  p: HarnessProviderSpec
): p is HarnessBudgetProviderSpec {
  return p.auth.kind === "key";
}

export const HARNESS_BUDGET_PROVIDERS: readonly HarnessBudgetProviderSpec[] =
  HARNESS_USAGE_PROVIDERS.filter(isHarnessBudgetProvider);

/** The display label for a provider route id; the id itself when unknown. */
export function harnessProviderLabel(id: string): string {
  return HARNESS_USAGE_PROVIDERS.find((p) => p.id === id)?.label ?? id;
}

/** Monthly budgets in USD by metered provider id; a provider without a row has none. */
export type UsageBudgets = Partial<Record<HarnessBudgetProviderId, number>>;

export type UsageBudgetsResponse = { budgets: UsageBudgets };
