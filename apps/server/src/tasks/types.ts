/**
 * Task wire types — what the API returns and the web client reads. Kept
 * dependency-free so `apps/web` can `import type` them directly, the way
 * `brain/types.ts` is shared.
 *
 * A task belongs to a project and sits in one of the project's columns. It
 * outlives the agents that work it: every assignment is a `TaskAgent`, the
 * current one is `assignedAgentId`.
 */

export type TaskAgentType = "claude" | "codex" | "opencode";

/** What a column does when a task enters it: launch a template for it. */
export type TaskColumnTrigger = {
  templateId: string;
  /** Resolved for board reads; absent from the stored trigger. */
  templateName?: string | null;
  /** Override the template's agent type; null keeps the template's. */
  agentType: TaskAgentType | null;
  /** Override the template's model; null keeps the template's. */
  model: string | null;
  /** Assign the launched agent to the task and show it on the card. */
  assign: boolean;
  /** Also fire when a task is created directly in this column. */
  fireOnCreate: boolean;
};

export type TaskColumn = {
  id: string;
  projectId: string;
  /** Stable slug, unique within the project; what agents name in `column`. */
  key: string;
  name: string;
  position: number;
  /** Entering this column sets `completedAt`; leaving it clears it. */
  isDone: boolean;
  trigger: TaskColumnTrigger | null;
  createdAt: string;
  updatedAt: string;
};

export type TaskActor =
  | { kind: "user" }
  | { kind: "agent"; agentId: string }
  | { kind: "system" };

export type TaskLink = {
  kind: "pr" | "branch" | "url";
  url: string | null;
  label: string;
};

export type Task = {
  id: string;
  projectId: string;
  columnId: string;
  title: string;
  /** Markdown; doubles as the briefing a launched agent receives. */
  body: string;
  /** Manual order within the column; lower first. */
  position: number;
  assignedAgentId: string | null;
  links: TaskLink[];
  createdBy: TaskActor;
  /**
   * The current column entry's last trigger failure not followed by a
   * successful launch; a move or successful launch clears the badge.
   */
  latestFailure: { reason: string; at: string } | null;
  /** The current column trigger is starting an agent. */
  launching: { templateId: string; at: string } | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type TaskAgentRole = "trigger" | "manual" | "self";

/** One agent's assignment to a task; history is kept after reassignment. */
export type TaskAgent = {
  taskId: string;
  agentId: string;
  role: TaskAgentRole;
  /** The column whose trigger launched it, for `role: "trigger"`. */
  columnId: string | null;
  assignedAt: string;
};

export type TaskEventKind =
  | "created"
  | "updated"
  | "moved"
  | "assigned"
  | "unassigned"
  | "trigger_launching"
  | "trigger_launched"
  | "trigger_failed"
  | "agent_launched"
  | "agent_removed"
  | "link_added";

export type TaskEvent = {
  id: string;
  taskId: string;
  kind: TaskEventKind;
  actor: TaskActor;
  /**
   * Per kind: moved {fromColumnId, toColumnId}; assigned/unassigned/
   * agent_removed {agentId, role}; trigger_launching {templateId};
   * trigger_launched/agent_launched
   * {agentId, templateId};
   * trigger_failed {templateId, reason}; link_added {link}; updated {fields}.
   */
  data: Record<string, unknown>;
  createdAt: string;
};

export type TaskAttachment = {
  id: number;
  name: string;
  mimeType: string;
  size: number;
  url: string;
};

export type TaskDetail = Task & {
  attachments: TaskAttachment[];
  agents: TaskAgent[];
  events: TaskEvent[];
};

export type TaskBoard = {
  projectId: string;
  columns: TaskColumn[];
  tasks: Task[];
};

export type CreateTaskInput = {
  projectId: string;
  title: string;
  body?: string;
  /** Defaults to the project's first column. */
  columnId?: string;
  /** Defaults to the top of the column. */
  position?: number;
};

export type UpdateTaskInput = {
  title?: string;
  body?: string;
  /** A change here is a move and may fire the destination column's trigger. */
  columnId?: string;
  position?: number;
  assignedAgentId?: string | null;
  links?: TaskLink[];
  /**
   * A move into a trigger column while the assigned agent is still running
   * is refused with 409 `agent_working` unless this is set.
   */
  confirmRelaunch?: boolean;
};

export type LaunchTaskAgentInput = {
  templateId: string;
  agentType?: TaskAgentType | null;
  model?: string | null;
};

export type CreateTaskColumnInput = {
  name: string;
  key?: string;
  position?: number;
  isDone?: boolean;
  trigger?: TaskColumnTrigger | null;
};

export type UpdateTaskColumnInput = Partial<CreateTaskColumnInput>;
