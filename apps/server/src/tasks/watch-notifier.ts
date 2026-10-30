import type { Pool } from "pg";
import { escapeEnvelopeMarkers } from "../chat/envelope.js";

export type WatchDelivery = {
  signal: AbortSignal;
  beforeSubmit: () => Promise<boolean>;
};
type Deps = {
  pool: Pool;
  projectForAgent: (id: string) => Promise<string | null>;
  deliver: (
    agentId: string,
    text: string,
    options: WatchDelivery
  ) => Promise<void>;
  warn: (error: unknown) => void;
  debounceMs?: number;
};
type Item = {
  id: string;
  source: string;
  type: string;
  actor: string;
  excerpt: string;
  at: string;
};

/** Insert triggers own the durable inbox. Timers are delivery wakeups only. */
export class TaskWatchNotifier {
  private disposed = false;
  private retry = new Set<string>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private active = new Map<
    string,
    { taskId: string; agentId: string; controller: AbortController }
  >();
  constructor(private readonly deps: Deps) {}

  dispose(): void {
    this.disposed = true;
    this.retry.clear();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const entry of this.active.values()) entry.controller.abort();
  }

  schedule(taskId: string): void {
    if (this.disposed) return;
    clearTimeout(this.timers.get(taskId));
    const timer = setTimeout(() => {
      this.timers.delete(taskId);
      void this.flushTask(taskId).catch(this.deps.warn);
    }, this.deps.debounceMs ?? 3_000);
    timer.unref?.();
    this.timers.set(taskId, timer);
  }

  cancel(taskId: string, agentId?: string): void {
    if (!agentId) {
      clearTimeout(this.timers.get(taskId));
      this.timers.delete(taskId);
    }
    for (const entry of this.active.values()) {
      if (entry.taskId === taskId && (!agentId || entry.agentId === agentId))
        entry.controller.abort();
    }
  }

  async recover(agentId?: string): Promise<void> {
    // Archived agents cannot retain watches, even when no new activity arrives.
    await this.deps.pool.query(
      `DELETE FROM task_watches w USING agents a WHERE w.agent_id = a.id AND a.deleted_at IS NOT NULL`
    );
    await this.deps.pool.query(
      `DELETE FROM task_board_watches w USING agents a WHERE w.agent_id = a.id AND a.deleted_at IS NOT NULL`
    );
    const { rows } = await this.deps.pool.query<{ task_id: string }>(
      `SELECT DISTINCT task_id FROM task_watch_items WHERE ($1::text IS NULL OR agent_id = $1)`,
      [agentId ?? null]
    );
    for (const row of rows) this.schedule(row.task_id);
  }

  async flushTask(taskId: string): Promise<void> {
    const { rows } = await this.deps.pool.query<{ agent_id: string }>(
      `SELECT DISTINCT agent_id FROM task_watch_items WHERE task_id = $1`,
      [taskId]
    );
    await Promise.all(
      rows.map((row) => this.flush(taskId, row.agent_id).catch(this.deps.warn))
    );
  }

  async flush(taskId: string, agentId: string): Promise<void> {
    const key = `${taskId}:${agentId}`;
    if (this.active.has(key)) {
      this.retry.add(key);
      return;
    }
    const controller = new AbortController();
    this.active.set(key, { taskId, agentId, controller });
    try {
      const { rows: watches } = await this.deps.pool.query<{
        title: string;
        column: string;
        project_id: string;
        status: string;
        deleted_at: string | null;
      }>(
        `SELECT t.title, c.key AS column, t.project_id, a.status, a.deleted_at
          FROM tasks t JOIN task_columns c ON c.id = t.column_id
          JOIN agents a ON a.id = $2 WHERE t.id = $1
          AND EXISTS (SELECT 1 FROM task_watch_items i WHERE i.task_id = t.id AND i.agent_id = a.id)`,
        [taskId, agentId]
      );
      const watch = watches[0];
      if (!watch) return;
      const removed = await this.deps.pool.query(
        `SELECT 1 FROM task_events WHERE task_id = $1 AND kind = 'agent_removed' AND data->>'agentId' = $2`,
        [taskId, agentId]
      );
      if (
        watch.deleted_at !== null ||
        removed.rows.length ||
        (await this.deps.projectForAgent(agentId)) !== watch.project_id
      ) {
        await this.deps.pool.query(
          `DELETE FROM task_watches WHERE task_id = $1 AND agent_id = $2`,
          [taskId, agentId]
        );
        await this.deps.pool.query(
          `DELETE FROM task_watch_items WHERE task_id = $1 AND agent_id = $2`,
          [taskId, agentId]
        );
        if (
          watch.deleted_at !== null ||
          (await this.deps.projectForAgent(agentId)) !== watch.project_id
        )
          await this.deps.pool.query(
            `DELETE FROM task_board_watches WHERE project_id = $1 AND agent_id = $2`,
            [watch.project_id, agentId]
          );
        return;
      }
      if (watch.status !== "running") return;
      // Snapshot identities, not timestamps: later commits stay in the inbox even
      // when their source created_at predates an already accepted notice.
      const { rows: pending } = await this.deps.pool.query<{
        id: string;
        source: string;
        item_id: string;
      }>(
        `SELECT id::text, source, item_id FROM task_watch_items WHERE task_id = $1 AND agent_id = $2`,
        [taskId, agentId]
      );
      if (!pending.length || controller.signal.aborted) return;
      const remove = async (entries: typeof pending) => {
        if (!entries.length) return;
        await this.deps.pool.query(
          `DELETE FROM task_watch_items i USING unnest($3::bigint[]) AS accepted(id)
           WHERE i.task_id = $1 AND i.agent_id = $2 AND i.id = accepted.id`,
          [taskId, agentId, entries.map((item) => item.id)]
        );
      };
      const { rows: items } = await this.deps.pool.query<Item>(
        `
        SELECT id, source, type, actor, excerpt, at::text FROM (
          SELECT e.id::text, 'event' AS source, 'event' AS type, COALESCE(event_actor.name, e.actor_agent_id, e.actor_kind) AS actor,
            CASE e.kind
              WHEN 'moved' THEN 'moved ' || COALESCE(from_column.key, e.data->>'fromColumnId', '?') || ' → ' || COALESCE(to_column.key, e.data->>'toColumnId', '?')
              WHEN 'assigned' THEN 'assigned ' || COALESCE(e.data->>'agentId', '')
              WHEN 'unassigned' THEN 'unassigned ' || COALESCE(e.data->>'agentId', '')
              WHEN 'agent_removed' THEN 'agent_removed ' || COALESCE(e.data->>'agentId', '')
              WHEN 'link_added' THEN 'link_added ' || COALESCE(e.data->'link'->>'label', '') || ' ' || COALESCE(e.data->'link'->>'url', '')
              WHEN 'updated' THEN 'updated ' || (SELECT string_agg(field, ', ') FROM jsonb_array_elements_text(e.data->'fields') AS field WHERE field IN ('title', 'body'))
              WHEN 'trigger_failed' THEN 'trigger_failed ' || COALESCE(e.data->>'reason', '')
              ELSE e.kind
            END AS excerpt, e.created_at AS at
          FROM task_events e
            LEFT JOIN agents event_actor ON event_actor.id = e.actor_agent_id
            LEFT JOIN task_columns from_column ON from_column.id = e.data->>'fromColumnId'
            LEFT JOIN task_columns to_column ON to_column.id = e.data->>'toColumnId'
          WHERE e.task_id = $1 AND e.id::text = ANY($3::text[])
            AND e.actor_agent_id IS DISTINCT FROM $2
            AND (e.kind IN ('created','moved','assigned','unassigned','agent_removed','archived','restored','link_added','trigger_failed')
              OR (e.kind = 'updated' AND e.data->'fields' ?| array['title','body']))
          UNION ALL
          SELECT b.id::text, 'block', 'message', COALESCE(message_actor.name, b.author_agent_id, b.author_kind),
            COALESCE(NULLIF(b.text, ''), b.kind || ' ' || COALESCE(b.data::text, '')), b.created_at
          FROM blocks b LEFT JOIN agents message_actor ON message_actor.id = b.author_agent_id WHERE b.stream_id = $1 AND b.id::text = ANY($4::text[])
            AND b.author_agent_id IS DISTINCT FROM $2 AND b.origin IS NULL
            AND b.kind IN ('text','question','form','review','finding','file','link','tasks')
            AND b.to_agent_id IS DISTINCT FROM $2
            AND NOT COALESCE(b.data->'mentions' ? $2, false)
            AND NOT COALESCE(b.data->'recipients' ? $2, false)
            AND NOT COALESCE(b.deliveries ? $2, false)
        ) activity
        ORDER BY at::timestamptz, type, id`,
        [
          taskId,
          agentId,
          pending
            .filter((item) => item.source === "event")
            .map((item) => item.item_id),
          pending
            .filter((item) => item.source === "block")
            .map((item) => item.item_id),
        ]
      );
      const included = new Set(
        items.map((item) => `${item.source}:${item.id}`)
      );
      await remove(
        pending.filter(
          (item) => !included.has(`${item.source}:${item.item_id}`)
        )
      );
      if (!items.length || controller.signal.aborted) return;
      const safe = (text: string) =>
        escapeEnvelopeMarkers(text.replace(/\s+/g, " ").slice(0, 160));
      const text = [
        `TASK WATCH — ${taskId} "${safe(watch.title)}" (${safe(watch.column)})`,
        ...items
          .slice(0, 15)
          .map(
            (item) =>
              `[${item.type} ${item.id}] ${safe(item.actor)}: ${safe(item.excerpt)}`
          ),
        ...(items.length > 15
          ? [`+${items.length - 15} more — task_get for the rest`]
          : []),
        `Read task_get({id: "${taskId}"}), get_message({id: "<message id>"}) or get_thread({id: "<message id>"}).`,
      ].join("\n");
      const represented = pending.filter((item) =>
        included.has(`${item.source}:${item.item_id}`)
      );
      let accepted = false;
      await this.deps.deliver(agentId, text, {
        signal: controller.signal,
        beforeSubmit: async () => {
          if (
            controller.signal.aborted ||
            (await this.deps.projectForAgent(agentId)) !== watch.project_id
          )
            return false;
          // Acceptance is the final live-coverage check, not the earlier snapshot.
          // Every represented source must still have one of its original coverage
          // rows. A new subscription cannot authorize an old queued delivery.
          const result = await this.deps.pool.query(
            `SELECT (SELECT count(DISTINCT (i.source, i.item_id)) FROM task_watch_items i
                WHERE i.task_id = $1 AND i.agent_id = a.id AND i.id = ANY($3::bigint[]))::int AS covered
              FROM agents a WHERE a.id = $2 AND a.status = 'running' AND a.deleted_at IS NULL
              AND NOT EXISTS (SELECT 1 FROM task_events e WHERE e.task_id = $1 AND e.kind = 'agent_removed' AND e.data->>'agentId' = a.id)`,
            [taskId, agentId, represented.map((item) => item.id)]
          );
          accepted = result.rows[0]?.covered === included.size;
          // Coverage changed while queued: rebuild from the surviving inbox.
          if (result.rows.length && !accepted) this.retry.add(key);
          return accepted;
        },
      });
      if (accepted && !controller.signal.aborted) await remove(represented);
    } finally {
      this.active.delete(key);
      if (this.retry.delete(key)) this.schedule(taskId);
    }
  }
}
