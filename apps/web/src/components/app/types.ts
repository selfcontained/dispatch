export type AgentStatus = "creating" | "running" | "stopping" | "stopped" | "error" | "unknown";

export type Agent = {
  id: string;
  name: string;
  type?: string;
  status: AgentStatus;
  cwd: string;
  worktreePath: string | null;
  worktreeBranch: string | null;
  tmuxSession: string | null;
  agentArgs: string[];
  fullAccess: boolean;
  setupPhase?: "worktree" | "env" | "deps" | "session" | null;
  lastError?: string | null;
  latestEvent?: {
    type: "working" | "blocked" | "waiting_user" | "done" | "idle";
    message: string;
    updatedAt: string;
    metadata?: Record<string, unknown> | null;
  } | null;
  mediaDir: string | null;
  gitContext?: {
    repoRoot: string;
    branch: string;
    worktreePath: string;
    worktreeName: string;
    isWorktree: boolean;
  } | null;
  persona?: string | null;
  parentAgentId?: string | null;
  personaContext?: string | null;
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
  createdAt: string;
};

export type MediaFile = {
  name: string;
  size: number;
  updatedAt: string;
  url: string;
  seen?: boolean;
  source?: "screenshot" | "stream" | "simulator" | "text";
  description?: string | null;
};

export type ConnState = "connected" | "reconnecting" | "disconnected";
export type ServiceState = "ok" | "down" | "checking";
export type AgentVisualState = "stopped" | "idle" | "active";
export type AuthState = "loading" | "needs-login" | "authenticated";
