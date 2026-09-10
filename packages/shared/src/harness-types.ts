import type { ChatAttachment } from "./chat-types.js";

/**
 * A Dispatch Harness agent's wire types that are not feed entries: the
 * prompt and queue shapes, the engine table, session config, the engine's
 * slash commands, usage and the "@" path picker. A turn itself is a
 * `ChatTurnEntry` in `chat-types.ts`.
 */

export type HarnessPrompt = {
  source: "chat" | "launch" | "agent" | "system";
  text: string;
  /** Cross-agent messages: who sent it. */
  senderName?: string;
  /** Cross-agent messages: which agent sent it. */
  senderAgentId?: string;
  chatMessageId?: string;
  attachments: ChatAttachment[];
};

/**
 * A prompt waiting behind the running turn. `id` addresses it on the queue
 * routes (the chat message id for a chat prompt).
 */
export type HarnessQueuedPrompt = HarnessPrompt & {
  id: string;
  createdAt: string;
};

/** `GET /api/v1/agents/:id/harness/queue`: what waits behind the live turn. */
export type HarnessQueueResponse = { queued: HarnessQueuedPrompt[] };

/**
 * The engines the harness can run. One row per ACP agent; the create
 * dialog, the usage dialog, the budget settings, and the starting screen's
 * login message all read from here. Order is create-dialog order.
 */
export const HARNESS_ENGINE_IDS = [
  "claude",
  "codex",
  "gemini",
  "opencode",
] as const;
export type HarnessEngineId = (typeof HARNESS_ENGINE_IDS)[number];

export type HarnessEngine = {
  id: HarnessEngineId;
  label: string;
  /** Sends ACP `plan` / `plan_update`, so the tasks strip has something to show. */
  publishesPlan: boolean;
  /** Publishes a `model` config option, so `/model` can switch mid-session. */
  publishesModelOption: boolean;
  /** Sends `usage_update` at all. */
  reportsUsage: boolean;
  /** Its `usage_update` carries a USD `cost`. */
  reportsCost: boolean;
  /** What to run as the service user when the engine reports `auth_required`. */
  loginCommand: string;
};

export const HARNESS_ENGINES: readonly HarnessEngine[] = [
  {
    id: "claude",
    label: "Claude Code",
    publishesPlan: true,
    publishesModelOption: true,
    reportsUsage: true,
    reportsCost: true,
    loginCommand: "claude /login",
  },
  {
    id: "codex",
    label: "Codex",
    publishesPlan: true,
    publishesModelOption: true,
    reportsUsage: true,
    reportsCost: false,
    loginCommand: "codex login --device-auth",
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    publishesPlan: false,
    publishesModelOption: false,
    reportsUsage: false,
    reportsCost: false,
    loginCommand: "NO_BROWSER=true gemini",
  },
  {
    id: "opencode",
    label: "OpenCode",
    publishesPlan: false,
    publishesModelOption: true,
    reportsUsage: true,
    reportsCost: true,
    loginCommand: "opencode auth login",
  },
];

export const DEFAULT_HARNESS_MODEL = "claude/default";

/**
 * The engine named by a model id's first segment.
 *
 * An agent with no model stored runs the default engine, so a null,
 * undefined or empty id answers with the engine `DEFAULT_HARNESS_MODEL`
 * names: the readers that derive an engine from the model (the usage report,
 * the pane's engine chip and login hint) then see the engine the child will
 * actually be. Null is only for an id that names no engine: one with no
 * `engine/` segment (no slash, or a leading slash) or an unknown engine.
 */
export function harnessEngineOf(
  modelId: string | null | undefined
): HarnessEngine | null {
  const id = modelId || DEFAULT_HARNESS_MODEL;
  const slash = id.indexOf("/");
  if (slash <= 0) return null;
  return HARNESS_ENGINES.find((e) => e.id === id.slice(0, slash)) ?? null;
}

/** Engines a USD budget applies to: the ones whose usage carries a cost. */
export const HARNESS_BUDGET_ENGINE_IDS: readonly HarnessEngineId[] =
  HARNESS_ENGINES.filter((e) => e.reportsCost).map((e) => e.id);

/** A slash command the engine advertises (`available_commands_update`). */
export type HarnessCommand = {
  name: string;
  description: string;
  input?: { hint: string } | null;
};

export type HarnessCommandsResponse = { commands: HarnessCommand[] };

export type HarnessUsageAgent = {
  agentId: string;
  name: string;
  /** Tokens this month from agent_token_usage (input + output + cache). */
  tokens: number;
  /** USD the engine reported for its sessions this month; null when it reports none. */
  costUsd: number | null;
};

export type HarnessUsageEngine = HarnessEngine & {
  tokens: number;
  costUsd: number | null;
  /** From Settings, Agents, Usage budgets; only cost-reporting engines take one. */
  budgetUsd: number | null;
  agents: HarnessUsageAgent[];
};

/** The month's usage by engine. */
export type HarnessUsageReport = {
  generatedAt: string;
  monthStart: string;
  engines: HarnessUsageEngine[];
};

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

/** The harness groups model choices by provider route. */
export type HarnessConfigGroup = {
  groupId?: string;
  group?: string;
  name: string;
  options: HarnessConfigChoice[];
};

/**
 * A session config option as the Agent Client Protocol advertises it:
 * the harness serves "model" (grouped by provider) and "reasoning_effort".
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

/** Monthly budgets in USD by engine id; an engine without a row has none. */
export type UsageBudgets = Partial<Record<HarnessEngineId, number>>;

export type UsageBudgetsResponse = { budgets: UsageBudgets };
