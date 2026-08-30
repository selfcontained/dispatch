import type { DiffStats as ServerDiffStats } from "@dispatch/shared";

export type AgentStatus =
  | "creating"
  | "running"
  | "stopping"
  | "stopped"
  | "archiving"
  | "error"
  | "unknown";

export type PinShortcutVariant = "default" | "primary" | "destructive";

export type AgentPin = {
  id?: string;
  label: string;
  value: string;
  type:
    | "string"
    | "url"
    | "port"
    | "code"
    | "pr"
    | "filename"
    | "markdown"
    | "shortcut";
  /**
   * Caption rendered under a shortcut pin's button — inline markdown.
   * Shortcut pins only.
   */
  caption?: string;
  /** Icon name for a shortcut pin's button. Shortcut pins only. */
  icon?: string;
  /**
   * Renders this pin under a shared heading with every other pin carrying the
   * same group name. Any pin type may set it.
   */
  group?: string;
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
  model: string | null;
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
  jobRun?: {
    continuationEnabled: boolean;
    iteration: number | null;
    maxIterations: number | null;
  } | null;
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

// Wire payloads shared with the server — re-exported from here so the
// components that already import them from this module keep resolving.
export type {
  InjectionHoldState,
  TerminalCopyMode,
  TerminalUiState,
} from "@dispatch/shared";

/**
 * Wire shape of the server's diff stats. Derived from the shared contract
 * rather than restated so a field can't be added on one side and missed — the
 * one divergence is deliberate: `excludingTests` is optional over the wire,
 * because a server that predates it can still be pushing stats over SSE while
 * a newer bundle is loaded, and a badge that falls back to the unfiltered
 * totals beats one that renders NaN.
 */
export type DiffStats = Omit<ServerDiffStats, "excludingTests"> &
  Partial<Pick<ServerDiffStats, "excludingTests">>;
