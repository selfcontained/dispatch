import { randomBytes, randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import type {
  Task,
  TaskActor,
  TaskAgent,
  TaskAgentRole,
  TaskColumn,
  TaskColumnTrigger,
  TaskEvent,
  TaskEventKind,
  TaskLink,
} from "./types.js";

type Queryable = Pool | PoolClient;

export function newTaskId(): string {
  return `tsk_${randomBytes(6).toString("hex")}`;
}

export function newColumnId(): string {
  return `tcol_${randomBytes(6).toString("hex")}`;
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function actorFrom(kind: string, agentId: string | null): TaskActor {
  if (kind === "agent" && agentId) return { kind: "agent", agentId };
  if (kind === "system") return { kind: "system" };
  return { kind: "user" };
}

function actorColumns(actor: TaskActor): [string, string | null] {
  return [actor.kind, actor.kind === "agent" ? actor.agentId : null];
}

const COLUMN_SELECT = `id, project_id, key, name, position, is_done, trigger, created_at, updated_at`;

type ColumnRow = {
  id: string;
  project_id: string;
  key: string;
  name: string;
  position: number;
  is_done: boolean;
  trigger: TaskColumnTrigger | null;
  created_at: Date;
  updated_at: Date;
};

function toColumn(row: ColumnRow): TaskColumn {
  return {
    id: row.id,
    projectId: row.project_id,
    key: row.key,
    name: row.name,
    position: row.position,
    isDone: row.is_done,
    trigger: row.trigger,
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
  };
}

/**
 * A task's latest failure is the newest `trigger_failed` with no launch at
 * or after it — computed here so every read carries it without a cache to
 * keep in step with the event log.
 */
const TASK_SELECT = `
  t.id, t.project_id, t.column_id, t.title, t.body, t.position,
  t.assigned_agent_id, t.links, t.created_by_kind, t.created_by_agent_id,
  t.completed_at, t.created_at, t.updated_at,
  f.reason AS failure_reason, f.created_at AS failure_at
  FROM tasks t
  LEFT JOIN LATERAL (
    SELECT e.data->>'reason' AS reason, e.created_at
    FROM task_events e
    WHERE e.task_id = t.id AND e.kind = 'trigger_failed'
      AND NOT EXISTS (
        SELECT 1 FROM task_events s
        WHERE s.task_id = t.id
          AND s.kind IN ('trigger_launched', 'agent_launched')
          AND s.created_at >= e.created_at
      )
    ORDER BY e.created_at DESC
    LIMIT 1
  ) f ON true`;

type TaskRow = {
  id: string;
  project_id: string;
  column_id: string;
  title: string;
  body: string;
  position: number;
  assigned_agent_id: string | null;
  links: TaskLink[];
  created_by_kind: string;
  created_by_agent_id: string | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
  failure_reason: string | null;
  failure_at: Date | null;
};

function toTask(row: TaskRow): Task {
  return {
    id: row.id,
    projectId: row.project_id,
    columnId: row.column_id,
    title: row.title,
    body: row.body,
    position: row.position,
    assignedAgentId: row.assigned_agent_id,
    links: row.links ?? [],
    createdBy: actorFrom(row.created_by_kind, row.created_by_agent_id),
    latestFailure:
      row.failure_at !== null
        ? { reason: row.failure_reason ?? "", at: iso(row.failure_at)! }
        : null,
    completedAt: iso(row.completed_at),
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
  };
}

type TaskAgentRow = {
  task_id: string;
  agent_id: string;
  role: TaskAgentRole;
  column_id: string | null;
  assigned_at: Date;
};

function toTaskAgent(row: TaskAgentRow): TaskAgent {
  return {
    taskId: row.task_id,
    agentId: row.agent_id,
    role: row.role,
    columnId: row.column_id,
    assignedAt: iso(row.assigned_at)!,
  };
}

type EventRow = {
  id: string;
  task_id: string;
  kind: TaskEventKind;
  actor_kind: string;
  actor_agent_id: string | null;
  data: Record<string, unknown>;
  created_at: Date;
};

function toEvent(row: EventRow): TaskEvent {
  return {
    id: row.id,
    taskId: row.task_id,
    kind: row.kind,
    actor: actorFrom(row.actor_kind, row.actor_agent_id),
    data: row.data ?? {},
    createdAt: iso(row.created_at)!,
  };
}

export type InsertColumn = {
  projectId: string;
  key: string;
  name: string;
  position: number;
  isDone: boolean;
  trigger: TaskColumnTrigger | null;
};

export type TaskPatch = {
  title?: string;
  body?: string;
  columnId?: string;
  position?: number;
  links?: TaskLink[];
  /** true sets completed_at to now, false clears it. */
  completed?: boolean;
};

/** SQL for the tasks module; the rules live in `TaskService`. */
export class TaskStore {
  constructor(private readonly pool: Pool) {}

  async transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await run(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  // ── Columns ──────────────────────────────────────────────────────

  async listColumns(projectId: string, db: Queryable = this.pool) {
    const { rows } = await db.query<ColumnRow>(
      `SELECT ${COLUMN_SELECT} FROM task_columns
       WHERE project_id = $1 ORDER BY position, created_at, id`,
      [projectId]
    );
    return rows.map(toColumn);
  }

  async getColumn(
    id: string,
    db: Queryable = this.pool
  ): Promise<TaskColumn | null> {
    const { rows } = await db.query<ColumnRow>(
      `SELECT ${COLUMN_SELECT} FROM task_columns WHERE id = $1`,
      [id]
    );
    return rows[0] ? toColumn(rows[0]) : null;
  }

  async getColumnByKey(
    projectId: string,
    key: string
  ): Promise<TaskColumn | null> {
    const { rows } = await this.pool.query<ColumnRow>(
      `SELECT ${COLUMN_SELECT} FROM task_columns WHERE project_id = $1 AND key = $2`,
      [projectId, key]
    );
    return rows[0] ? toColumn(rows[0]) : null;
  }

  /**
   * Inserts columns, skipping any whose key the project already has —
   * concurrent first reads of a board seed it once between them.
   */
  async insertColumns(
    columns: InsertColumn[],
    db: Queryable = this.pool
  ): Promise<void> {
    for (const column of columns) {
      await db.query(
        `INSERT INTO task_columns (id, project_id, key, name, position, is_done, trigger)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (project_id, key) DO NOTHING`,
        [
          newColumnId(),
          column.projectId,
          column.key,
          column.name,
          column.position,
          column.isDone,
          column.trigger === null ? null : JSON.stringify(column.trigger),
        ]
      );
    }
  }

  async insertColumn(
    column: InsertColumn,
    db: Queryable = this.pool
  ): Promise<TaskColumn> {
    const { rows } = await db.query<ColumnRow>(
      `INSERT INTO task_columns (id, project_id, key, name, position, is_done, trigger)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${COLUMN_SELECT}`,
      [
        newColumnId(),
        column.projectId,
        column.key,
        column.name,
        column.position,
        column.isDone,
        column.trigger === null ? null : JSON.stringify(column.trigger),
      ]
    );
    return toColumn(rows[0]!);
  }

  async updateColumn(
    id: string,
    patch: Partial<Omit<InsertColumn, "projectId">>,
    db: Queryable = this.pool
  ): Promise<TaskColumn | null> {
    const sets: string[] = [];
    const values: unknown[] = [id];
    const set = (column: string, value: unknown) => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };
    if (patch.key !== undefined) set("key", patch.key);
    if (patch.name !== undefined) set("name", patch.name);
    if (patch.position !== undefined) set("position", patch.position);
    if (patch.isDone !== undefined) set("is_done", patch.isDone);
    if (patch.trigger !== undefined)
      set(
        "trigger",
        patch.trigger === null ? null : JSON.stringify(patch.trigger)
      );
    sets.push("updated_at = now()");
    const { rows } = await db.query<ColumnRow>(
      `UPDATE task_columns SET ${sets.join(", ")} WHERE id = $1
       RETURNING ${COLUMN_SELECT}`,
      values
    );
    return rows[0] ? toColumn(rows[0]) : null;
  }

  /** Clears `is_done` on every other column of the project. */
  async clearDoneExcept(
    projectId: string,
    keepId: string,
    db: Queryable = this.pool
  ): Promise<void> {
    await db.query(
      `UPDATE task_columns SET is_done = false, updated_at = now()
       WHERE project_id = $1 AND id <> $2 AND is_done`,
      [projectId, keepId]
    );
  }

  async deleteColumn(id: string): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM task_columns WHERE id = $1`,
      [id]
    );
    return result.rowCount === 1;
  }

  async countTasksInColumn(columnId: string): Promise<number> {
    const { rows } = await this.pool.query<{ count: string }>(
      `SELECT count(*) FROM tasks WHERE column_id = $1`,
      [columnId]
    );
    return Number(rows[0]?.count ?? 0);
  }

  // ── Tasks ────────────────────────────────────────────────────────

  async insertTask(input: {
    id: string;
    projectId: string;
    columnId: string;
    title: string;
    body: string;
    position: number;
    createdBy: TaskActor;
    completed: boolean;
  }): Promise<void> {
    const [kind, agentId] = actorColumns(input.createdBy);
    await this.pool.query(
      `INSERT INTO tasks (id, project_id, column_id, title, body, position,
                          created_by_kind, created_by_agent_id, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CASE WHEN $9 THEN now() END)`,
      [
        input.id,
        input.projectId,
        input.columnId,
        input.title,
        input.body,
        input.position,
        kind,
        agentId,
        input.completed,
      ]
    );
  }

  async getTask(id: string): Promise<Task | null> {
    const { rows } = await this.pool.query<TaskRow>(
      `SELECT ${TASK_SELECT} WHERE t.id = $1`,
      [id]
    );
    return rows[0] ? toTask(rows[0]) : null;
  }

  async listTasks(filter: {
    projectId?: string;
    assignedAgentId?: string;
  }): Promise<Task[]> {
    const where: string[] = [];
    const values: unknown[] = [];
    if (filter.projectId) {
      values.push(filter.projectId);
      where.push(`t.project_id = $${values.length}`);
    }
    if (filter.assignedAgentId) {
      values.push(filter.assignedAgentId);
      where.push(`t.assigned_agent_id = $${values.length}`);
    }
    const { rows } = await this.pool.query<TaskRow>(
      `SELECT ${TASK_SELECT}
       ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY t.position, t.created_at, t.id`,
      values
    );
    return rows.map(toTask);
  }

  /** The position that puts a task above everything in the column. */
  async topPosition(columnId: string): Promise<number> {
    const { rows } = await this.pool.query<{ min: number | null }>(
      `SELECT min(position) AS min FROM tasks WHERE column_id = $1`,
      [columnId]
    );
    const min = rows[0]?.min;
    return min === null || min === undefined ? 0 : min - 1;
  }

  /**
   * Applies `patch`. With `fromColumnId` it is a conditional transition: the
   * row only changes while the task is still in that column, and the result
   * says whether it did — false means another write moved it first.
   */
  async updateTask(
    id: string,
    patch: TaskPatch,
    opts: { fromColumnId?: string; db?: Queryable } = {}
  ): Promise<boolean> {
    const sets: string[] = [];
    const values: unknown[] = [id];
    const set = (column: string, value: unknown) => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };
    if (patch.title !== undefined) set("title", patch.title);
    if (patch.body !== undefined) set("body", patch.body);
    if (patch.columnId !== undefined) set("column_id", patch.columnId);
    if (patch.position !== undefined) set("position", patch.position);
    if (patch.links !== undefined) set("links", JSON.stringify(patch.links));
    if (patch.completed !== undefined)
      sets.push(
        patch.completed
          ? "completed_at = COALESCE(completed_at, now())"
          : "completed_at = NULL"
      );
    sets.push("updated_at = now()");
    let where = "id = $1";
    if (opts.fromColumnId !== undefined) {
      values.push(opts.fromColumnId);
      where += ` AND column_id = $${values.length}`;
    }
    const result = await (opts.db ?? this.pool).query(
      `UPDATE tasks SET ${sets.join(", ")} WHERE ${where}`,
      values
    );
    return result.rowCount === 1;
  }

  async setAssignedAgent(id: string, agentId: string | null): Promise<void> {
    await this.pool.query(
      `UPDATE tasks SET assigned_agent_id = $2, updated_at = now() WHERE id = $1`,
      [id, agentId]
    );
  }

  /** Deletes the task and its conversation (the blocks rooted at it). */
  async deleteTask(id: string): Promise<boolean> {
    return await this.transaction(async (db) => {
      await db.query(`DELETE FROM blocks WHERE stream_id = $1`, [id]);
      const result = await db.query(`DELETE FROM tasks WHERE id = $1`, [id]);
      return result.rowCount === 1;
    });
  }

  // ── Assignments ──────────────────────────────────────────────────

  /**
   * Records an assignment. A repeat assignment of the same agent refreshes
   * its role and column.
   */
  async upsertTaskAgent(input: {
    taskId: string;
    agentId: string;
    role: TaskAgentRole;
    columnId: string | null;
  }): Promise<TaskAgent> {
    const { rows } = await this.pool.query<TaskAgentRow>(
      `INSERT INTO task_agents (task_id, agent_id, role, column_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (task_id, agent_id) DO UPDATE
         SET role = EXCLUDED.role, column_id = EXCLUDED.column_id,
             assigned_at = now()
       RETURNING *`,
      [input.taskId, input.agentId, input.role, input.columnId]
    );
    return toTaskAgent(rows[0]!);
  }

  async getTaskAgent(
    taskId: string,
    agentId: string
  ): Promise<TaskAgent | null> {
    const { rows } = await this.pool.query<TaskAgentRow>(
      `SELECT * FROM task_agents WHERE task_id = $1 AND agent_id = $2`,
      [taskId, agentId]
    );
    return rows[0] ? toTaskAgent(rows[0]) : null;
  }

  async listTaskAgents(taskId: string): Promise<TaskAgent[]> {
    const { rows } = await this.pool.query<TaskAgentRow>(
      `SELECT * FROM task_agents WHERE task_id = $1 ORDER BY assigned_at, agent_id`,
      [taskId]
    );
    return rows.map(toTaskAgent);
  }

  // ── Events ───────────────────────────────────────────────────────

  /**
   * `clock_timestamp()`, not `now()`: several events written in one request
   * must keep their order, and `latestFailure` compares them by time.
   */
  async insertEvent(
    taskId: string,
    kind: TaskEventKind,
    actor: TaskActor,
    data: Record<string, unknown> = {},
    db: Queryable = this.pool
  ): Promise<void> {
    const [actorKind, actorAgentId] = actorColumns(actor);
    await db.query(
      `INSERT INTO task_events (id, task_id, kind, actor_kind, actor_agent_id, data, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, clock_timestamp())`,
      [
        randomUUID(),
        taskId,
        kind,
        actorKind,
        actorAgentId,
        JSON.stringify(data),
      ]
    );
  }

  /** The newest `limit` events, oldest first. */
  async listEvents(taskId: string, limit: number): Promise<TaskEvent[]> {
    const { rows } = await this.pool.query<EventRow>(
      `SELECT * FROM (
         SELECT * FROM task_events WHERE task_id = $1
         ORDER BY created_at DESC LIMIT $2
       ) recent ORDER BY created_at`,
      [taskId, limit]
    );
    return rows.map(toEvent);
  }
}
