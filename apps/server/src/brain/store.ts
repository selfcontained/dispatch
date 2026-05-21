import { randomUUID } from "node:crypto";

import type { Pool } from "pg";

// ── Types ────────────────────────────────────────────────────────────

export type BrainObject = {
  collection: string;
  name: string;
  value: unknown;
  revision: number;
  createdAt: string;
  updatedAt: string;
  createdByAgentId: string;
  updatedByAgentId: string;
};

export type BrainEvent = {
  id: string;
  collection: string;
  kind: string;
  subject: string | null;
  tags: string[];
  value: unknown;
  createdAt: string;
  agentId: string;
};

// ── Errors ───────────────────────────────────────────────────────────

export class BrainNotFoundError extends Error {
  readonly code = "not_found" as const;
  constructor(collection: string, name: string) {
    super(`Object "${collection}/${name}" not found.`);
  }
}

export class BrainRevisionConflictError extends Error {
  readonly code = "revision_conflict" as const;
  readonly current: BrainObject;
  constructor(current: BrainObject) {
    super("Object revision does not match expectedRevision.");
    this.current = current;
  }
}

export class BrainValidationError extends Error {
  readonly code = "validation_error" as const;
  constructor(message: string) {
    super(message);
  }
}

export class BrainLimitExceededError extends Error {
  readonly code = "limit_exceeded" as const;
  constructor(message: string) {
    super(message);
  }
}

// ── Constants ────────────────────────────────────────────────────────

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function clampLimit(limit: number | undefined): number {
  const n = limit ?? DEFAULT_LIMIT;
  if (n < 1) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

// ── Store ────────────────────────────────────────────────────────────

export class BrainStore {
  constructor(private readonly pool: Pool) {}

  // ── Objects ──────────────────────────────────────────────────────

  async getObject(
    repoRoot: string,
    collection: string,
    name: string
  ): Promise<BrainObject | null> {
    const result = await this.pool.query(
      `SELECT ${objectColumns()} FROM brain_objects
       WHERE repo_root = $1 AND collection = $2 AND name = $3`,
      [repoRoot, collection, name]
    );
    return result.rows[0] ? mapObject(result.rows[0]) : null;
  }

  async storeObject(
    repoRoot: string,
    agentId: string,
    input: {
      collection: string;
      name: string;
      value: unknown;
      expectedRevision?: number;
    }
  ): Promise<BrainObject> {
    const { collection, name, value, expectedRevision } = input;

    const existing = await this.getObject(repoRoot, collection, name);

    if (!existing && expectedRevision !== undefined) {
      throw new BrainNotFoundError(collection, name);
    }

    if (existing && expectedRevision === undefined) {
      throw new BrainValidationError(
        `Object "${collection}/${name}" already exists at revision ${existing.revision}. ` +
          `Pass expectedRevision to update it.`
      );
    }

    if (existing) {
      if (existing.revision !== expectedRevision) {
        throw new BrainRevisionConflictError(existing);
      }
      const result = await this.pool.query(
        `UPDATE brain_objects
         SET value = $1, revision = revision + 1, updated_at = now(), updated_by_agent_id = $2
         WHERE repo_root = $3 AND collection = $4 AND name = $5 AND revision = $6
         RETURNING ${objectColumns()}`,
        [
          JSON.stringify(value),
          agentId,
          repoRoot,
          collection,
          name,
          expectedRevision,
        ]
      );
      if (result.rows.length === 0) {
        const current = await this.getObject(repoRoot, collection, name);
        if (!current) throw new BrainNotFoundError(collection, name);
        throw new BrainRevisionConflictError(current);
      }
      return mapObject(result.rows[0]);
    }

    try {
      const result = await this.pool.query(
        `INSERT INTO brain_objects (repo_root, collection, name, value, revision, created_by_agent_id, updated_by_agent_id)
         VALUES ($1, $2, $3, $4, 1, $5, $5)
         RETURNING ${objectColumns()}`,
        [repoRoot, collection, name, JSON.stringify(value), agentId]
      );
      return mapObject(result.rows[0]);
    } catch (error) {
      if (isUniqueViolation(error)) {
        const current = await this.getObject(repoRoot, collection, name);
        if (current) {
          throw new BrainValidationError(
            `Object "${collection}/${name}" already exists at revision ${current.revision}. ` +
              `Pass expectedRevision to update it.`
          );
        }
      }
      throw error;
    }
  }

  async listObjects(
    repoRoot: string,
    filter?: {
      collection?: string;
      namePrefix?: string;
      updatedAfter?: string;
      limit?: number;
    }
  ): Promise<BrainObject[]> {
    const conditions: string[] = ["repo_root = $1"];
    const params: unknown[] = [repoRoot];

    if (filter?.collection) {
      params.push(filter.collection);
      conditions.push(`collection = $${params.length}`);
    }
    if (filter?.namePrefix) {
      params.push(escapeLike(filter.namePrefix) + "%");
      conditions.push(`name LIKE $${params.length}`);
    }
    if (filter?.updatedAfter) {
      params.push(filter.updatedAfter);
      conditions.push(`updated_at > $${params.length}`);
    }

    const limit = clampLimit(filter?.limit);
    params.push(limit);

    const result = await this.pool.query(
      `SELECT ${objectColumns()} FROM brain_objects
       WHERE ${conditions.join(" AND ")}
       ORDER BY updated_at DESC
       LIMIT $${params.length}`,
      params
    );
    return result.rows.map(mapObject);
  }

  async deleteObject(
    repoRoot: string,
    collection: string,
    name: string
  ): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM brain_objects
       WHERE repo_root = $1 AND collection = $2 AND name = $3`,
      [repoRoot, collection, name]
    );
    return (result.rowCount ?? 0) > 0;
  }

  // ── Events ──────────────────────────────────────────────────────

  async appendEvent(
    repoRoot: string,
    agentId: string,
    input: {
      collection: string;
      kind: string;
      value: unknown;
      subject?: string;
      tags?: string[];
    }
  ): Promise<BrainEvent> {
    const id = randomUUID();
    const { collection, kind, value, subject, tags } = input;

    const result = await this.pool.query(
      `INSERT INTO brain_events (id, repo_root, collection, kind, subject, tags, value, agent_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING ${eventColumns()}`,
      [
        id,
        repoRoot,
        collection,
        kind,
        subject ?? null,
        tags ?? [],
        JSON.stringify(value),
        agentId,
      ]
    );
    return mapEvent(result.rows[0]);
  }

  async queryEvents(
    repoRoot: string,
    filter?: {
      collection?: string;
      kind?: string;
      subject?: string;
      tags?: string[];
      since?: string;
      until?: string;
      limit?: number;
      order?: "asc" | "desc";
    }
  ): Promise<BrainEvent[]> {
    const conditions: string[] = ["repo_root = $1"];
    const params: unknown[] = [repoRoot];

    if (filter?.collection) {
      params.push(filter.collection);
      conditions.push(`collection = $${params.length}`);
    }
    if (filter?.kind) {
      params.push(filter.kind);
      conditions.push(`kind = $${params.length}`);
    }
    if (filter?.subject) {
      params.push(filter.subject);
      conditions.push(`subject = $${params.length}`);
    }
    if (filter?.tags && filter.tags.length > 0) {
      params.push(filter.tags);
      conditions.push(`tags @> $${params.length}`);
    }
    if (filter?.since) {
      params.push(filter.since);
      conditions.push(`created_at >= $${params.length}`);
    }
    if (filter?.until) {
      params.push(filter.until);
      conditions.push(`created_at <= $${params.length}`);
    }

    const limit = clampLimit(filter?.limit);
    params.push(limit);

    const order = filter?.order === "asc" ? "ASC" : "DESC";

    const result = await this.pool.query(
      `SELECT ${eventColumns()} FROM brain_events
       WHERE ${conditions.join(" AND ")}
       ORDER BY created_at ${order}
       LIMIT $${params.length}`,
      params
    );
    return result.rows.map(mapEvent);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function objectColumns(): string {
  return `
    collection,
    name,
    value,
    revision,
    created_at AS "createdAt",
    updated_at AS "updatedAt",
    created_by_agent_id AS "createdByAgentId",
    updated_by_agent_id AS "updatedByAgentId"
  `;
}

function mapObject(row: Record<string, unknown>): BrainObject {
  return row as BrainObject;
}

function eventColumns(): string {
  return `
    id,
    collection,
    kind,
    subject,
    tags,
    value,
    created_at AS "createdAt",
    agent_id AS "agentId"
  `;
}

function mapEvent(row: Record<string, unknown>): BrainEvent {
  return row as BrainEvent;
}

function escapeLike(value: string): string {
  return value.replace(/[%_\\]/g, "\\$&");
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505"
  );
}
