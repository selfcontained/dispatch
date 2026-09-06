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

/** One provider key the harness can use, with what is known of its usage. */
export type HarnessUsageProvider = {
  /** dsh's provider route id: openai, deepseek, … */
  id: string;
  label: string;
  /** The env var holding the key. */
  keyEnv: string;
  /** Whether the key is set in the server environment. */
  hasKey: boolean;
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

export type HarnessUsageResponse = {
  generatedAt: string;
  monthStart: string;
  providers: HarnessUsageProvider[];
  /** A session log was too large to count; the logged totals understate. */
  partial?: boolean;
};

/** The provider keys the harness can run on, as the usage dialog and budget settings list them. */
export const HARNESS_USAGE_PROVIDERS = [
  { id: "openai", label: "OpenAI", keyEnv: "OPENAI_API_KEY" },
  { id: "deepseek", label: "DeepSeek", keyEnv: "DEEPSEEK_API_KEY" },
  { id: "anthropic", label: "Anthropic", keyEnv: "ANTHROPIC_API_KEY" },
  { id: "google", label: "Gemini", keyEnv: "GEMINI_API_KEY" },
] as const;

export type HarnessUsageProviderId =
  (typeof HARNESS_USAGE_PROVIDERS)[number]["id"];

/** Monthly budgets in USD by provider id; a provider without a row has none. */
export type UsageBudgets = Partial<Record<HarnessUsageProviderId, number>>;

export type UsageBudgetsResponse = { budgets: UsageBudgets };
