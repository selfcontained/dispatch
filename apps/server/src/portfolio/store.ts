import type { Pool } from "pg";

export const MAX_EXPORT_RECORDS = 10_000;
export const MAX_EXPORT_BYTES = 8 * 1024 * 1024;
export type Evidence = {
  type: "project" | "column" | "task" | "session" | "outcome";
  id: string;
  projectId: string;
  createdAt: string | null;
  updatedAt: string | null;
  data: Record<string, unknown>;
};
export class ExportTooLarge extends Error {}

/** A bounded, repeatable-read projection; never calls board reads that seed columns. */
export class PortfolioStore {
  constructor(private readonly pool: Pool) {}

  async snapshot(projectIds: string[], from: string, to: string) {
    const db = await this.pool.connect();
    try {
      await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await db.query("SET LOCAL statement_timeout = '10s'");
      const at = (await db.query("SELECT transaction_timestamp() AS at"))
        .rows[0].at as Date;
      const records: Evidence[] = [];
      let bytes = 0;
      const read = async (
        type: Evidence["type"],
        sql: string,
        values: unknown[]
      ) => {
        for (let offset = 0; ; offset += 100) {
          const rows = (
            await db.query(`${sql} OFFSET $${values.length + 1}`, [
              ...values,
              offset,
            ])
          ).rows;
          for (const row of rows) {
            bytes += Buffer.byteLength(JSON.stringify(row));
            if (bytes > MAX_EXPORT_BYTES) throw new ExportTooLarge();
            records.push({ type, ...row });
            if (records.length > MAX_EXPORT_RECORDS) throw new ExportTooLarge();
          }
          if (rows.length < 100) break;
        }
      };
      const args = [projectIds, 100];
      await read(
        "project",
        `SELECT id, id AS "projectId", created_at AS "createdAt", updated_at AS "updatedAt",
        CASE WHEN id = ANY($1::text[]) THEN jsonb_build_object('scope','included','name',left(name,80))
        ELSE jsonb_build_object('scope','excluded') END AS data
        FROM projects ORDER BY id LIMIT $2`,
        args
      );
      const present = new Set(records.map((r) => r.id));
      for (const id of [...new Set(projectIds)].sort()) {
        if (!present.has(id))
          records.push({
            type: "project",
            id,
            projectId: id,
            createdAt: null,
            updatedAt: null,
            data: { scope: "unavailable" },
          });
      }
      await read(
        "column",
        `SELECT id, project_id AS "projectId", created_at AS "createdAt", updated_at AS "updatedAt",
        jsonb_build_object('key',left(key,100),'name',left(name,200),'position',position,'isDone',is_done) AS data
        FROM task_columns WHERE project_id = ANY($1::text[]) ORDER BY id LIMIT $2`,
        args
      );
      await read(
        "task",
        `SELECT id, project_id AS "projectId", created_at AS "createdAt", updated_at AS "updatedAt",
        jsonb_build_object('columnId',column_id,'title',left(title,500),'body',left(body,4096),
          'bodyTruncated',length(body)>4096,'titleTruncated',length(title)>500,
          'links',COALESCE((SELECT jsonb_agg(jsonb_build_object('kind',l->>'kind','label',left(l->>'label',200),'url',left(l->>'url',2048)))
            FROM (SELECT value AS l FROM jsonb_array_elements(links) WITH ORDINALITY e(value,n) WHERE n<=20) bounded),'[]'::jsonb),
          'linksTruncated',jsonb_array_length(links)>20,'archivedAt',archived_at,'completedAt',completed_at) AS data
        FROM tasks WHERE project_id = ANY($1::text[]) ORDER BY id LIMIT $2`,
        args
      );
      await read(
        "session",
        `SELECT a.id, a.project_id AS "projectId", a.created_at AS "createdAt", a.updated_at AS "updatedAt",
        jsonb_build_object('parentId',CASE WHEN p.project_id=a.project_id THEN p.id END,
          'status',a.status,'archivedAt',a.deleted_at,
          'outcomeCoverage',CASE WHEN EXISTS(SELECT 1 FROM blocks b WHERE b.author_agent_id=a.id AND b.origin='turn' AND b.text<>'')
             THEN 'retained_blocks_only' ELSE 'unavailable' END) AS data
        FROM agents a LEFT JOIN agents p ON p.id=a.parent_agent_id
        WHERE a.project_id = ANY($1::text[]) ORDER BY a.id LIMIT $2`,
        args
      );
      await read(
        "outcome",
        `SELECT b.id::text, a.project_id AS "projectId", b.created_at AS "createdAt", b.updated_at AS "updatedAt",
        jsonb_build_object('sessionId',a.id,'streamId',b.stream_id,'threadId',b.thread_id,'replyTo',b.reply_to,
          'toSessionId',recipient.id,'text',left(b.text,4096),'textTruncated',length(b.text)>4096,'kind',b.kind,
          'coverage',CASE WHEN b.text='' THEN 'unavailable' ELSE 'reported' END) AS data
        FROM blocks b JOIN agents a ON a.id=b.author_agent_id
        LEFT JOIN agents root ON root.id=b.stream_id
        LEFT JOIN tasks t ON t.id=b.stream_id
        LEFT JOIN agents recipient ON recipient.id=b.to_agent_id AND recipient.project_id=a.project_id
        WHERE a.project_id = ANY($1::text[]) AND b.author_kind='agent'
          AND (root.project_id=a.project_id OR t.project_id=a.project_id)
          AND (b.to_agent_id IS NULL OR (recipient.id IS NOT NULL AND (recipient.id=a.parent_agent_id OR recipient.id=root.id)))
          AND (b.origin='turn' OR (b.origin IS NULL AND b.kind IN ('text','review','question')))
          AND b.updated_at >= $3::timestamptz AND b.updated_at < $4::timestamptz
        ORDER BY b.id LIMIT $2`,
        [...args, from, to]
      );
      if (records.length > MAX_EXPORT_RECORDS) throw new ExportTooLarge();
      // Source prose is never trusted as a secret-free channel. Fail closed for
      // credential-shaped content instead of partially redacting its prefix.
      const sensitive =
        /(?:-----BEGIN [A-Z ]*PRIVATE KEY|\b(?:Bearer\s+\S+|(?:password|secret|token|api[_-]?key)["']?\s*[=:]\s*["']?\S+)|\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]+|dpr_[a-f0-9]{64})|https?:\/\/[^\s/]+:[^\s/]+@)/i;
      const containsSensitive = (value: unknown): boolean => {
        if (typeof value === "string") return sensitive.test(value);
        if (value !== null && typeof value === "object")
          return Object.values(value).some(containsSensitive);
        return false;
      };
      for (const record of records) {
        if (containsSensitive(record.data))
          record.data = { coverage: "withheld_sensitive_content" };
      }
      const serialized = JSON.stringify(records);
      if (Buffer.byteLength(serialized) > MAX_EXPORT_BYTES)
        throw new ExportTooLarge();
      await db.query("COMMIT");
      return {
        at: at.toISOString(),
        records: JSON.parse(serialized) as Evidence[],
      };
    } catch (error) {
      await db.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      db.release();
    }
  }
}
