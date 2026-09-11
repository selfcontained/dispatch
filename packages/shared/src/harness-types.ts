import type { ChatAttachment } from "./chat-types.js";

export type HarnessPrompt = {
  source: "chat" | "launch" | "agent" | "system";
  text: string;
  senderName?: string;
  senderAgentId?: string;
  chatMessageId?: string;
  attachments: ChatAttachment[];
};

export type HarnessQueuedPrompt = HarnessPrompt & {
  id: string;
  createdAt: string;
};

export type HarnessQueueResponse = { queued: HarnessQueuedPrompt[] };

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
  publishesPlan: boolean;
  publishesModelOption: boolean;
  reportsUsage: boolean;
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

export const HARNESS_BUDGET_ENGINE_IDS: readonly HarnessEngineId[] =
  HARNESS_ENGINES.filter((e) => e.reportsCost).map((e) => e.id);

export type HarnessCommand = {
  name: string;
  description: string;
  input?: { hint: string } | null;
};

export type HarnessCommandsResponse = { commands: HarnessCommand[] };

export type HarnessUsageAgent = {
  agentId: string;
  name: string;
  tokens: number;
  costUsd: number | null;
};

export type HarnessUsageEngine = HarnessEngine & {
  tokens: number;
  costUsd: number | null;
  budgetUsd: number | null;
  agents: HarnessUsageAgent[];
};

export type HarnessUsageReport = {
  generatedAt: string;
  monthStart: string;
  engines: HarnessUsageEngine[];
};

export type HarnessAuthKind =
  | "subscription"
  | "api_key"
  | "oauth"
  | "configured"
  | "not_signed_in"
  | "unavailable";

/** Sanitized host-CLI authentication metadata. Never contains credentials. */
export type HarnessAuthStatus = {
  engineId: HarnessEngineId;
  kind: HarnessAuthKind;
  label: string;
  detail?: string;
};

export type HarnessAuthReport = {
  checkedAt: string;
  engines: HarnessAuthStatus[];
};

export type HarnessPlanWindow = {
  id: string;
  label: string;
  usedPercent: number;
  resetsAt: string | null;
};

export type HarnessPlanSpend = {
  used: number;
  limit: number;
  currency: string;
};

export type HarnessProviderPlan = {
  engineId: HarnessEngineId;
  plan: string | null;
  observedAt: string | null;
  windows: HarnessPlanWindow[];
  spend?: HarnessPlanSpend;
  unavailableReason?: string;
};

export type HarnessProviderUsageReport = {
  checkedAt: string;
  providers: HarnessProviderPlan[];
};

export type HarnessPath = {
  path: string;
  kind: "dir" | "file";
};

export type HarnessPathsResponse = { paths: HarnessPath[] };

export type HarnessConfigChoice = {
  value: string;
  name: string;
  description?: string | null;
};

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
  running: boolean;
  sessionStartedAt?: string;
  options: HarnessConfigOption[];
};

export type HarnessConfigUpdateRequest = { configId: string; value: string };

export type UsageBudgets = Partial<Record<HarnessEngineId, number>>;

export type UsageBudgetsResponse = { budgets: UsageBudgets };
