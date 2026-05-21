export type AgentStatus =
  | "creating"
  | "running"
  | "stopping"
  | "stopped"
  | "archiving"
  | "error"
  | "unknown";

export type AgentPin = {
  label: string;
  value: string;
  type: "string" | "url" | "port" | "code" | "pr" | "filename" | "markdown";
};

export type Agent = {
  id: string;
  name: string;
  type?: string;
  role?: "standard" | "assisted_update";
  status: AgentStatus;
  cwd: string;
  worktreePath: string | null;
  worktreeBranch: string | null;
  tmuxSession: string | null;
  agentArgs: string[];
  fullAccess: boolean;
  setupPhase?: "worktree" | "env" | "deps" | "session" | null;
  archivePhase?:
    | "stopping"
    | "worktree-check"
    | "worktree-cleanup"
    | "finalizing"
    | null;
  lastError?: string | null;
  latestEvent?: {
    type: "working" | "blocked" | "waiting_user" | "done" | "idle";
    message: string;
    updatedAt: string;
    metadata?: Record<string, unknown> | null;
  } | null;
  pins?: AgentPin[];
  mediaDir: string | null;
  gitContext?: {
    repoRoot: string;
    branch: string;
    worktreePath: string;
    worktreeName: string;
    isWorktree: boolean;
    repoIconPath?: string | null;
  } | null;
  persona?: string | null;
  parentAgentId?: string | null;
  personaContext?: string | null;
  reviewAgentType?: "codex" | "claude" | "opencode" | "cursor" | null;
  review?: {
    status: string;
    message: string | null;
    verdict: string | null;
    summary: string | null;
    filesReviewed: string[] | null;
    roundNumber: number;
    allowRecheck: boolean;
    updatedAt: string;
    resolution: {
      summary: string;
      resolutionCommit: string | null;
      submittedAt: string;
      roundNumber: number;
    } | null;
  } | null;
  baseBranch?: string | null;
  templateId?: string | null;
  autoReview?: boolean;
  hasStream?: boolean;
  createdAt: string;
  updatedAt: string;
};

export type FeedbackItem = {
  id: number;
  agentId: string;
  severity: "critical" | "high" | "medium" | "low" | "info";
  filePath: string | null;
  lineNumber: number | null;
  description: string;
  suggestion: string | null;
  mediaRef: string | null;
  status: "open" | "dismissed" | "forwarded" | "fixed" | "ignored";
  resolutionReason: string | null;
  resolutionCommit: string | null;
  roundNumber: number;
  respondsToFeedbackId: number | null;
  resolvedAt: string | null;
  createdAt: string;
};

export type MediaFile = {
  name: string;
  size: number;
  updatedAt: string;
  url: string;
  seen?: boolean;
  source?: "screenshot" | "stream" | "simulator" | "text" | "user";
  description?: string | null;
};

export type ConnState = "connected" | "reconnecting" | "disconnected";
export type ServiceState = "ok" | "down" | "checking";
export type AgentVisualState = "stopped" | "idle" | "active";
export type AuthState = "loading" | "needs-login" | "authenticated" | "error";

export type TerminalCopyMode = "live" | "copy" | "exiting";

export type TerminalUiState = {
  copyMode: TerminalCopyMode;
  lastObservedAt: number;
};

export type DiffStats = {
  added: number;
  deleted: number;
  files: number;
  computedAt: number;
};
