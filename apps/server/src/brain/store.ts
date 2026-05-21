import { randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

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

export type BrainList = {
  collection: string;
  name: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  createdByAgentId: string;
  updatedByAgentId: string;
};

export type BrainListItem = {
  index: number;
  value: unknown;
  createdAt: string;
  updatedAt: string;
};

// ── Errors ───────────────────────────────────────────────────────────

export class BrainNotFoundError extends Error {
  readonly code = "not_found" as const;
  constructor(collection: string, name: string) {
    super(`Object "${collection}/${name}" not found.`);
  }
}

export class BrainListNotFoundError extends Error {
  readonly code = "not_found" as const;
  constructor(collection: string, name: string) {
    super(`List "${collection}/${name}" not found.`);
  }
}

export class BrainListItemNotFoundError extends Error {
  readonly code = "not_found" as const;
  constructor(
    collection: string,
    name: string,
    details: { index?: number; field?: string; equals?: string }
  ) {
    if (details.index !== undefined) {
      super(
        `List item "${collection}/${name}" at index ${details.index} not found.`
      );
      return;
    }
    super(
      `List item "${collection}/${name}" matching ${details.field}="${details.equals}" not found.`
    );
  }
}

export class BrainRevisionConflictError extends Error {
  readonly code = "revision_conflict" as const;
  readonly current: BrainObject | BrainList;
  constructor(current: BrainObject | BrainList) {
    const kind = "value" in current ? "Object" : "List";
    super(`${kind} revision does not match expectedRevision.`);
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

  // ── Lists ────────────────────────────────────────────────────────

  async getList(
    repoRoot: string,
    collection: string,
    name: string
  ): Promise<BrainList | null> {
    const result = await this.pool.query(
      `SELECT ${listColumns()} FROM brain_lists
       WHERE repo_root = $1 AND collection = $2 AND name = $3`,
      [repoRoot, collection, name]
    );
    return result.rows[0] ? mapList(result.rows[0]) : null;
  }

  async getListItems(
    repoRoot: string,
    input: {
      collection: string;
      name: string;
      limit?: number;
      offset?: number;
      order?: "asc" | "desc";
    }
  ): Promise<{ items: BrainListItem[]; totalCount: number; revision: number }> {
    const { collection, name } = input;
    return await this.withTransaction(
      async (client) => {
        const list = await this.getListForUpdate(
          client,
          repoRoot,
          collection,
          name
        );
        if (!list) {
          return { items: [], totalCount: 0, revision: 0 };
        }

        const offset = Math.max(0, input.offset ?? 0);
        const limit = clampLimit(input.limit);
        const order = input.order === "desc" ? "DESC" : "ASC";
        const result = await client.query(
          `SELECT ${listItemColumns()},
                  COUNT(*) OVER()::int AS total_count
           FROM brain_list_items
           WHERE repo_root = $1 AND collection = $2 AND name = $3
           ORDER BY item_index ${order}
           OFFSET $4
           LIMIT $5`,
          [repoRoot, collection, name, offset, limit]
        );

        return {
          items: result.rows.map(mapListItem),
          totalCount: result.rows[0]?.total_count ?? 0,
          revision: list.revision,
        };
      },
      { isolationLevel: "REPEATABLE READ" }
    );
  }

  async pushListItems(
    repoRoot: string,
    agentId: string,
    input: {
      collection: string;
      name: string;
      items: unknown[];
      maxItems?: number;
      expectedRevision?: number;
    }
  ): Promise<{ length: number; revision: number }> {
    const { collection, name, items, maxItems, expectedRevision } = input;
    if (items.length === 0) {
      throw new BrainValidationError("List push requires at least one item.");
    }
    if (maxItems !== undefined && maxItems < 1) {
      throw new BrainValidationError("maxItems must be at least 1.");
    }

    return await this.withTransaction(async (client) => {
      const list = await this.lockOrCreateList(client, repoRoot, agentId, {
        collection,
        name,
        expectedRevision,
      });
      const nextIndex = await this.getNextListIndex(
        client,
        repoRoot,
        collection,
        name
      );

      for (const [offset, item] of items.entries()) {
        await client.query(
          `INSERT INTO brain_list_items (repo_root, collection, name, item_index, value)
           VALUES ($1, $2, $3, $4, $5)`,
          [repoRoot, collection, name, nextIndex + offset, JSON.stringify(item)]
        );
      }

      if (maxItems !== undefined) {
        await this.trimListToMaxItems(
          client,
          repoRoot,
          collection,
          name,
          maxItems
        );
      }

      const updated = await this.bumpListRevision(
        client,
        repoRoot,
        collection,
        name,
        agentId,
        list.revision
      );
      const length = await this.getListLength(
        client,
        repoRoot,
        collection,
        name
      );
      return { length, revision: updated.revision };
    });
  }

  async removeListItem(
    repoRoot: string,
    agentId: string,
    input: {
      collection: string;
      name: string;
      index?: number;
      where?: { field: string; equals: string };
      expectedRevision?: number;
    }
  ): Promise<{ removed: unknown; length: number; revision: number }> {
    const { collection, name, index, where, expectedRevision } = input;
    if ((index === undefined) === (where === undefined)) {
      throw new BrainValidationError(
        "Provide exactly one of index or where when removing a list item."
      );
    }

    return await this.withTransaction(async (client) => {
      const list = await this.lockExistingList(
        client,
        repoRoot,
        collection,
        name,
        expectedRevision
      );
      const target = await this.findListItemForRemoval(
        client,
        repoRoot,
        collection,
        name,
        {
          index,
          where,
        }
      );
      if (!target) {
        if (index !== undefined) {
          throw new BrainListItemNotFoundError(collection, name, { index });
        }
        throw new BrainListItemNotFoundError(collection, name, {
          field: where?.field,
          equals: where?.equals,
        });
      }

      await client.query(
        `DELETE FROM brain_list_items
         WHERE repo_root = $1 AND collection = $2 AND name = $3 AND item_index = $4`,
        [repoRoot, collection, name, target.index]
      );
      await this.reindexListItems(client, repoRoot, collection, name);
      const updated = await this.bumpListRevision(
        client,
        repoRoot,
        collection,
        name,
        agentId,
        list.revision
      );
      const length = await this.getListLength(
        client,
        repoRoot,
        collection,
        name
      );
      return { removed: target.value, length, revision: updated.revision };
    });
  }

  async setListItem(
    repoRoot: string,
    agentId: string,
    input: {
      collection: string;
      name: string;
      index: number;
      value: unknown;
      expectedRevision?: number;
    }
  ): Promise<{ item: BrainListItem; length: number; revision: number }> {
    const { collection, name, index, value, expectedRevision } = input;
    if (index < 0) {
      throw new BrainValidationError("List item index must be 0 or greater.");
    }
    if (expectedRevision === undefined) {
      throw new BrainValidationError(
        "List item updates require expectedRevision because item positions can shift after removals."
      );
    }

    return await this.withTransaction(async (client) => {
      const list = await this.lockExistingList(
        client,
        repoRoot,
        collection,
        name,
        expectedRevision
      );
      const result = await client.query(
        `UPDATE brain_list_items
         SET value = $1, updated_at = now()
         WHERE repo_root = $2 AND collection = $3 AND name = $4 AND item_index = $5
         RETURNING ${listItemColumns()}`,
        [JSON.stringify(value), repoRoot, collection, name, index]
      );
      if (result.rows.length === 0) {
        throw new BrainListItemNotFoundError(collection, name, { index });
      }
      const updated = await this.bumpListRevision(
        client,
        repoRoot,
        collection,
        name,
        agentId,
        list.revision
      );
      const length = await this.getListLength(
        client,
        repoRoot,
        collection,
        name
      );
      return {
        item: mapListItem(result.rows[0]),
        length,
        revision: updated.revision,
      };
    });
  }

  async deleteList(
    repoRoot: string,
    collection: string,
    name: string
  ): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM brain_lists
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

  private async withTransaction<T>(
    fn: (client: PoolClient) => Promise<T>,
    options?: { isolationLevel?: "REPEATABLE READ" | "SERIALIZABLE" }
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (options?.isolationLevel) {
        await client.query(
          `SET TRANSACTION ISOLATION LEVEL ${options.isolationLevel}`
        );
      }
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async lockOrCreateList(
    client: PoolClient,
    repoRoot: string,
    agentId: string,
    input: {
      collection: string;
      name: string;
      expectedRevision?: number;
    }
  ): Promise<BrainList> {
    const { collection, name, expectedRevision } = input;
    const existingResult = await client.query(
      `SELECT ${listColumns()} FROM brain_lists
       WHERE repo_root = $1 AND collection = $2 AND name = $3
       FOR UPDATE`,
      [repoRoot, collection, name]
    );
    if (existingResult.rows[0]) {
      const existing = mapList(existingResult.rows[0]);
      if (
        expectedRevision !== undefined &&
        existing.revision !== expectedRevision
      ) {
        throw new BrainRevisionConflictError(existing);
      }
      return existing;
    }

    if (expectedRevision !== undefined) {
      throw new BrainListNotFoundError(collection, name);
    }

    try {
      const insertResult = await client.query(
        `INSERT INTO brain_lists (repo_root, collection, name, revision, created_by_agent_id, updated_by_agent_id)
         VALUES ($1, $2, $3, 0, $4, $4)
         RETURNING ${listColumns()}`,
        [repoRoot, collection, name, agentId]
      );
      return mapList(insertResult.rows[0]);
    } catch (error) {
      if (isUniqueViolation(error)) {
        const retryResult = await client.query(
          `SELECT ${listColumns()} FROM brain_lists
           WHERE repo_root = $1 AND collection = $2 AND name = $3
           FOR UPDATE`,
          [repoRoot, collection, name]
        );
        if (!retryResult.rows[0]) {
          throw error;
        }
        const existing = mapList(retryResult.rows[0]);
        if (
          expectedRevision !== undefined &&
          existing.revision !== expectedRevision
        ) {
          throw new BrainRevisionConflictError(existing);
        }
        return existing;
      }
      throw error;
    }
  }

  private async getListForUpdate(
    client: PoolClient,
    repoRoot: string,
    collection: string,
    name: string
  ): Promise<BrainList | null> {
    const result = await client.query(
      `SELECT ${listColumns()} FROM brain_lists
       WHERE repo_root = $1 AND collection = $2 AND name = $3`,
      [repoRoot, collection, name]
    );
    return result.rows[0] ? mapList(result.rows[0]) : null;
  }

  private async lockExistingList(
    client: PoolClient,
    repoRoot: string,
    collection: string,
    name: string,
    expectedRevision?: number
  ): Promise<BrainList> {
    const result = await client.query(
      `SELECT ${listColumns()} FROM brain_lists
       WHERE repo_root = $1 AND collection = $2 AND name = $3
       FOR UPDATE`,
      [repoRoot, collection, name]
    );
    if (!result.rows[0]) {
      throw new BrainListNotFoundError(collection, name);
    }
    const list = mapList(result.rows[0]);
    if (expectedRevision !== undefined && list.revision !== expectedRevision) {
      throw new BrainRevisionConflictError(list);
    }
    return list;
  }

  private async getNextListIndex(
    client: PoolClient,
    repoRoot: string,
    collection: string,
    name: string
  ): Promise<number> {
    const result = await client.query(
      `SELECT COALESCE(MAX(item_index) + 1, 0)::int AS next_index
       FROM brain_list_items
       WHERE repo_root = $1 AND collection = $2 AND name = $3`,
      [repoRoot, collection, name]
    );
    return result.rows[0]?.next_index ?? 0;
  }

  private async trimListToMaxItems(
    client: PoolClient,
    repoRoot: string,
    collection: string,
    name: string,
    maxItems: number
  ): Promise<void> {
    await client.query(
      `WITH overflow AS (
         SELECT GREATEST(COUNT(*)::int - $4, 0) AS remove_count
         FROM brain_list_items
         WHERE repo_root = $1 AND collection = $2 AND name = $3
       ), ranked AS (
         SELECT items.repo_root,
                items.collection,
                items.name,
                items.item_index,
                ROW_NUMBER() OVER (ORDER BY items.item_index ASC) AS row_num,
                overflow.remove_count
         FROM brain_list_items AS items
         CROSS JOIN overflow
         WHERE items.repo_root = $1 AND items.collection = $2 AND items.name = $3
       )
       DELETE FROM brain_list_items
       WHERE (repo_root, collection, name, item_index) IN (
         SELECT repo_root, collection, name, item_index
         FROM ranked
         WHERE row_num <= remove_count
       )`,
      [repoRoot, collection, name, maxItems]
    );
    await this.reindexListItems(client, repoRoot, collection, name);
  }

  private async findListItemForRemoval(
    client: PoolClient,
    repoRoot: string,
    collection: string,
    name: string,
    selector: {
      index?: number;
      where?: { field: string; equals: string };
    }
  ): Promise<BrainListItem | null> {
    if (selector.index !== undefined) {
      const result = await client.query(
        `SELECT ${listItemColumns()} FROM brain_list_items
         WHERE repo_root = $1 AND collection = $2 AND name = $3 AND item_index = $4`,
        [repoRoot, collection, name, selector.index]
      );
      return result.rows[0] ? mapListItem(result.rows[0]) : null;
    }

    const result = await client.query(
      `SELECT ${listItemColumns()} FROM brain_list_items
       WHERE repo_root = $1 AND collection = $2 AND name = $3
         AND value ->> $4 = $5
       ORDER BY item_index ASC
       LIMIT 1`,
      [
        repoRoot,
        collection,
        name,
        selector.where?.field,
        selector.where?.equals,
      ]
    );
    return result.rows[0] ? mapListItem(result.rows[0]) : null;
  }

  private async reindexListItems(
    client: PoolClient,
    repoRoot: string,
    collection: string,
    name: string
  ): Promise<void> {
    await client.query(
      `WITH ordered AS (
         SELECT ctid,
                ROW_NUMBER() OVER (ORDER BY item_index) - 1 AS next_index,
                ROW_NUMBER() OVER (ORDER BY item_index) + 1000000 AS temp_index
         FROM brain_list_items
         WHERE repo_root = $1 AND collection = $2 AND name = $3
       )
       UPDATE brain_list_items AS items
       SET item_index = ordered.temp_index
       FROM ordered
       WHERE items.ctid = ordered.ctid`,
      [repoRoot, collection, name]
    );
    await client.query(
      `WITH ordered AS (
         SELECT ctid, ROW_NUMBER() OVER (ORDER BY item_index) - 1 AS next_index
         FROM brain_list_items
         WHERE repo_root = $1 AND collection = $2 AND name = $3
       )
       UPDATE brain_list_items AS items
       SET item_index = ordered.next_index
       FROM ordered
       WHERE items.ctid = ordered.ctid`,
      [repoRoot, collection, name]
    );
  }

  private async bumpListRevision(
    client: PoolClient,
    repoRoot: string,
    collection: string,
    name: string,
    agentId: string,
    revision: number
  ): Promise<BrainList> {
    const result = await client.query(
      `UPDATE brain_lists
       SET revision = revision + 1, updated_at = now(), updated_by_agent_id = $1
       WHERE repo_root = $2 AND collection = $3 AND name = $4 AND revision = $5
       RETURNING ${listColumns()}`,
      [agentId, repoRoot, collection, name, revision]
    );
    if (!result.rows[0]) {
      const current = await this.getList(repoRoot, collection, name);
      if (!current) throw new BrainListNotFoundError(collection, name);
      throw new BrainRevisionConflictError(current);
    }
    return mapList(result.rows[0]);
  }

  private async getListLength(
    client: PoolClient,
    repoRoot: string,
    collection: string,
    name: string
  ): Promise<number> {
    const result = await client.query(
      `SELECT COUNT(*)::int AS total
       FROM brain_list_items
       WHERE repo_root = $1 AND collection = $2 AND name = $3`,
      [repoRoot, collection, name]
    );
    return result.rows[0]?.total ?? 0;
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

function listColumns(): string {
  return `
    collection,
    name,
    revision,
    created_at AS "createdAt",
    updated_at AS "updatedAt",
    created_by_agent_id AS "createdByAgentId",
    updated_by_agent_id AS "updatedByAgentId"
  `;
}

function mapList(row: Record<string, unknown>): BrainList {
  return row as BrainList;
}

function listItemColumns(): string {
  return `
    item_index AS "index",
    value,
    created_at AS "createdAt",
    updated_at AS "updatedAt"
  `;
}

function mapListItem(row: Record<string, unknown>): BrainListItem {
  return row as BrainListItem;
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
