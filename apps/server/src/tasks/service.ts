import type { FastifyBaseLogger } from "fastify";
import type { Pool } from "pg";

import { AGENT_TYPES, type AgentType } from "../agent-type-settings.js";
import type { AgentRecord } from "../agents/types.js";
import type { StreamService, TaskStreamRoot } from "../chat/service.js";
import { ProjectStore, type ProjectRecord } from "../projects/store.js";
import { validateAgentModel } from "../shared/agent-models.js";
import { errorMessage } from "../shared/lib/error-message.js";
import type { TemplateRecord } from "../templates/store.js";
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
};

export type TaskLaunchRequest = {
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
  getAgent: (agentId: string) => Promise<TaskAgentInfo | null>;
  getTemplate: (templateId: string) => Promise<TemplateRecord | null>;
  /** Launches a top-level agent from a template; resolves to the new agent. */
  launchTemplate: (input: TaskLaunchRequest) => Promise<AgentRecord>;
  chat: Pick<
    StreamService,
    "sendUserPost" | "post" | "closeStream" | "releaseStream"
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

export function buildTaskBriefing(input: {
  task: Pick<Task, "id" | "title" | "body" | "links">;
  project: Pick<ProjectRecord, "name" | "repoRoot">;
  column: Pick<TaskColumn, "name">;
}): string {
  const { task, project, column } = input;
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
    `Task: ${task.id} — ${task.title}`,
    `Project: ${project.name} (${project.repoRoot})`,
    `Column: ${column.name}`,
    `Conversation: stream ${task.id} (the task's own stream; people and the task's agents post there)`,
    `Links:${links}`,
    "",
    task.body.trim() || "(no description)",
    "",
    `Move the task with task_update({ id, column }) as the work changes state (for example to "in_review" when a PR is up). Add PR links with task_update({ id, links: [...] }). Posts from the task's conversation reach you as DISPATCH POSTs naming the task; answer in place, or with post({ replyTo }) on one of its ids. Post progress there with task_comment.`,
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
    this.store = new TaskStore(deps.pool);
    this.projects = new ProjectStore(deps.pool);
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
    const [column, agents] = await Promise.all([
      this.store.getColumn(task.columnId),
      this.store.listTaskAgents(id),
    ]);
    return {
      id: task.id,
      title: task.title,
      column: column?.name ?? "—",
      assignedAgentId: task.assignedAgentId,
      agentIds: agents.map((a) => a.agentId),
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

  async getBoard(projectId: string): Promise<TaskBoard> {
    await this.requireProject(projectId);
    const columns = await this.ensureColumns(projectId);
    const tasks = await this.store.listTasks({ projectId });
    return { projectId, columns, tasks };
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
      passContext: trigger.passContext ?? true,
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
      const created = await this.store.insertColumn(
        {
          projectId,
          key,
          name,
          position,
          isDone: input.isDone ?? false,
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
    if (input.position !== undefined) patch.position = input.position;
    if (input.isDone !== undefined) patch.isDone = input.isDone;
    if (input.trigger !== undefined)
      patch.trigger =
        input.trigger === null
          ? null
          : await this.validateTrigger(project, input.trigger);
    const updated = await this.store.transaction(async (db) => {
      const next = await this.store.updateColumn(id, patch, db);
      if (!next) throw notFound("Column");
      if (input.isDone === true)
        await this.store.clearDoneExcept(column.projectId, id, db);
      return next;
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
  }): Promise<Task[]> {
    if (!filter.projectId && !filter.assignedAgentId)
      throw invalid("projectId or assignedAgentId is required.");
    return await this.store.listTasks(filter);
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
    return { ...task, agents, events };
  }

  async createTask(input: CreateTaskInput, caller: TaskCaller): Promise<Task> {
    await this.requireProject(input.projectId);
    const title = input.title.trim();
    if (!title) throw invalid("title is required.");
    const columns = await this.ensureColumns(input.projectId);
    const column = input.columnId
      ? columns.find((c) => c.id === input.columnId)
      : columns[0];
    if (!column) throw invalid("columnId is not a column of this project.");
    const actor = actorOf(caller);
    const id = newTaskId();
    await this.store.insertTask({
      id,
      projectId: input.projectId,
      columnId: column.id,
      title,
      body: input.body ?? "",
      position: input.position ?? (await this.store.topPosition(column.id)),
      createdBy: actor,
      completed: column.isDone,
    });
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
      if (destination.trigger && !input.confirmRelaunch) {
        const working = await this.workingAgent(task, caller);
        if (working) {
          throw new TaskError(
            `${working.name} is still working this task.`,
            409,
            "agent_working",
            { agent: { id: working.id, name: working.name } }
          );
        }
      }
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
      this.publish(task.projectId, id);
    });
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
      passContext: boolean;
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
      projectId: task.projectId,
      // Placeholders resolve by lowercase key, so these satisfy
      // `{{D:Task Title}}`, `{{D:task title}}` and any other casing.
      args: {
        "task id": task.id,
        "task title": task.title,
        "task body": task.body,
      },
      ...(launch.passContext
        ? { appendix: buildTaskBriefing({ task, project, column }) }
        : {}),
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
      await this.assign(current, agent.id, "trigger", system, column.id);
    } catch (error) {
      this.deps.log.warn(
        { taskId: task.id, agentId: agent.id, err: error },
        "Task trigger assignment failed"
      );
    }
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
        agent = await this.launchFor(
          task,
          column,
          { ...launch, passContext: true },
          caller
        );
      } catch (error) {
        throw invalid(errorMessage(error));
      }
      await this.store.insertEvent(task.id, "agent_launched", actor, {
        agentId: agent.id,
        templateId: launch.templateId,
      });
      await this.assign(task, agent.id, "manual", actor);
      this.publish(task.projectId, task.id);
      return { agent };
    });
  }

  // ── Assignment ───────────────────────────────────────────────────

  /**
   * Makes `agentId` the task's agent and tells it so in the task's stream:
   * a block from the user addressed to it, delivered as its prompt. Runs
   * inside the task's lock. A failed post keeps the assignment.
   */
  private async assign(
    task: Task,
    agentId: string,
    role: TaskAgentRole,
    actor: TaskActor,
    columnId: string | null = null
  ): Promise<void> {
    const agent = await this.deps.getAgent(agentId);
    if (!agent) throw invalid(`Agent ${agentId} not found.`);
    await this.store.upsertTaskAgent({
      taskId: task.id,
      agentId,
      role,
      columnId,
    });
    await this.store.setAssignedAgent(task.id, agentId);
    await this.store.insertEvent(task.id, "assigned", actor, {
      agentId,
      role,
    });
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
   * on the task; `to` addresses another of the task's agents.
   */
  async comment(
    id: string,
    agentId: string,
    text: string,
    to?: string
  ): Promise<{ blockId: string }> {
    await this.requireTask(id);
    if (!(await this.store.getTaskAgent(id, agentId))) {
      throw invalid(
        `You are not on task ${id}. Call task_update({ id: "${id}", assign: "self" }) first.`
      );
    }
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
