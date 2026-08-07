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
  role?: "standard" | "review" | "assisted_update";
  status: AgentStatus;
  cwd: string;
  worktreePath: string | null;
  worktreeBranch: string | null;
  tmuxSession: string | null;
  agentArgs: string[];
  model?: string | null;
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
  submittedReviewId?: number | null;
  baseBranch?: string | null;
  templateId?: string | null;
  autoReview?: boolean;
  hasStream?: boolean;
  createdAt: string;
  updatedAt: string;
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
