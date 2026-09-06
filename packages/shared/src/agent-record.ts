/**
 * The agent row as it goes over the wire.
 *
 * `AgentRecord` is the payload of the `snapshot` and `agent.upsert` SSE events
 * and of every `/api/v1/agents` response, so both apps have to agree on it.
 * The server's `apps/server/src/agents/types.ts` re-exports everything here so
 * its existing importers are untouched; the web client derives its lenient
 * `Agent` view from it in `apps/web/src/components/app/types.ts`.
 */

import type { AgentType } from "./agent-types.js";
import type { PinShortcutVariant, PinType } from "./pin-types.js";

export type AgentStatus =
  | "creating"
  | "running"
  | "stopping"
  | "stopped"
  | "archiving"
  | "error"
  | "unknown";

export type AgentRole = "standard" | "review" | "assisted_update";

export type AgentLatestEventType =
  | "working"
  | "blocked"
  | "waiting_user"
  | "done"
  | "idle";

export type SetupPhase = "worktree" | "env" | "deps" | "session" | null;

export type ArchivePhase =
  | "stopping"
  | "worktree-check"
  | "worktree-cleanup"
  | "finalizing"
  | null;

export type WorktreeCleanupMode = "auto" | "keep" | "force";

export type AgentPin = {
  id?: string;
  label: string;
  value: string;
  type: PinType;
  /** Inline-markdown caption rendered under the pin. Any pin type. */
  caption?: string;
  /** Renders this pin under a shared heading with pins of the same group. */
  group?: string;
  /** Icon name for a shortcut pin's button. Shortcut pins only. */
  icon?: string;
  /** Button styling for a shortcut pin. Shortcut pins only. */
  variant?: PinShortcutVariant;
  /** When true, clicking a shortcut pin asks for confirmation first. */
  confirm?: boolean;
  /**
   * When true, the shortcut renders non-interactive instead of being
   * deleted — for an action that has become temporarily or permanently
   * unavailable but is still worth showing (e.g. a launch pin once its
   * builder is already running). `caption` doubles as the reason shown in
   * place of its normal subtitle. Shortcut pins only.
   */
  disabled?: boolean;
};

export type AgentLatestEvent = {
  type: AgentLatestEventType;
  message: string;
  updatedAt: string;
  metadata: Record<string, unknown> | null;
};

export type AgentGitContext = {
  repoRoot: string;
  branch: string;
  worktreePath: string;
  worktreeName: string;
  isWorktree: boolean;
  repoIconPath?: string | null;
};

export type AgentRecord = {
  id: string;
  name: string;
  type: AgentType;
  role: AgentRole;
  status: AgentStatus;
  cwd: string;
  worktreePath: string | null;
  worktreeBranch: string | null;
  tmuxSession: string | null;
  simulatorUdid: string | null;
  mediaDir: string | null;
  agentArgs: string[];
  model: string | null;
  fullAccess: boolean;
  setupPhase: SetupPhase;
  archivePhase: ArchivePhase;
  archiveCleanupMode: WorktreeCleanupMode | null;
  lastError: string | null;
  latestEvent: AgentLatestEvent | null;
  pins: AgentPin[];
  gitContext: AgentGitContext | null;
  gitContextStale: boolean;
  gitContextUpdatedAt: string | null;
  persona: string | null;
  parentAgentId: string | null;
  /**
   * The agent that ran dispatch_launch_agent / dispatch_launch_persona to
   * create this one. Set for every agent-originated launch, including
   * `child: false` launches whose `parentAgentId` is deliberately null.
   */
  launchedByAgentId: string | null;
  personaContext: string | null;
  reviewAgentType: AgentType | null;
  submittedReviewId: number | null;
  baseBranch: string | null;
  templateId: string | null;
  autoReview: boolean;
  /** Present when this agent was spawned for a job run. */
  jobRun?: {
    continuationEnabled: boolean;
    iteration: number | null;
    maxIterations: number | null;
  } | null;
  cliSessionId: string | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * The agent row as it goes out on the `snapshot` and `agent.upsert` SSE
 * events: every publish site runs the record through the server's
 * `withStreamFlag` first, so `hasStream` is always present on the stream.
 * REST responses carry it too, but those are separate contracts — see
 * `apps/server/src/routes/agents/`.
 */
export type StreamedAgentRecord = AgentRecord & { hasStream: boolean };
