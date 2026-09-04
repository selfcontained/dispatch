/**
 * Server-side agent types.
 *
 * The wire contract itself (`AgentRecord` and its member unions) lives in
 * `@dispatch/shared` so the web client agrees on it without reaching into the
 * server. It is re-exported here because the modules that already import these
 * names from this path — and, through `agents/manager.ts`, the route layer —
 * keep resolving unchanged.
 */

import type { AgentLatestEventType, AgentRecord } from "@dispatch/shared";

export type {
  AgentGitContext,
  AgentLatestEvent,
  AgentLatestEventType,
  AgentPin,
  AgentRecord,
  AgentRole,
  AgentStatus,
  ArchivePhase,
  SetupPhase,
  WorktreeCleanupMode,
} from "@dispatch/shared";

// Re-exported so the ~15 modules that already import AgentType from here keep
// working, while the member list itself lives in one place.
export type { AgentType } from "../shared/agent-types.js";

export type { PinShortcutVariant, PinType } from "../pins.js";

// Canonical home is `shared/git/worktree-status.ts` — this re-export is
// here so existing importers (manager.ts's public surface, and through
// it routes/agents.ts) keep resolving without churn.
export type { WorktreeStatus } from "../shared/git/worktree-status.js";

export type AgentTerminalAccess =
  | { mode: "tmux"; sessionName: string }
  | { mode: "inert"; message: string };

/** Where a prompt for an agent is delivered (see AgentManager.getPromptTarget). */
export type AgentPromptTarget =
  | { kind: "dsh"; busy: boolean }
  | { kind: "tmux"; sessionName: string }
  | { kind: "inert"; message: string };

export type AgentLatestEventInput = {
  type: AgentLatestEventType;
  message: string;
  metadata?: Record<string, unknown>;
};

export type AgentEventListener = (agent: AgentRecord) => void;
