export type AgentStatus =
  | "creating"
  | "running"
  | "stopping"
  | "stopped"
  | "archiving"
  | "error"
  | "unknown";

// Re-exported so the ~15 modules that already import AgentType from here keep
// working, while the member list itself lives in one place.
export type { AgentType } from "../shared/agent-types.js";
import type { AgentType } from "../shared/agent-types.js";

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

export type { PinShortcutVariant, PinType } from "../pins.js";
import type { PinShortcutVariant, PinType } from "../pins.js";

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

export type WorktreeCleanupMode = "auto" | "keep" | "force";

// Canonical home is `shared/git/worktree-status.ts` — this re-export is
// here so existing importers (manager.ts's public surface, and through
// it routes/agents.ts) keep resolving without churn.
export type { WorktreeStatus } from "../shared/git/worktree-status.js";

export type AgentTerminalAccess =
  | { mode: "tmux"; sessionName: string }
  | { mode: "inert"; message: string };

export type AgentLatestEventInput = {
  type: AgentLatestEventType;
  message: string;
  metadata?: Record<string, unknown>;
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
  personaContext: string | null;
  reviewAgentType: AgentType | null;
  submittedReviewId: number | null;
  baseBranch: string | null;
  templateId: string | null;
  autoReview: boolean;
  cliSessionId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AgentEventListener = (agent: AgentRecord) => void;
