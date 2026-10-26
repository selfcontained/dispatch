import { taskAgentName } from "@dispatch/shared";
import { SESSION_RENAME_ASK } from "../shared/lib/agent-strings.js";
import path from "node:path";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { timestampFileName } from "../agents/file-seed.js";
import { fileMetadataFromBuffer } from "../files/metadata.js";
import {
  MAX_STARTUP_FILE_COUNT,
  startupFileUpload,
  validateStartupLinks,
  type StartupFileUpload,
} from "../routes/agent-startup.js";
import type { TaskAttachment } from "./types.js";
import type { FastifyBaseLogger } from "fastify";
import type { Pool } from "pg";

import { AGENT_TYPES, type AgentType } from "../agent-type-settings.js";
import type { AgentRecord } from "../agents/types.js";
import type { StreamService, TaskStreamRoot } from "../chat/service.js";
import { ProjectStore, type ProjectRecord } from "../projects/store.js";
import { validateAgentModel } from "../shared/agent-models.js";
import { errorMessage } from "../shared/lib/error-message.js";
import type { TemplateRecord } from "../templates/store.js";
import { agentTaskProject } from "./agent-scope.js";
import { newTaskId, TaskStore, type TaskPatch } from "./store.js";
import type {
  CreateTaskColumnInput,
  CreateTaskInput,
  LaunchTaskAgentInput,
  Task,
  TaskActor,
  TaskAgentRole,
  TaskBoard,
  TaskColumn,
  TaskColumnTrigger,
  TaskDetail,
  TaskLink,
  UpdateTaskInput,
} from "./types.js";

/** An error a route answers with `status` and, when set, a `code`. */
export class TaskError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly extra?: Record<string, unknown>
  ) {
    super(message);
    this.name = "TaskError";
  }
}

const notFound = (what: string) => new TaskError(`${what} not found.`, 404);
const invalid = (message: string) => new TaskError(message, 400);

export const DEFAULT_TASK_COLUMNS: ReadonlyArray<{
  key: string;
  name: string;
  isDone: boolean;
}> = [
  { key: "backlog", name: "Backlog", isDone: false },
  { key: "ready", name: "Ready", isDone: false },
  { key: "in_progress", name: "In progress", isDone: false },
  { key: "in_review", name: "In review", isDone: false },
  { key: "done", name: "Done", isDone: true },
];

/**
 * Who is acting. An agent carries its access ceiling: without `fullAccess`
 * it is restricted and cannot start a full-access template. People are
 * trusted.
 */
export type TaskCaller =
  | { kind: "user" }
  | { kind: "system" }
  | { kind: "agent"; agentId: string; fullAccess?: boolean };

export const RESTRICTED_LAUNCH_REASON =
  "restricted agent cannot launch a full-access template";

function isRestricted(caller: TaskCaller): boolean {
  return caller.kind === "agent" && caller.fullAccess !== true;
}

/** The caller as the task's history records it. */
function actorOf(caller: TaskCaller): TaskActor {
  return caller.kind === "agent"
    ? { kind: "agent", agentId: caller.agentId }
    : { kind: caller.kind };
}

/** Agent statuses that count as "still working" for the relaunch guard. */
const WORKING_STATUSES = new Set(["running", "creating"]);

export const TASK_EVENTS_DETAIL_LIMIT = 200;

export type TaskAgentInfo = {
  id: string;
  name: string;
  status: string;
  projectId?: string | null;
  cwd?: string | null;
  worktreePath?: string | null;
  workspacePath?: string | null;
  baseBranch?: string | null;
};

export type TaskLaunchRequest = {
  name?: string;
  templateId: string;
  projectId: string;
  args: Record<string, string>;
  /** Appended after the rendered template, the way launch_agent appends free text. */
  appendix?: string;
  agentType?: AgentType;
  model?: string | null;
};

export type TaskServiceDeps = {
  pool: Pool;
  watches?: {
    schedule(taskId: string): void;
    cancel(taskId: string, agentId?: string): void;
  };
  filesRoot?: string;
  getAgent: (agentId: string) => Promise<TaskAgentInfo | null>;
  getTemplate: (templateId: string) => Promise<TemplateRecord | null>;
  /** Launches a top-level agent from a template; resolves to the new agent. */
  launchTemplate: (input: TaskLaunchRequest) => Promise<AgentRecord>;
  chat: Pick<
    StreamService,
    | "sendUserPost"
    | "post"
    | "closeStream"
    | "releaseStream"
    | "withdrawDeliveries"
  >;
  publishUiEvent: (event: {
    type: "task.changed";
    projectId: string;
    taskId?: string;
  }) => void;
  log: Pick<FastifyBaseLogger, "warn" | "info">;
};

/** A trigger as callers send it: everything but the template defaults. */
export type TaskColumnTriggerInput = Partial<TaskColumnTrigger> & {
  templateId: string;
};

type ColumnInput = Omit<CreateTaskColumnInput, "trigger"> & {
  trigger?: TaskColumnTriggerInput | null;
};

/** Lowercase slug: letters, digits and underscores. */
export function slugifyColumnKey(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

const KEY_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

/** A board column as the briefing describes it, in board order. */
export type BriefingColumn = Pick<TaskColumn, "key" | "name" | "isDone"> & {
  /**
   * What entering it launches: the trigger's template name, or null when
   * that template is gone (the trigger fails). Null when it has no trigger.
   */
  trigger: { templateName: string | null } | null;
};

/**
 * `backlog → ready (you are here) → in_review (launches "Code review") →
 * done (completes the task)`: the keys an agent moves the task with.
 */
function columnsLine(columns: BriefingColumn[], currentKey: string): string {
  return columns
    .map((column) => {
      const notes = [
        ...(column.key === currentKey ? ["you are here"] : []),
        ...(column.trigger === null
          ? []
          : column.trigger.templateName === null
            ? ["its trigger's template is missing, so nothing launches"]
            : [`launches "${column.trigger.templateName}"`]),
        ...(column.isDone ? ["completes the task"] : []),
      ];
      return notes.length > 0
        ? `${column.key} (${notes.join("; ")})`
        : column.key;
    })
    .join(" → ");
}

export function buildTaskBriefing(input: {
  task: Pick<Task, "id" | "title" | "body" | "links">;
  project: Pick<ProjectRecord, "name" | "repoRoot">;
  column: Pick<TaskColumn, "key" | "name">;
  columns: BriefingColumn[];
  attachments?: Array<{ name: string; mimeType: string; path: string }>;
}): string {
  const { task, project, column, columns } = input;
  const links =
    task.links.length > 0
      ? "\n" +
        task.links
          .map((link) =>
            link.url ? `- ${link.label}: ${link.url}` : `- ${link.label}`
          )
          .join("\n")
      : " none";
  return [
    "## Dispatch task",
    `As your first act, please ${SESSION_RENAME_ASK} for this task.`,
    `Task: ${task.id} — ${task.title}`,
    `Project: ${project.name} (${project.repoRoot})`,
    `Column: ${column.name}`,
    `Conversation: stream ${task.id} (the task's own stream; people and the task's agents post there)`,
    `Links:${links}`,
    ...(input.attachments?.length
      ? [
          "Attachments:",
          ...input.attachments.map(
            (file) => `- ${file.name} (${file.mimeType}) — ${file.path}`
          ),
        ]
      : []),
    "",
    task.body.trim() || "(no description)",
    "",
    `Columns: ${columnsLine(columns, column.key)}`,
    `Move it with task_update({ id, column: "<key>" }) as the work changes state; moving into a column with a trigger launches that agent. Add PR links with task_update({ id, links: [...] }). Posts from the task's conversation reach you as DISPATCH POSTs naming the task; answer in place, or with post({ replyTo }) on one of its ids. Post progress there with task_comment.`,
  ].join("\n");
}

/** The block that tells an agent it has the task, posted in the task's stream. */
export function assignmentText(task: Pick<Task, "id" | "title">): string {
  return `You're assigned to task ${task.id} — ${task.title}. This stream is the task's conversation; reply here.`;
}

function sameLink(a: TaskLink, b: TaskLink): boolean {
  return a.url !== null || b.url !== null
    ? a.url === b.url
    : a.label === b.label;
}

/** Appends `incoming` to `existing`, skipping links already there (by url). */
export function mergeLinks(
  existing: TaskLink[],
  incoming: TaskLink[]
): { links: TaskLink[]; added: TaskLink[] } {
  const links = [...existing];
  const added: TaskLink[] = [];
  for (const link of incoming) {
    if (links.some((other) => sameLink(other, link))) continue;
    links.push(link);
    added.push(link);
  }
  return { links, added };
}

/**
 * The rules of the board: columns and their triggers, moves, assignments and
 * the task's conversation (a stream rooted at the task). The store is SQL only.
 */
export class TaskService {
  readonly store: TaskStore;
  private readonly projects: ProjectStore;
  /** Per-task tail of the transition chain; see `withTaskLock`. */
  private readonly locks = new Map<string, Promise<void>>();

  constructor(private readonly deps: TaskServiceDeps) {
    this.store = new TaskStore(deps.pool, (id) => deps.watches?.schedule(id));
    this.projects = new ProjectStore(deps.pool);
  }

  async watch(id: string, agentId: string): Promise<void> {
    const task = await this.requireTask(id);
    const agent = await this.deps.getAgent(agentId);
    if (!agent) throw new TaskError("Agent is archived or unavailable.", 403);
    const archived = await this.deps.pool.query(
      `SELECT 1 FROM agents WHERE id = $1 AND deleted_at IS NOT NULL`,
      [agentId]
    );
    if (archived.rows.length) throw new TaskError("Agent is archived.", 403);
    const projectId = await agentTaskProject(
      {
        ...agent,
        cwd: agent.cwd ?? null,
        worktreePath: agent.worktreePath ?? null,
        baseBranch: agent.baseBranch ?? null,
      },
      (input) => this.projectForAgent(input)
    );
    if (projectId !== task.projectId)
      throw new TaskError("Task belongs to another project.", 403);
    if ((await this.store.removedAgentIds(id)).includes(agentId))
      throw new TaskError("Agent was removed from this task.", 403);
    await this.deps.pool.query(
      `INSERT INTO task_watches (task_id, agent_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [id, agentId]
    );
  }

  async unwatch(id: string, agentId: string): Promise<void> {
    this.deps.watches?.cancel(id, agentId);
    await this.deps.pool.query(
      `DELETE FROM task_watches WHERE task_id = $1 AND agent_id = $2`,
      [id, agentId]
    );
  }

  async watching(id: string, agentId: string): Promise<boolean> {
    const result = await this.deps.pool.query(
      `SELECT 1 FROM task_watches WHERE task_id = $1 AND agent_id = $2`,
      [id, agentId]
    );
    return result.rows.length > 0;
  }

  private publish(projectId: string, taskId?: string): void {
    try {
      this.deps.publishUiEvent({
        type: "task.changed",
        projectId,
        ...(taskId ? { taskId } : {}),
      });
    } catch {
      // Live updates are best-effort; the write already landed.
    }
  }

  private async requireProject(projectId: string): Promise<ProjectRecord> {
    const project = await this.projects.get(projectId);
    if (!project) throw notFound("Project");
    return project;
  }

  /** The task as a stream root, for `StreamService`; null when there is none. */
  async streamRoot(id: string): Promise<TaskStreamRoot | null> {
    const task = await this.store.getTask(id);
    if (!task) return null;
    const [column, agents, removed] = await Promise.all([
      this.store.getColumn(task.columnId),
      this.store.listTaskAgents(id),
      this.store.removedAgentIds(id),
    ]);
    const agentIds = agents.map((a) => a.agentId);
    return {
      id: task.id,
      title: task.title,
      projectId: task.projectId,
      column: column?.name ?? "—",
      assignedAgentId: task.assignedAgentId,
      agentIds,
      removedAgentIds: removed.filter((agentId) => !agentIds.includes(agentId)),
    };
  }

  async requireTask(id: string): Promise<Task> {
    const task = await this.store.getTask(id);
    if (!task) throw notFound("Task");
    return task;
  }

  private async requireColumn(id: string): Promise<TaskColumn> {
    const column = await this.store.getColumn(id);
    if (!column) throw notFound("Column");
    return column;
  }

  // ── Columns ──────────────────────────────────────────────────────

  /** The project's columns, seeding the defaults on first use. */
  async ensureColumns(projectId: string): Promise<TaskColumn[]> {
    const existing = await this.store.listColumns(projectId);
    if (existing.length > 0) return existing;
    await this.store.insertColumns(
      DEFAULT_TASK_COLUMNS.map((column, index) => ({
        projectId,
        key: column.key,
        name: column.name,
        position: index,
        isDone: column.isDone,
        trigger: null,
      }))
    );
    return await this.store.listColumns(projectId);
  }

  async getBoard(
    projectId: string,
    filter: { archived?: boolean } = {}
  ): Promise<TaskBoard> {
    await this.requireProject(projectId);
    const columns = await this.ensureColumns(projectId);
    const names = new Map(
      await Promise.all(
        [
          ...new Set(
            columns.flatMap((column) =>
              column.trigger ? [column.trigger.templateId] : []
            )
          ),
        ].map(
          async (id) =>
            [id, (await this.deps.getTemplate(id))?.name ?? null] as const
        )
      )
    );
    const tasks = await this.store.listTasks({
      projectId,
      archived: filter.archived,
    });
    return {
      projectId,
      columns: columns.map((column) => ({
        ...column,
        trigger: column.trigger
          ? {
              ...column.trigger,
              templateName: names.get(column.trigger.templateId) ?? null,
            }
          : null,
      })),
      tasks,
    };
  }

  async resolveColumnKey(projectId: string, key: string): Promise<TaskColumn> {
    const columns = await this.ensureColumns(projectId);
    const column = columns.find((c) => c.key === key);
    if (!column) {
      throw invalid(
        `Column "${key}" not found. Columns: ${columns.map((c) => c.key).join(", ")}.`
      );
    }
    return column;
  }

  /**
   * A trigger is valid when its template launches into this project: it is
   * the project's, or a projectless template rooted at the project's repo.
   */
  async validateTrigger(
    project: ProjectRecord,
    trigger: TaskColumnTriggerInput
  ): Promise<TaskColumnTrigger> {
    const template = await this.deps.getTemplate(trigger.templateId);
    if (!template) throw invalid(`Template ${trigger.templateId} not found.`);
    if (
      template.projectId !== project.id &&
      !(template.projectId === null && template.directory === project.repoRoot)
    ) {
      throw invalid(`Template "${template.name}" belongs to another project.`);
    }
    const agentType = trigger.agentType ?? null;
    if (agentType !== null && !AGENT_TYPES.includes(agentType)) {
      throw invalid(
        `Unsupported agent type "${agentType}". Must be one of: ${AGENT_TYPES.join(", ")}.`
      );
    }
    let model: string | null = null;
    try {
      model =
        validateAgentModel(
          agentType ?? template.agentType,
          trigger.model ?? undefined
        ) ?? null;
    } catch (error) {
      throw invalid(errorMessage(error));
    }
    return {
      templateId: template.id,
      agentType,
      model,
      assign: trigger.assign ?? true,
      fireOnCreate: trigger.fireOnCreate ?? false,
    };
  }

  private async uniqueKey(projectId: string, base: string): Promise<string> {
    const taken = new Set(
      (await this.store.listColumns(projectId)).map((c) => c.key)
    );
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) {
      if (!taken.has(`${base}_${n}`)) return `${base}_${n}`;
    }
  }

  private validateCapacity(capacity: number | null): number | null {
    if (
      capacity !== null &&
      (!Number.isInteger(capacity) || capacity < 1 || capacity > 2147483647)
    )
      throw invalid(
        "capacity must be null or a positive integer no greater than 2147483647."
      );
    return capacity;
  }

  private checkCapacity(column: TaskColumn): void {
    if (column.capacity !== null && column.activeTaskCount >= column.capacity)
      throw new TaskError(
        `Column "${column.name}" is full (${column.activeTaskCount}/${column.capacity}). Move or archive a task, raise the limit, or choose another column.`,
        409,
        "column_capacity_exceeded",
        {
          column: { id: column.id, key: column.key, name: column.name },
          count: column.activeTaskCount,
          limit: column.capacity,
        }
      );
  }

  async createColumn(
    projectId: string,
    input: ColumnInput
  ): Promise<TaskColumn> {
    const project = await this.requireProject(projectId);
    const name = input.name.trim();
    if (!name) throw invalid("name is required.");
    const existing = await this.ensureColumns(projectId);
    let key: string;
    if (input.key !== undefined) {
      key = input.key.trim();
      if (!KEY_PATTERN.test(key))
        throw invalid(
          "key must be lowercase letters, digits, '_' or '-', starting with a letter or digit."
        );
      if (existing.some((c) => c.key === key))
        throw new TaskError(
          `A column with key "${key}" already exists.`,
          409,
          "column_key_taken"
        );
    } else {
      key = await this.uniqueKey(projectId, slugifyColumnKey(name) || "column");
    }
    const trigger = input.trigger
      ? await this.validateTrigger(project, input.trigger)
      : null;
    const position =
      input.position ??
      (existing.length > 0
        ? Math.max(...existing.map((c) => c.position)) + 1
        : 0);
    const column = await this.store.transaction(async (db) => {
      if (input.isDone) await this.store.lockProjectColumns(projectId, db);
      const created = await this.store.insertColumn(
        {
          projectId,
          key,
          name,
          position,
          isDone: input.isDone ?? false,
          capacity: this.validateCapacity(input.capacity ?? null),
          trigger,
        },
        db
      );
      if (created.isDone)
        await this.store.clearDoneExcept(projectId, created.id, db);
      return created;
    });
    this.publish(projectId);
    return column;
  }

  async updateColumn(
    id: string,
    input: Partial<ColumnInput>
  ): Promise<TaskColumn> {
    const column = await this.requireColumn(id);
    const project = await this.requireProject(column.projectId);
    const patch: Parameters<TaskStore["updateColumn"]>[1] = {};
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (!name) throw invalid("name cannot be empty.");
      patch.name = name;
    }
    if (input.key !== undefined && input.key !== column.key) {
      const key = input.key.trim();
      if (!KEY_PATTERN.test(key))
        throw invalid(
          "key must be lowercase letters, digits, '_' or '-', starting with a letter or digit."
        );
      const taken = await this.store.getColumnByKey(column.projectId, key);
      if (taken)
        throw new TaskError(
          `A column with key "${key}" already exists.`,
          409,
          "column_key_taken"
        );
      patch.key = key;
    }
    if (input.capacity !== undefined)
      patch.capacity = this.validateCapacity(input.capacity);
    if (input.position !== undefined) patch.position = input.position;
    if (input.isDone !== undefined) patch.isDone = input.isDone;
    if (input.trigger !== undefined)
      patch.trigger =
        input.trigger === null
          ? null
          : await this.validateTrigger(project, input.trigger);
    const updated = await this.store.transaction(async (db) => {
      if (input.isDone)
        await this.store.lockProjectColumns(column.projectId, db);
      else await this.store.lockColumn(id, db);
      const next = await this.store.updateColumn(id, patch, db);
      if (!next) throw notFound("Column");
      if (input.isDone === true)
        await this.store.clearDoneExcept(column.projectId, id, db);
      return (await this.store.getColumn(id, db))!;
    });
    this.publish(column.projectId);
    return updated;
  }

  async deleteColumn(id: string): Promise<void> {
    const column = await this.requireColumn(id);
    if ((await this.store.countTasksInColumn(id)) > 0) {
      throw new TaskError(
        "Move or delete this column's tasks before deleting it.",
        409,
        "column_not_empty"
      );
    }
    try {
      await this.store.deleteColumn(id);
    } catch (error) {
      // A task landed between the count and the delete; RESTRICT caught it.
      if ((error as { code?: string }).code === "23503") {
        throw new TaskError(
          "Move or delete this column's tasks before deleting it.",
          409,
          "column_not_empty"
        );
      }
      throw error;
    }
    this.publish(column.projectId);
  }

  // ── Tasks ────────────────────────────────────────────────────────

  async listTasks(filter: {
    projectId?: string;
    assignedAgentId?: string;
    archived?: boolean;
  }): Promise<Task[]> {
    if (!filter.projectId && !filter.assignedAgentId)
      throw invalid("projectId or assignedAgentId is required.");
    return await this.store.listTasks(filter);
  }

  async archiveTask(id: string, caller: TaskCaller): Promise<Task> {
    return this.setArchived(id, true, caller);
  }

  async restoreTask(id: string, caller: TaskCaller): Promise<Task> {
    return this.setArchived(id, false, caller);
  }

  private async setArchived(
    id: string,
    archived: boolean,
    caller: TaskCaller
  ): Promise<Task> {
    return this.withTaskLock(id, async () => {
      for (;;) {
        const task = await this.requireTask(id);
        const changed = await this.store.transaction(async (db) => {
          // Column before task matches bulk archive's lock order. Archived tasks
          // cannot move; recheck after waiting for a concurrent restore/move.
          const column = await this.store.lockColumn(task.columnId, db);
          const current = await this.store.lockTask(id, db);
          if (!current) throw notFound("Task");
          if (current.columnId !== task.columnId) return null;
          if (!archived && current.archivedAt) {
            if (!column) throw notFound("Column");
            this.checkCapacity(column);
          }
          if (!(await this.store.setArchived(id, archived, db))) return false;
          await this.store.insertEvent(
            id,
            archived ? "archived" : "restored",
            actorOf(caller),
            {},
            db
          );
          return true;
        });
        if (changed === null) continue;
        if (changed) this.publish(task.projectId, id);
        return this.requireTask(id);
      }
    });
  }

  async archiveColumn(
    projectId: string,
    columnId: string,
    caller: TaskCaller
  ): Promise<{ archived: number; taskIds: string[] }> {
    await this.requireProject(projectId);
    const taskIds = await this.store.transaction(async (db) => {
      // Lock column configuration until the archive commits.
      await db.query("SELECT id FROM task_columns WHERE id = $1 FOR UPDATE", [
        columnId,
      ]);
      const column = await this.store.getColumn(columnId, db);
      if (!column || column.projectId !== projectId)
        throw invalid("Column is not in this project.");
      if (!column.isDone)
        throw invalid("Only the completion column can be archived.");
      const ids = await this.store.archiveColumn(projectId, columnId, db);
      for (const id of ids)
        await this.store.insertEvent(
          id,
          "archived",
          actorOf(caller),
          { bulk: true, columnId },
          db
        );
      return ids;
    });
    if (taskIds.length) this.publish(projectId);
    return { archived: taskIds.length, taskIds };
  }

  async getTaskDetail(
    id: string,
    eventLimit = TASK_EVENTS_DETAIL_LIMIT
  ): Promise<TaskDetail> {
    const task = await this.requireTask(id);
    const [agents, events] = await Promise.all([
      this.store.listTaskAgents(id),
      this.store.listEvents(id, eventLimit),
    ]);
    return {
      ...task,
      agents,
      events,
      attachments: await this.listAttachments(id),
    };
  }

  async createTask(
    input: CreateTaskInput,
    caller: TaskCaller,
    context: {
      startupFiles?: StartupFileUpload[];
      startupLinks?: string[];
    } = {}
  ): Promise<Task> {
    const files = context.startupFiles ?? [];
    if (files.length > MAX_STARTUP_FILE_COUNT)
      throw invalid(
        `A maximum of ${MAX_STARTUP_FILE_COUNT} startup files is allowed.`
      );
    let links: string[];
    try {
      links = [...new Set(validateStartupLinks(context.startupLinks ?? []))];
      for (const file of files)
        startupFileUpload(file.fileName, file.originalName, file.buffer);
    } catch (error) {
      throw invalid(errorMessage(error));
    }
    if (files.length && !this.deps.filesRoot)
      throw new Error("Task file storage is unavailable.");
    await this.requireProject(input.projectId);
    const title = input.title.trim();
    if (!title) throw invalid("title is required.");
    const columns = await this.ensureColumns(input.projectId);
    const initialColumn = input.columnId
      ? columns.find((c) => c.id === input.columnId)
      : columns[0];
    if (!initialColumn)
      throw invalid("columnId is not a column of this project.");
    const actor = actorOf(caller);
    const id = newTaskId();
    const column = await this.store.transaction(async (db) => {
      const currentColumn = await this.store.lockColumn(initialColumn.id, db);
      if (!currentColumn) throw notFound("Column");
      this.checkCapacity(currentColumn);
      await this.store.insertTask(
        {
          id,
          projectId: input.projectId,
          columnId: currentColumn.id,
          title,
          body: input.body ?? "",
          position:
            input.position ??
            (await this.store.topPosition(currentColumn.id, db)),
          createdBy: actor,
          completed: currentColumn.isDone,
        },
        db
      );
      return currentColumn;
    });
    try {
      if (links.length)
        await this.store.updateTask(id, {
          links: links.map((url) => ({ kind: "url", url, label: url })),
        });
      if (files.length)
        await mkdir(this.attachmentDir(id), { recursive: true });
      const now = new Date();
      for (const [index, file] of files.entries()) {
        const name = timestampFileName(file.fileName, now, index);
        await writeFile(path.join(this.attachmentDir(id), name), file.buffer);
        await this.store.insertAttachment({
          taskId: id,
          fileName: name,
          displayName: file.originalName,
          mimeType: file.mimeType,
          size: file.buffer.length,
          metadata: fileMetadataFromBuffer(file.buffer),
        });
      }
    } catch (error) {
      await this.store.deleteTask(id);
      await this.cleanupAttachments(id);
      throw error;
    }
    await this.store.insertEvent(id, "created", actor, {
      columnId: column.id,
    });
    if (column.trigger?.fireOnCreate) {
      await this.withTaskLock(id, async () =>
        this.fireTrigger(await this.requireTask(id), column, caller)
      );
    }
    this.publish(input.projectId, id);
    return await this.requireTask(id);
  }

  /**
   * Runs `run` after every earlier transition of the same task has settled,
   * so a move, its launch and its assignment never interleave with another.
   */
  private async withTaskLock<T>(id: string, run: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const current = previous.then(() => gate);
    this.locks.set(id, current);
    await previous;
    try {
      return await run();
    } finally {
      release();
      if (this.locks.get(id) === current) this.locks.delete(id);
    }
  }

  /** The task's assignee when it is running and is not `caller` itself. */
  private async workingAgent(
    task: Task,
    caller: TaskCaller
  ): Promise<TaskAgentInfo | null> {
    if (!task.assignedAgentId) return null;
    // An agent moving its own task is handing it off, not being run over.
    if (caller.kind === "agent" && caller.agentId === task.assignedAgentId)
      return null;
    const agent = await this.deps.getAgent(task.assignedAgentId);
    return agent && WORKING_STATUSES.has(agent.status) ? agent : null;
  }

  /**
   * Updates a task. A `columnId` change is a move and may fire the
   * destination's trigger; `assignSelf` makes the calling agent the task's
   * agent. Everything is checked before anything is written, so a refusal
   * leaves the task as it was.
   */
  async updateTask(
    id: string,
    input: UpdateTaskInput,
    caller: TaskCaller,
    opts: { assignSelf?: boolean } = {}
  ): Promise<Task> {
    return await this.withTaskLock(id, () =>
      this.applyUpdate(id, input, caller, opts)
    );
  }

  private async applyUpdate(
    id: string,
    input: UpdateTaskInput,
    caller: TaskCaller,
    opts: { assignSelf?: boolean }
  ): Promise<Task> {
    const task = await this.requireTask(id);
    if (task.archivedAt && input.columnId !== undefined)
      throw new TaskError(
        "Restore this task before moving it.",
        409,
        "task_archived"
      );
    if (input.beforeId === id)
      throw invalid("beforeId cannot be the moving task.");
    const actor = actorOf(caller);
    const patch: TaskPatch = {};
    const changed: string[] = [];

    if (input.title !== undefined) {
      const title = input.title.trim();
      if (!title) throw invalid("title cannot be empty.");
      if (title !== task.title) {
        patch.title = title;
        changed.push("title");
      }
    }
    if (input.body !== undefined && input.body !== task.body) {
      patch.body = input.body;
      changed.push("body");
    }

    const selfAgentId =
      opts.assignSelf && caller.kind === "agent" ? caller.agentId : null;
    if (opts.assignSelf && !selfAgentId)
      throw invalid("Only an agent can assign a task to itself.");
    if (selfAgentId && task.assignedAgentId !== selfAgentId) {
      const working = await this.workingAgent(task, caller);
      if (working) {
        throw new TaskError(
          `${working.name} is still working this task; it cannot be taken over.`,
          409,
          "agent_working",
          { agent: { id: working.id, name: working.name } }
        );
      }
    }
    if (
      input.assignedAgentId &&
      input.assignedAgentId !== task.assignedAgentId &&
      !(await this.deps.getAgent(input.assignedAgentId))
    ) {
      throw invalid(`Agent ${input.assignedAgentId} not found.`);
    }

    let destination: TaskColumn | null = null;
    if (input.columnId !== undefined && input.columnId !== task.columnId) {
      destination = await this.store.getColumn(input.columnId);
      if (!destination || destination.projectId !== task.projectId)
        throw invalid("columnId is not a column of this task's project.");
      patch.columnId = destination.id;
      patch.completed = destination.isDone;
      patch.position =
        input.position ?? (await this.store.topPosition(destination.id));
    } else if (input.position !== undefined) {
      patch.position = input.position;
    }

    let addedLinks: TaskLink[] = [];
    if (input.links !== undefined) {
      addedLinks = input.links.filter(
        (link) => !task.links.some((other) => sameLink(other, link))
      );
      patch.links = input.links;
    }

    const applied = await this.store.transaction(async (db) => {
      // Relative reorders can update siblings as well as the moving task.
      // Lock both involved columns in a consistent order before any task rows,
      // including for opposing moves and same-column reorders.
      if (input.beforeId !== undefined) {
        for (const columnId of [
          ...new Set([task.columnId, destination?.id ?? task.columnId]),
        ].sort()) {
          if (!(await this.store.lockColumn(columnId, db)))
            throw notFound("Column");
        }
      }
      if (destination) {
        const currentColumn = await this.store.lockColumn(destination.id, db);
        if (!currentColumn) throw notFound("Column");
        const current = await this.store.lockTask(id, db);
        if (
          !current ||
          current.columnId !== task.columnId ||
          current.archivedAt
        )
          return false;
        // Column automation and the task's assignee can change after the
        // initial read. Apply the relaunch guard to the locked admission state.
        if (currentColumn.trigger && !input.confirmRelaunch) {
          const working = await this.workingAgent(current, caller);
          if (working) {
            throw new TaskError(
              `${working.name} is still working this task.`,
              409,
              "agent_working",
              { agent: { id: working.id, name: working.name } }
            );
          }
        }
        this.checkCapacity(currentColumn);
        destination = currentColumn;
        patch.completed = currentColumn.isDone;
      }
      if (input.beforeId !== undefined) {
        const targetId = destination?.id ?? task.columnId;
        if (!destination) {
          if (!(await this.store.lockColumn(targetId, db)))
            throw notFound("Column");
          const current = await this.store.lockTask(id, db);
          if (
            !current ||
            current.columnId !== task.columnId ||
            current.archivedAt
          )
            return false;
        }
        const position = await this.store.reorderTask(
          id,
          targetId,
          input.beforeId,
          db
        );
        if (position === null)
          throw invalid(
            "beforeId is not an active task in the destination column."
          );
        patch.position = position;
      }
      if (Object.keys(patch).length > 0) {
        const updated = await this.store.updateTask(id, patch, {
          ...(destination ? { fromColumnId: task.columnId } : {}),
          db,
        });
        if (!updated) return false;
      }
      if (changed.length > 0)
        await this.store.insertEvent(
          id,
          "updated",
          actor,
          { fields: changed },
          db
        );
      for (const link of addedLinks)
        await this.store.insertEvent(id, "link_added", actor, { link }, db);
      if (destination)
        await this.store.insertEvent(
          id,
          "moved",
          actor,
          { fromColumnId: task.columnId, toColumnId: destination.id },
          db
        );
      return true;
    });
    if (!applied) {
      const current = await this.requireTask(id);
      if (current.archivedAt)
        throw new TaskError(
          "Restore this task before moving it.",
          409,
          "task_archived"
        );
      // Another write moved the task first; what it did stands.
      this.deps.log.info(
        { taskId: id, toColumnId: destination?.id },
        "Task move skipped: it was no longer in the column it was moved from"
      );
      return await this.requireTask(id);
    }

    if (selfAgentId) {
      const current = await this.requireTask(id);
      if (current.assignedAgentId !== selfAgentId)
        await this.assign(current, selfAgentId, "self", actor);
    } else if (
      input.assignedAgentId !== undefined &&
      input.assignedAgentId !== task.assignedAgentId
    ) {
      if (input.assignedAgentId === null) await this.unassign(task, actor);
      else
        await this.assign(
          await this.requireTask(id),
          input.assignedAgentId,
          "manual",
          actor
        );
    }

    if (destination?.trigger) {
      await this.fireTrigger(await this.requireTask(id), destination, caller);
    }

    this.publish(task.projectId, id);
    return await this.requireTask(id);
  }

  /**
   * Deletes the task and its conversation. Deliveries of its posts still
   * queued at an agent are taken back first, so none runs after the task
   * is gone; one that cannot be is a 409 and nothing is deleted.
   */
  async deleteTask(id: string): Promise<void> {
    await this.withTaskLock(id, async () => {
      const task = await this.requireTask(id);
      this.deps.watches?.cancel(id);
      try {
        await this.deps.chat.closeStream(id);
      } catch (error) {
        throw new TaskError(errorMessage(error), 409, "delivery_in_flight");
      }
      try {
        await this.store.deleteTask(id);
      } finally {
        this.deps.chat.releaseStream(id);
      }
      await this.cleanupAttachments(id);
      this.publish(task.projectId, id);
    });
  }

  async taskIdsForProject(projectId: string): Promise<string[]> {
    return this.store.taskIdsForProject(projectId);
  }

  /** IDs captured before the project delete cascades away the task rows. */
  async cleanupProjectAttachments(taskIds: string[]): Promise<void> {
    await Promise.all(taskIds.map((id) => this.cleanupAttachments(id)));
  }

  private attachmentDir(id: string): string {
    if (!this.deps.filesRoot)
      throw new Error("Task file storage is unavailable.");
    return path.resolve(this.deps.filesRoot, "tasks", id);
  }

  private async cleanupAttachments(id: string): Promise<void> {
    if (!this.deps.filesRoot) return;
    try {
      await rm(this.attachmentDir(id), { recursive: true, force: true });
    } catch (err) {
      this.deps.log.warn(
        { err, taskId: id },
        "Could not remove task attachments"
      );
    }
  }

  async listAttachments(id: string): Promise<TaskAttachment[]> {
    return (await this.store.listAttachments(id)).map((row) => ({
      id: row.id,
      name: row.display_name,
      mimeType: row.mime_type,
      size: row.size_bytes,
      url: `/api/v1/tasks/${encodeURIComponent(id)}/attachments/${row.id}`,
    }));
  }

  async attachmentFile(
    id: string,
    attachmentId: number
  ): Promise<{ path: string; mimeType: string }> {
    const row = await this.store.getAttachment(id, attachmentId);
    if (!row) throw notFound("Attachment");
    return {
      path: path.join(this.attachmentDir(id), row.file_name),
      mimeType: row.mime_type,
    };
  }

  private async briefingAttachments(id: string) {
    return (await this.store.listAttachments(id)).map((row) => ({
      name: row.display_name,
      mimeType: row.mime_type,
      path: path.join(this.attachmentDir(id), row.file_name),
    }));
  }

  // ── Launching ────────────────────────────────────────────────────

  /**
   * Launches `launch.templateId` for the task. A restricted agent cannot
   * start a full-access agent this way, the same ceiling `launch_agent`
   * holds it to.
   */
  private async launchFor(
    task: Task,
    column: TaskColumn,
    launch: {
      templateId: string;
      agentType: AgentType | null;
      model: string | null;
    },
    caller: TaskCaller
  ): Promise<AgentRecord> {
    const template = await this.deps.getTemplate(launch.templateId);
    if (!template) throw new Error(`Template ${launch.templateId} not found.`);
    if (template.fullAccess && isRestricted(caller))
      throw new Error(RESTRICTED_LAUNCH_REASON);
    const project = await this.requireProject(task.projectId);
    return await this.deps.launchTemplate({
      templateId: template.id,
      name: taskAgentName(task.title),
      projectId: task.projectId,
      // Placeholders resolve by lowercase key, so these satisfy
      // `{{D:Task Title}}`, `{{D:task title}}` and any other casing.
      args: {
        "task id": task.id,
        "task title": task.title,
        "task body": task.body,
      },
      // The task always rides along in full: a template never has to
      // place it, and an agent launched for a task always knows which.
      appendix: buildTaskBriefing({
        task,
        project,
        column,
        columns: await this.briefingColumns(task.projectId),
        attachments: await this.briefingAttachments(task.id),
      }),
      ...(launch.agentType ? { agentType: launch.agentType } : {}),
      ...(launch.model ? { model: launch.model } : {}),
    });
  }

  /**
   * Runs `column`'s trigger for a task that just entered it, inside the
   * task's lock. A failure is recorded on the task and never undoes the
   * move; a launch that finds the task gone from the column does not assign.
   */
  private async fireTrigger(
    task: Task,
    column: TaskColumn,
    caller: TaskCaller
  ): Promise<void> {
    const trigger = column.trigger;
    if (!trigger) return;
    const system: TaskActor = { kind: "system" };
    await this.store.insertEvent(task.id, "trigger_launching", system, {
      templateId: trigger.templateId,
    });
    this.publish(task.projectId, task.id);
    let agent: { id: string };
    try {
      agent = await this.launchFor(task, column, trigger, caller);
    } catch (error) {
      const reason = errorMessage(error);
      this.deps.log.warn(
        { taskId: task.id, columnId: column.id, err: error },
        "Task trigger launch failed"
      );
      await this.store.insertEvent(task.id, "trigger_failed", system, {
        templateId: trigger.templateId,
        reason,
      });
      return;
    }
    await this.store.insertEvent(task.id, "trigger_launched", system, {
      agentId: agent.id,
      templateId: trigger.templateId,
    });
    if (!trigger.assign) return;
    const current = await this.store.getTask(task.id);
    if (current?.columnId !== column.id) {
      this.deps.log.info(
        { taskId: task.id, agentId: agent.id, columnId: column.id },
        "Task left the trigger's column during the launch; not assigning"
      );
      return;
    }
    try {
      await this.assign(current, agent.id, "trigger", system, {
        columnId: column.id,
        startupBriefed: true,
      });
    } catch (error) {
      this.deps.log.warn(
        { taskId: task.id, agentId: agent.id, err: error },
        "Task trigger assignment failed"
      );
    }
  }

  /**
   * Takes an agent off the task: it stops being the assignee if it was,
   * is no longer one of the task's agents (so it can no longer post in
   * the task's conversation), and the task's history says so. What it
   * already posted stays.
   */
  async removeAgent(
    id: string,
    agentId: string,
    caller: TaskCaller
  ): Promise<TaskDetail> {
    return await this.withTaskLock(id, async () => {
      const task = await this.requireTask(id);
      const row = await this.store.getTaskAgent(id, agentId);
      if (!row) throw invalid(`Agent ${agentId} is not on this task.`);
      const actor = actorOf(caller);
      // Nothing of this task may still reach the agent: its queued
      // deliveries are taken back first, and a handover in flight refuses
      // the removal rather than letting the agent work on after it.
      let release: () => void;
      try {
        release = await this.deps.chat.withdrawDeliveries(id, agentId);
      } catch (error) {
        throw new TaskError(errorMessage(error), 409, "delivery_in_flight");
      }
      try {
        if (task.assignedAgentId === agentId) await this.unassign(task, actor);
        await this.unwatch(id, agentId);
        await this.store.deleteTaskAgent(id, agentId);
        await this.store.insertEvent(id, "agent_removed", actor, {
          agentId,
          role: row.role,
        });
      } finally {
        // Membership is gone: writes admitted from here cannot reach it.
        release();
      }
      this.publish(task.projectId, id);
      return await this.getTaskDetail(id);
    });
  }

  /**
   * What an agent created by hand for this task is told, and the project
   * it belongs in; `POST /api/v1/agents` with `taskId` uses it, then
   * assigns the new agent with `assignCreated`.
   */
  async briefingFor(
    id: string
  ): Promise<{ projectId: string; text: string; name: string }> {
    const task = await this.requireTask(id);
    const [project, column, columns] = await Promise.all([
      this.requireProject(task.projectId),
      this.requireColumn(task.columnId),
      this.briefingColumns(task.projectId),
    ]);
    return {
      projectId: task.projectId,
      name: taskAgentName(task.title),
      text: buildTaskBriefing({
        task,
        project,
        column,
        columns,
        attachments: await this.briefingAttachments(task.id),
      }),
    };
  }

  /** The project's columns in order, each trigger named by its template. */
  private async briefingColumns(projectId: string): Promise<BriefingColumn[]> {
    const columns = await this.ensureColumns(projectId);
    const templateIds = [
      ...new Set(
        columns.flatMap((c) => (c.trigger ? [c.trigger.templateId] : []))
      ),
    ];
    const names = new Map(
      await Promise.all(
        templateIds.map(
          async (id) =>
            [id, (await this.deps.getTemplate(id))?.name ?? null] as const
        )
      )
    );
    return columns.map((c) => ({
      key: c.key,
      name: c.name,
      isDone: c.isDone,
      trigger: c.trigger
        ? { templateName: names.get(c.trigger.templateId) ?? null }
        : null,
    }));
  }

  /**
   * The agent being created for the task becomes its assignee, before its
   * engine starts (the create route's `beforeLaunch`). No assignment post:
   * the briefing in its first prompt already says the task is its own.
   */
  async assignCreated(id: string, agentId: string): Promise<void> {
    await this.withTaskLock(id, async () => {
      const task = await this.requireTask(id);
      await this.store.upsertTaskAgent({
        taskId: id,
        agentId,
        role: "manual",
        columnId: null,
      });
      await this.store.setAssignedAgent(id, agentId);
      await this.store.insertEvent(
        id,
        "assigned",
        { kind: "user" },
        {
          agentId,
          role: "manual",
        }
      );
      this.publish(task.projectId, id);
    });
  }

  /** A launch by hand from the task: briefed, and assigned as `manual`. */
  async launchAgent(
    id: string,
    input: LaunchTaskAgentInput,
    caller: TaskCaller
  ): Promise<{ agent: AgentRecord }> {
    return await this.withTaskLock(id, async () => {
      const task = await this.requireTask(id);
      const project = await this.requireProject(task.projectId);
      const launch = await this.validateTrigger(project, {
        templateId: input.templateId,
        agentType: input.agentType ?? null,
        model: input.model ?? null,
      });
      const column = await this.requireColumn(task.columnId);
      const actor = actorOf(caller);
      let agent: AgentRecord;
      try {
        agent = await this.launchFor(task, column, launch, caller);
      } catch (error) {
        throw invalid(errorMessage(error));
      }
      await this.store.insertEvent(task.id, "agent_launched", actor, {
        agentId: agent.id,
        templateId: launch.templateId,
      });
      await this.assign(task, agent.id, "manual", actor, {
        startupBriefed: true,
      });
      this.publish(task.projectId, task.id);
      return { agent };
    });
  }

  // ── Assignment ───────────────────────────────────────────────────

  /**
   * Makes `agentId` the task's agent and tells it so in the task's stream:
   * a block from the user addressed to it, delivered as its prompt. Runs
   * inside the task's lock. A failed post keeps the assignment. Agents
   * launched with the task briefing already received these instructions
   * in their first prompt, so only their assignment records are needed.
   */
  private async assign(
    task: Task,
    agentId: string,
    role: TaskAgentRole,
    actor: TaskActor,
    options: { columnId?: string; startupBriefed?: boolean } = {}
  ): Promise<void> {
    const agent = await this.deps.getAgent(agentId);
    if (!agent) throw invalid(`Agent ${agentId} not found.`);
    await this.store.upsertTaskAgent({
      taskId: task.id,
      agentId,
      role,
      columnId: options.columnId ?? null,
    });
    await this.store.setAssignedAgent(task.id, agentId);
    await this.store.insertEvent(task.id, "assigned", actor, {
      agentId,
      role,
    });
    if (options.startupBriefed) return;
    try {
      await this.deps.chat.sendUserPost(task.id, {
        to: agentId,
        text: assignmentText(task),
        allowInert: true,
        // The assignee is chosen explicitly; an "@name" in the task title
        // must not redirect the block to another agent.
        resolveMentions: false,
      });
    } catch (error) {
      this.deps.log.warn(
        { taskId: task.id, agentId, err: error },
        "Could not post the assignment into the task's stream"
      );
    }
  }

  private async unassign(task: Task, actor: TaskActor): Promise<void> {
    if (!task.assignedAgentId) return;
    const row = await this.store.getTaskAgent(task.id, task.assignedAgentId);
    await this.store.setAssignedAgent(task.id, null);
    await this.store.insertEvent(task.id, "unassigned", actor, {
      agentId: task.assignedAgentId,
      role: row?.role ?? null,
    });
  }

  // ── Agent-facing (MCP) ───────────────────────────────────────────

  /**
   * The project an agent's task tools act on: its own, or for an agent
   * outside any project, the project whose repo holds its workspace.
   */
  async projectForAgent(agent: {
    projectId?: string | null;
    paths: Array<string | null | undefined>;
  }): Promise<string | null> {
    if (agent.projectId) return agent.projectId;
    const paths = agent.paths.filter((p): p is string => !!p);
    let best: ProjectRecord | null = null;
    for (const project of await this.projects.list()) {
      const root = project.repoRoot.replace(/\/+$/, "");
      const holds = paths.some((p) => p === root || p.startsWith(`${root}/`));
      if (holds && (!best || root.length > best.repoRoot.length))
        best = project;
    }
    return best?.id ?? null;
  }

  /**
   * Posts into the task's conversation as the calling agent, which must be
   * in the task's project (being on the task is not required, and posting
   * does not put it there); `to` addresses another of the task's agents.
   */
  async comment(
    id: string,
    agentId: string,
    text: string,
    to?: string
  ): Promise<{ blockId: string }> {
    await this.requireTask(id);
    if (to !== undefined && !(await this.store.getTaskAgent(id, to)))
      throw invalid(`Agent ${to} is not on task ${id}.`);
    const block = await this.deps.chat.post(
      agentId,
      { text, ...(to ? { to } : {}) },
      { root: id }
    );
    return { blockId: block.id };
  }
}
