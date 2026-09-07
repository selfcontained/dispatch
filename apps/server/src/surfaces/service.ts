import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type {
  Surface,
  SurfaceFooter,
  SurfaceHeader,
  SurfaceInteractionRecord as SurfaceInteraction,
  SurfaceInteractionResponse,
  SurfaceInteractionSummary,
} from "@dispatch/shared";
import {
  SURFACE_FOOTER_BLOCK_ID,
  SURFACE_SCHEMA_VERSION,
} from "@dispatch/shared";

import {
  interactionRequestSchema,
  surfaceDocumentSchema,
  type InteractionRequest,
  type InteractionStatus,
  type SurfaceBlock,
  type SurfaceIcon,
  type SurfaceLifecycle,
} from "./types.js";
import type { PublishUiEvent } from "../server/ui-events.js";

function surfaceNotice(kind: string, lines: string[]): string {
  return [
    `--- DISPATCH: ${kind} ---`,
    ...lines,
    `--- END DISPATCH: ${kind} ---`,
  ].join("\n");
}

export class SurfaceError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400
  ) {
    super(message);
  }
}

type SurfaceRow = {
  id: string;
  agent_id: string;
  title: string;
  icon: SurfaceIcon | null;
  schema_version: number;
  revision: number;
  lifecycle: SurfaceLifecycle;
  sort_order: number;
  header: SurfaceHeader | null;
  blocks: SurfaceBlock[];
  footer: SurfaceFooter | null;
  created_at: Date;
  updated_at: Date;
};
type InteractionRow = {
  id: string;
  agent_id: string;
  surface_id: string;
  schema_version: number;
  surface_revision: number;
  kind: "action" | "form_submit";
  intent: string;
  payload: Record<string, unknown>;
  definition_snapshot: Record<string, unknown>;
  status: InteractionStatus;
  outcome_message: string | null;
  created_at: Date;
  claimed_at: Date | null;
  resolved_at: Date | null;
};

function surfaceId(): string {
  return `tab_${randomUUID().replaceAll("-", "")}`;
}
function interactionId(): string {
  return `ix_${randomUUID().replaceAll("-", "")}`;
}
function toSurface(
  row: SurfaceRow,
  unresolved: number,
  latestInteractions: SurfaceInteractionSummary[] = []
): Surface {
  return {
    schemaVersion: row.schema_version,
    id: row.id,
    ownerAgentId: row.agent_id,
    title: row.title,
    ...(row.icon ? { icon: row.icon } : {}),
    revision: row.revision,
    lifecycle: row.lifecycle,
    sortOrder: row.sort_order,
    ...(row.header ? { header: row.header } : {}),
    blocks: row.blocks,
    ...(row.footer ? { footer: row.footer } : {}),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    unresolvedInteractionCount: unresolved,
    latestInteractions,
  };
}
function toInteraction(row: InteractionRow): SurfaceInteraction {
  return {
    schemaVersion: 1,
    id: row.id,
    agentId: row.agent_id,
    tabId: row.surface_id,
    tabRevision: row.surface_revision,
    kind: row.kind,
    intent: row.intent,
    payload: row.payload,
    definitionSnapshot: row.definition_snapshot,
    status: row.status,
    ...(row.outcome_message ? { outcomeMessage: row.outcome_message } : {}),
    createdAt: row.created_at.toISOString(),
    ...(row.claimed_at ? { claimedAt: row.claimed_at.toISOString() } : {}),
    ...(row.resolved_at ? { resolvedAt: row.resolved_at.toISOString() } : {}),
  };
}
function toInteractionSummary(row: InteractionRow): SurfaceInteractionSummary {
  return {
    id: row.id,
    tabRevision: row.surface_revision,
    blockId: String(row.payload.blockId),
    actionId: String(row.payload.actionId),
    ...(typeof row.payload.itemId === "string"
      ? { itemId: row.payload.itemId }
      : {}),
    kind: row.kind,
    status: row.status,
    ...(row.outcome_message ? { outcomeMessage: row.outcome_message } : {}),
    createdAt: row.created_at.toISOString(),
    ...(row.claimed_at ? { claimedAt: row.claimed_at.toISOString() } : {}),
    ...(row.resolved_at ? { resolvedAt: row.resolved_at.toISOString() } : {}),
  };
}
const unresolved = ["queued", "notified", "claimed"] as const;

export class SurfaceService {
  constructor(
    private readonly pool: Pool,
    private readonly deps: {
      publishUiEvent: PublishUiEvent;
      sendAgentPrompt?: (agentId: string, prompt: string) => Promise<void>;
    }
  ) {}

  private changed(
    agentId: string,
    surfaceId: string,
    change: "created" | "updated" | "deleted" | "reordered" | "interaction"
  ) {
    this.deps.publishUiEvent({
      type: "surface.changed",
      agentId,
      surfaceId,
      change,
    });
  }

  async list(agentId: string): Promise<Surface[]> {
    const owner = await this.pool.query(`SELECT 1 FROM agents WHERE id=$1`, [
      agentId,
    ]);
    if (!owner.rowCount) throw new SurfaceError("Agent not found.", 404);
    const result = await this.pool.query<
      SurfaceRow & { unresolved_count: number }
    >(
      `SELECT s.*, COUNT(i.id) FILTER (WHERE i.status = ANY($2))::int AS unresolved_count
       FROM agent_surfaces s LEFT JOIN agent_surface_interactions i ON i.surface_id = s.id
       WHERE s.agent_id = $1 AND s.deleted_at IS NULL
       GROUP BY s.id ORDER BY s.sort_order, s.created_at`,
      [agentId, unresolved]
    );
    const summaries = await this.latestInteractionSummaries(
      result.rows.map((row) => row.id)
    );
    return result.rows.map((r) =>
      toSurface(r, r.unresolved_count, summaries.get(r.id) ?? [])
    );
  }

  async get(surfaceId: string): Promise<Surface | null> {
    const result = await this.pool.query<
      SurfaceRow & { unresolved_count: number }
    >(
      `SELECT s.*, COUNT(i.id) FILTER (WHERE i.status = ANY($2))::int AS unresolved_count
       FROM agent_surfaces s LEFT JOIN agent_surface_interactions i ON i.surface_id = s.id
       WHERE s.id = $1 AND s.deleted_at IS NULL GROUP BY s.id`,
      [surfaceId, unresolved]
    );
    if (!result.rows[0]) return null;
    const summaries = await this.latestInteractionSummaries([surfaceId]);
    return toSurface(
      result.rows[0],
      result.rows[0].unresolved_count,
      summaries.get(surfaceId) ?? []
    );
  }

  private async latestInteractionSummaries(
    surfaceIds: string[]
  ): Promise<Map<string, SurfaceInteractionSummary[]>> {
    const bySurface = new Map<string, SurfaceInteractionSummary[]>();
    if (!surfaceIds.length) return bySurface;
    const result = await this.pool.query<InteractionRow>(
      `SELECT DISTINCT ON (surface_id, payload->>'blockId', payload->>'itemId', payload->>'actionId') *
       FROM agent_surface_interactions
       WHERE surface_id=ANY($1)
       ORDER BY surface_id, payload->>'blockId', payload->>'itemId', payload->>'actionId', created_at DESC, id DESC`,
      [surfaceIds]
    );
    for (const row of result.rows) {
      const summaries = bySurface.get(row.surface_id) ?? [];
      summaries.push(toInteractionSummary(row));
      bySurface.set(row.surface_id, summaries);
    }
    return bySurface;
  }

  async assertReadable(requesterId: string, ownerId: string): Promise<void> {
    if (requesterId === ownerId) return;
    const result = await this.pool.query(
      `SELECT 1 FROM agents WHERE id = $1 AND parent_agent_id = $2 AND deleted_at IS NULL`,
      [ownerId, requesterId]
    );
    if (!result.rowCount) throw new SurfaceError("Surface not found.", 404);
  }

  async create(agentId: string, document: unknown): Promise<Surface> {
    const parsed = surfaceDocumentSchema.safeParse(document);
    if (!parsed.success)
      throw new SurfaceError(
        `Invalid surface: ${parsed.error.issues[0]?.message ?? "invalid document"}.`
      );
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const owner = await client.query(
        `SELECT status, deleted_at FROM agents WHERE id = $1 FOR UPDATE`,
        [agentId]
      );
      if (!owner.rows[0] || owner.rows[0].deleted_at)
        throw new SurfaceError("Agent not found.", 404);
      if (owner.rows[0].status === "archiving")
        throw new SurfaceError("Archived agents cannot create surfaces.", 409);
      const count = await client.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM agent_surfaces WHERE agent_id = $1 AND deleted_at IS NULL`,
        [agentId]
      );
      if (count.rows[0].count >= 8)
        throw new SurfaceError(
          "An agent may have at most 8 active surfaces.",
          409
        );
      const order = await client.query<{ next: number }>(
        `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM agent_surfaces WHERE agent_id = $1 AND deleted_at IS NULL`,
        [agentId]
      );
      const id = surfaceId();
      const row = await client.query<SurfaceRow>(
        `INSERT INTO agent_surfaces (id, agent_id, title, icon, sort_order, schema_version, header, blocks, footer) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [
          id,
          agentId,
          parsed.data.title,
          parsed.data.icon ?? null,
          order.rows[0].next,
          SURFACE_SCHEMA_VERSION,
          parsed.data.header ? JSON.stringify(parsed.data.header) : null,
          JSON.stringify(parsed.data.blocks),
          parsed.data.footer ? JSON.stringify(parsed.data.footer) : null,
        ]
      );
      await client.query("COMMIT");
      const result = toSurface(row.rows[0], 0);
      this.changed(agentId, id, "created");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async update(
    agentId: string,
    id: string,
    expectedRevision: number,
    patch: {
      title?: unknown;
      icon?: unknown;
      header?: unknown;
      blocks?: unknown;
      footer?: unknown;
      lifecycle?: unknown;
    }
  ): Promise<Surface> {
    const current = await this.getOwned(id, agentId);
    if (current.lifecycle === "frozen")
      throw new SurfaceError("Frozen surfaces cannot be updated.", 409);
    if (
      current.schemaVersion !== SURFACE_SCHEMA_VERSION &&
      patch.blocks === undefined
    )
      throw new SurfaceError(
        `This surface was authored under schema v${current.schemaVersion}; supply a complete v${SURFACE_SCHEMA_VERSION} blocks array (plus optional header/footer) to upgrade it, or delete and recreate the tab.`,
        409
      );
    const nextIcon =
      patch.icon === null ? undefined : (patch.icon ?? current.icon);
    // Like icon, header/footer use null-to-clear semantics; omitting keeps
    // the stored slot.
    const nextHeader =
      patch.header === null ? undefined : (patch.header ?? current.header);
    const nextFooter =
      patch.footer === null ? undefined : (patch.footer ?? current.footer);
    const document = {
      title: patch.title ?? current.title,
      blocks: patch.blocks ?? current.blocks,
      ...(nextIcon ? { icon: nextIcon } : {}),
      ...(nextHeader ? { header: nextHeader } : {}),
      ...(nextFooter ? { footer: nextFooter } : {}),
    };
    const parsed = surfaceDocumentSchema.safeParse(document);
    if (!parsed.success)
      throw new SurfaceError(
        `Invalid surface: ${parsed.error.issues[0]?.message ?? "invalid document"}.`
      );
    const lifecycle =
      patch.lifecycle === undefined ? current.lifecycle : patch.lifecycle;
    if (lifecycle !== "active" && lifecycle !== "frozen")
      throw new SurfaceError("lifecycle must be active or frozen.");
    const result = await this.pool.query<SurfaceRow>(
      `UPDATE agent_surfaces SET title=$4, icon=$5, header=$6, blocks=$7, footer=$8, lifecycle=$9, schema_version=$10, revision=revision+1, updated_at=NOW()
       WHERE id=$1 AND agent_id=$2 AND revision=$3 AND deleted_at IS NULL RETURNING *`,
      [
        id,
        agentId,
        expectedRevision,
        parsed.data.title,
        parsed.data.icon ?? null,
        parsed.data.header ? JSON.stringify(parsed.data.header) : null,
        JSON.stringify(parsed.data.blocks),
        parsed.data.footer ? JSON.stringify(parsed.data.footer) : null,
        lifecycle,
        SURFACE_SCHEMA_VERSION,
      ]
    );
    if (!result.rows[0])
      throw new SurfaceError("Surface revision conflict.", 409);
    this.changed(agentId, id, "updated");
    return toSurface(
      result.rows[0],
      current.unresolvedInteractionCount,
      current.latestInteractions
    );
  }

  async reorder(agentId: string, orderedIds: string[]): Promise<void> {
    if (new Set(orderedIds).size !== orderedIds.length)
      throw new SurfaceError("surfaceIds must not contain duplicates.");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const rows = await client.query<{ id: string }>(
        `SELECT id FROM agent_surfaces WHERE agent_id=$1 AND deleted_at IS NULL FOR UPDATE`,
        [agentId]
      );
      const existing = rows.rows.map((r) => r.id);
      if (
        existing.length !== orderedIds.length ||
        existing.some((id) => !orderedIds.includes(id))
      )
        throw new SurfaceError(
          "surfaceIds must contain every active owned surface exactly once.",
          409
        );
      for (let i = 0; i < orderedIds.length; i++)
        await client.query(
          `UPDATE agent_surfaces SET sort_order=$3, updated_at=NOW() WHERE id=$1 AND agent_id=$2`,
          [orderedIds[i], agentId, i]
        );
      await client.query("COMMIT");
      for (const id of orderedIds) this.changed(agentId, id, "reordered");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async delete(
    agentId: string,
    id: string,
    expectedRevision: number,
    force = false
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const row = await client.query<SurfaceRow>(
        `SELECT * FROM agent_surfaces WHERE id=$1 AND agent_id=$2 AND deleted_at IS NULL FOR UPDATE`,
        [id, agentId]
      );
      if (!row.rows[0]) throw new SurfaceError("Surface not found.", 404);
      if (row.rows[0].revision !== expectedRevision)
        throw new SurfaceError("Surface revision conflict.", 409);
      const pending = await client.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM agent_surface_interactions WHERE surface_id=$1 AND status=ANY($2)`,
        [id, unresolved]
      );
      if (pending.rows[0].count && !force)
        throw new SurfaceError(
          "Surface has unresolved interactions; pass force to cancel them.",
          409
        );
      if (force)
        await client.query(
          `UPDATE agent_surface_interactions SET status='cancelled', resolved_at=NOW() WHERE surface_id=$1 AND status=ANY($2)`,
          [id, unresolved]
        );
      await client.query(
        `UPDATE agent_surfaces SET deleted_at=NOW(), lifecycle='frozen', updated_at=NOW() WHERE id=$1`,
        [id]
      );
      await client.query("COMMIT");
      this.changed(agentId, id, "deleted");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async getOwned(id: string, agentId: string): Promise<Surface> {
    const surface = await this.get(id);
    if (!surface || surface.ownerAgentId !== agentId)
      throw new SurfaceError("Surface not found.", 404);
    return surface;
  }

  async submitInteraction(
    agentId: string,
    id: string,
    input: unknown
  ): Promise<SurfaceInteractionResponse> {
    const parsed = interactionRequestSchema.safeParse(input);
    if (!parsed.success)
      throw new SurfaceError(
        `Invalid interaction: ${parsed.error.issues[0]?.message ?? "invalid request"}.`
      );
    const surface = await this.getOwned(id, agentId);
    const prior = await this.pool.query<InteractionRow>(
      `SELECT * FROM agent_surface_interactions WHERE surface_id=$1 AND idempotency_key=$2`,
      [id, parsed.data.idempotencyKey]
    );
    if (prior.rows[0])
      return {
        interaction: toInteraction(prior.rows[0]),
        delivery: prior.rows[0].status === "queued" ? "queued" : "notified",
        duplicate: true,
      };
    if (surface.lifecycle !== "active")
      throw new SurfaceError(
        "This surface is frozen and no longer accepts interactions.",
        409
      );
    if (surface.schemaVersion !== SURFACE_SCHEMA_VERSION)
      throw new SurfaceError(
        "This surface uses an older schema and no longer accepts interactions; the agent must recreate it.",
        409
      );
    if (surface.revision !== parsed.data.baseRevision)
      throw new SurfaceError(
        "Surface revision conflict; reload before submitting.",
        409
      );
    const agent = await this.pool.query<{
      status: string;
      deleted_at: Date | null;
    }>(`SELECT status, deleted_at FROM agents WHERE id=$1`, [agentId]);
    if (
      !agent.rows[0] ||
      agent.rows[0].deleted_at ||
      agent.rows[0].status === "archiving"
    )
      throw new SurfaceError(
        "Archived surfaces do not accept interactions.",
        409
      );
    const captured = validateAndCapture(surface, parsed.data);
    const newId = interactionId();
    let row: InteractionRow;
    let duplicate = false;
    try {
      const inserted = await this.pool.query<InteractionRow>(
        `WITH locked_surface AS (
           SELECT s.id
           FROM agent_surfaces s JOIN agents a ON a.id=s.agent_id
           WHERE s.id=$3 AND s.agent_id=$2 AND s.revision=$4
             AND s.lifecycle='active' AND s.deleted_at IS NULL
             AND a.deleted_at IS NULL AND a.status <> 'archiving'
           FOR UPDATE OF s
         )
         INSERT INTO agent_surface_interactions (id,agent_id,surface_id,surface_revision,idempotency_key,kind,intent,payload,definition_snapshot,once_form_block_id)
         SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10 FROM locked_surface RETURNING *`,
        [
          newId,
          agentId,
          id,
          surface.revision,
          parsed.data.idempotencyKey,
          parsed.data.kind,
          captured.intent,
          JSON.stringify(captured.payload),
          JSON.stringify(captured.snapshot),
          captured.onceFormBlockId,
        ]
      );
      if (!inserted.rows[0])
        throw new SurfaceError(
          "Surface changed while submitting; reload before trying again.",
          409
        );
      row = inserted.rows[0];
    } catch (error) {
      if ((error as { code?: string }).code !== "23505") throw error;
      const existing = await this.pool.query<InteractionRow>(
        `SELECT * FROM agent_surface_interactions WHERE surface_id=$1 AND idempotency_key=$2`,
        [id, parsed.data.idempotencyKey]
      );
      if (!existing.rows[0])
        throw new SurfaceError("This form accepts only one submission.", 409);
      row = existing.rows[0];
      duplicate = true;
    }
    let delivery: "queued" | "notified" =
      row.status === "queued" ? "queued" : "notified";
    if (
      !duplicate &&
      agent.rows[0].status === "running" &&
      this.deps.sendAgentPrompt
    ) {
      try {
        await this.deps.sendAgentPrompt(
          agentId,
          surfaceNotice("SURFACE INTERACTION", [
            `Interaction ID: ${row.id}`,
            "A user submitted an interaction. Use dispatch_surface_interactions or dispatch_surface_claim to read the durable record; do not infer values from this notice.",
          ])
        );
        const updated = await this.pool.query<InteractionRow>(
          `UPDATE agent_surface_interactions SET status='notified' WHERE id=$1 AND status='queued' RETURNING *`,
          [row.id]
        );
        if (updated.rows[0]) row = updated.rows[0];
        delivery = "notified";
      } catch {
        delivery = "queued";
      }
    }
    this.changed(agentId, id, "interaction");
    return { interaction: toInteraction(row), delivery, duplicate };
  }

  async listInteractions(
    agentId: string,
    opts: { tabId?: string; status?: InteractionStatus; limit?: number }
  ): Promise<SurfaceInteraction[]> {
    const values: unknown[] = [agentId];
    const where = ["agent_id=$1"];
    if (opts.tabId) {
      values.push(opts.tabId);
      where.push(`surface_id=$${values.length}`);
    }
    if (opts.status) {
      values.push(opts.status);
      where.push(`status=$${values.length}`);
    }
    values.push(Math.min(Math.max(opts.limit ?? 50, 1), 100));
    const result = await this.pool.query<InteractionRow>(
      `SELECT * FROM agent_surface_interactions WHERE ${where.join(" AND ")} ORDER BY created_at LIMIT $${values.length}`,
      values
    );
    return result.rows.map(toInteraction);
  }

  async claim(agentId: string, ids: string[]): Promise<SurfaceInteraction[]> {
    if (!ids.length || ids.length > 100 || new Set(ids).size !== ids.length)
      throw new SurfaceError(
        "ids must contain 1 to 100 unique interaction IDs."
      );
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const found = await client.query<{ id: string }>(
        `SELECT id FROM agent_surface_interactions WHERE agent_id=$1 AND id=ANY($2) AND status IN ('queued','notified','claimed') FOR UPDATE`,
        [agentId, ids]
      );
      if (found.rows.length !== ids.length)
        throw new SurfaceError(
          "One or more interactions were not claimable.",
          409
        );
      const result = await client.query<InteractionRow>(
        `UPDATE agent_surface_interactions SET status='claimed', claimed_at=COALESCE(claimed_at,NOW()) WHERE agent_id=$1 AND id=ANY($2) RETURNING *`,
        [agentId, ids]
      );
      await client.query("COMMIT");
      for (const row of result.rows)
        this.changed(agentId, row.surface_id, "interaction");
      return result.rows.map(toInteraction);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async resolve(
    agentId: string,
    id: string,
    outcome: "completed" | "rejected",
    message?: string
  ): Promise<SurfaceInteraction> {
    const result = await this.pool.query<InteractionRow>(
      `UPDATE agent_surface_interactions SET status=$3, outcome_message=$4, resolved_at=NOW() WHERE agent_id=$1 AND id=$2 AND status IN ('queued','notified','claimed') RETURNING *`,
      [agentId, id, outcome, message ?? null]
    );
    if (!result.rows[0])
      throw new SurfaceError("Interaction not found or already resolved.", 409);
    this.changed(agentId, result.rows[0].surface_id, "interaction");
    return toInteraction(result.rows[0]);
  }

  async freezeForArchive(agentId: string): Promise<void> {
    await this.pool.query(
      `UPDATE agent_surfaces SET lifecycle='frozen', revision=revision+1, updated_at=NOW() WHERE agent_id=$1 AND deleted_at IS NULL AND lifecycle='active'`,
      [agentId]
    );
    await this.pool.query(
      `UPDATE agent_surface_interactions SET status='orphaned', resolved_at=NOW() WHERE agent_id=$1 AND status=ANY($2)`,
      [agentId, unresolved]
    );
  }

  async notifyQueuedAfterResume(agentId: string): Promise<void> {
    if (!this.deps.sendAgentPrompt) return;
    const queued = await this.pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM agent_surface_interactions WHERE agent_id=$1 AND status='queued'`,
      [agentId]
    );
    if (!queued.rows[0]?.count) return;
    try {
      await this.deps.sendAgentPrompt(
        agentId,
        surfaceNotice("SURFACE INTERACTIONS QUEUED", [
          `Queued interactions: ${queued.rows[0].count}`,
          "Use dispatch_surface_interactions then dispatch_surface_claim to read the durable records.",
        ])
      );
      const changed = await this.pool.query<{ surface_id: string }>(
        `UPDATE agent_surface_interactions SET status='notified' WHERE agent_id=$1 AND status='queued' RETURNING surface_id`,
        [agentId]
      );
      for (const surfaceId of new Set(
        changed.rows.map((row) => row.surface_id)
      ))
        this.changed(agentId, surfaceId, "interaction");
    } catch {
      // Persistence is the contract; a later resume or explicit inbox read can retry delivery.
    }
  }
}

function assertActionEnabled(action: {
  disabled?: boolean;
  disabledReason?: string;
  id: string;
}): void {
  if (action.disabled)
    throw new SurfaceError(
      typeof action.disabledReason === "string"
        ? action.disabledReason
        : "This action is disabled.",
      409
    );
}

function validateAndCapture(
  surface: Surface,
  request: InteractionRequest
): {
  intent: string;
  payload: Record<string, unknown>;
  snapshot: Record<string, unknown>;
  onceFormBlockId: string | null;
} {
  // Document footer actions are addressed with the reserved block id.
  if (request.blockId === SURFACE_FOOTER_BLOCK_ID) {
    if (request.kind !== "action")
      throw new SurfaceError("Form submissions must reference a form block.");
    if (request.itemId)
      throw new SurfaceError("This action does not accept an itemId.");
    const action = surface.footer?.actions.find(
      (candidate) => candidate.id === request.actionId
    );
    if (!action) throw new SurfaceError("Referenced action does not exist.");
    assertActionEnabled(action);
    return {
      intent: action.intent,
      payload: { blockId: SURFACE_FOOTER_BLOCK_ID, actionId: action.id },
      snapshot: { footer: surface.footer, action },
      onceFormBlockId: null,
    };
  }
  const findBlock = (blocks: SurfaceBlock[]): SurfaceBlock | undefined => {
    for (const candidate of blocks) {
      if (candidate.id === request.blockId) return candidate;
      if (candidate.type === "section") {
        const nested = findBlock(candidate.blocks);
        if (nested) return nested;
      }
    }
    return undefined;
  };
  const block = findBlock(surface.blocks);
  if (!block) throw new SurfaceError("Referenced block does not exist.");
  const itemId = request.kind === "action" ? request.itemId : undefined;
  if (
    request.kind === "action" &&
    (block.type === "list" || block.type === "table") &&
    !itemId
  )
    throw new SurfaceError("Item actions must include an itemId.");
  if (
    request.kind === "action" &&
    (block.type === "section" || block.type === "form") &&
    itemId
  )
    throw new SurfaceError("This action does not accept an itemId.");
  const item =
    block.type === "list"
      ? block.items.find((candidate) => candidate.id === itemId)
      : block.type === "table"
        ? block.rows.find((candidate) => candidate.id === itemId)
        : undefined;
  const action =
    block.type === "section"
      ? (block.actions ?? []).find((a) => a.id === request.actionId)
      : item
        ? (item.actions ?? []).find((a) => a.id === request.actionId)
        : block.type === "form" && block.submit.id === request.actionId
          ? block.submit
          : undefined;
  if (!action) throw new SurfaceError("Referenced action does not exist.");
  assertActionEnabled(action);
  if (request.kind === "action") {
    if (block.type !== "section" && !item)
      throw new SurfaceError(
        "Action interactions must reference a section's actions, the document footer, or an item action."
      );
    // A section's snapshot omits its descendant tree: a section may hold up
    // to 100 nested blocks, and duplicating that subtree into every durable
    // interaction record would let repeated clicks amplify storage. The
    // section's own metadata plus the selected action is what audit needs.
    const blockSnapshot =
      block.type === "section"
        ? (({ blocks: _children, ...sectionMeta }) => sectionMeta)(block)
        : block;
    return {
      intent: action.intent,
      payload: {
        blockId: block.id,
        ...(item ? { itemId: item.id } : {}),
        actionId: action.id,
      },
      snapshot: { block: blockSnapshot, ...(item ? { item } : {}), action },
      onceFormBlockId: null,
    };
  }
  if (block.type !== "form")
    throw new SurfaceError("Form submissions must reference a form block.");
  const normalized: Record<string, unknown> = {};
  const supplied = request.values;
  for (const key of Object.keys(supplied))
    if (!block.fields.some((field) => field.id === key))
      throw new SurfaceError(`Unknown form field: ${key}.`);
  for (const field of block.fields) {
    const value = supplied[field.id];
    if (
      value === undefined ||
      value === null ||
      value === "" ||
      (Array.isArray(value) && value.length === 0)
    ) {
      if (field.required) throw new SurfaceError(`${field.label} is required.`);
      continue;
    }
    if (field.type === "text" || field.type === "textarea") {
      if (typeof value !== "string")
        throw new SurfaceError(`${field.label} must be text.`);
      if (field.minLength !== undefined && value.length < field.minLength)
        throw new SurfaceError(`${field.label} is too short.`);
      if (field.maxLength !== undefined && value.length > field.maxLength)
        throw new SurfaceError(`${field.label} is too long.`);
    } else if (field.type === "checkbox") {
      if (typeof value !== "boolean")
        throw new SurfaceError(`${field.label} must be true or false.`);
    } else if (field.type === "number") {
      if (typeof value !== "number" || !Number.isFinite(value))
        throw new SurfaceError(`${field.label} must be a number.`);
      if (field.min !== undefined && value < field.min)
        throw new SurfaceError(`${field.label} is below its minimum.`);
      if (field.max !== undefined && value > field.max)
        throw new SurfaceError(`${field.label} is above its maximum.`);
    } else if ("options" in field) {
      const values = Array.isArray(value) ? value : [value];
      if (
        values.some(
          (v) =>
            typeof v !== "string" ||
            !field.options.some((o) => o.value === v && !o.disabled)
        )
      )
        throw new SurfaceError(`${field.label} contains an invalid option.`);
      if (field.type === "radio" && values.length !== 1)
        throw new SurfaceError(`${field.label} accepts one option.`);
      if (field.type === "select" && !field.multiple && values.length !== 1)
        throw new SurfaceError(`${field.label} accepts one option.`);
    }
    normalized[field.id] = value;
  }
  return {
    intent: action.intent,
    payload: { blockId: block.id, actionId: action.id, values: normalized },
    snapshot: { block, action },
    onceFormBlockId: block.submitMode === "once" ? block.id : null,
  };
}
