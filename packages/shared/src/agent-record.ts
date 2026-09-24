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

export type AgentStatus =
  | "creating"
  | "running"
  | "stopping"
  | "stopped"
  | "archiving"
  | "error"
  | "unknown";

export type AgentRole = "standard" | "review" | "assisted_update";

/**
 * What the agent is doing now, derived by the server each time the record is
 * read (runtime busy state, open questions, the last turn).
 */
export type AgentActivity =
  | "starting"
  | "working"
  | "waiting"
  | "idle"
  | "blocked"
  | "stopped";

export type SetupPhase = "worktree" | "env" | "deps" | "session" | null;

export type ArchivePhase =
  | "stopping"
  | "worktree-check"
  | "worktree-cleanup"
  | "finalizing"
  | null;

export type WorktreeCleanupMode = "auto" | "keep" | "force";

export type AgentGitContext = {
  repoRoot: string;
  branch: string;
  worktreePath: string;
  worktreeName: string;
  isWorktree: boolean;
  repoIconPath?: string | null;
};

export type AgentCurrentTurn = {
  blockId: string;
  threadId: string | null;
};

export type AgentRecord = {
  id: string;
  name: string;
  type: AgentType;
  role: AgentRole;
  status: AgentStatus;
  cwd: string;
  /** Directory requested at creation, before any managed worktree changed cwd. */
  launchCwd?: string | null;
  worktreePath: string | null;
  worktreeBranch: string | null;
  simulatorUdid: string | null;
  filesDir: string | null;
  agentArgs: string[];
  model: string | null;
  fullAccess: boolean;
  setupPhase: SetupPhase;
  archivePhase: ArchivePhase;
  archiveCleanupMode: WorktreeCleanupMode | null;
  lastError: string | null;
  /** Live host reattachment progress; absent for agents with a healthy connection. */
  reconnect?: {
    phase: "trying" | "waiting";
    nextRetryAt: string | null;
  } | null;
  activity: AgentActivity;
  /**
   * The turn the agent is running right now, while `activity` is
   * `working`: its block, and the thread that block sits in (null when it
   * is in the main column). Null otherwise.
   */
  currentTurn: AgentCurrentTurn | null;
  gitContext: AgentGitContext | null;
  gitContextStale: boolean;
  gitContextUpdatedAt: string | null;
  persona: string | null;
  parentAgentId: string | null;
  /**
   * The agent that ran launch_agent to create this one. Set for every agent-originated launch, including
   * `child: false` launches whose `parentAgentId` is deliberately null.
   */
  launchedByAgentId: string | null;
  personaContext: string | null;
  reviewAgentType: AgentType | null;
  baseBranch: string | null;
  templateId: string | null;
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
