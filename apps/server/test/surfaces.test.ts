import { beforeEach, describe, expect, it, vi } from "vitest";

import { useInjectApp } from "./helpers/inject-app.js";
import { surfaceExamples } from "../src/db/seed/surfaces.js";
import { SurfaceService } from "../src/surfaces/service.js";
import {
  MAX_SURFACE_TOP_LEVEL_BLOCKS,
  surfaceDocumentSchema,
} from "../src/surfaces/types.js";

const ctx = useInjectApp();
let agentId: string;
let service: SurfaceService;
const events: unknown[] = [];

async function authed(method: "GET" | "POST", url: string, payload?: unknown) {
  return ctx.app.inject({
    method,
    url,
    headers: { cookie: await ctx.sessionCookie() },
    ...(payload === undefined ? {} : { payload }),
  });
}

const actionDocument = {
  title: "Release choice",
  icon: "flag",
  blocks: [{ id: "context", type: "text", text: "Choose the rollout shape." }],
  footer: {
    actions: [
      {
        id: "canary",
        label: "Use canary",
        intent: "choose_canary",
        style: "primary",
      },
      {
        id: "disabled",
        label: "Unavailable",
        intent: "disabled",
        disabled: true,
      },
    ],
  },
};

beforeEach(async () => {
  await ctx.pool.query("DELETE FROM agent_surface_interactions");
  await ctx.pool.query("DELETE FROM agent_surfaces");
  await ctx.pool.query("DELETE FROM agent_messages");
  await ctx.pool.query("DELETE FROM media_seen");
  await ctx.pool.query("DELETE FROM media");
  await ctx.pool.query("DELETE FROM job_runs");
  await ctx.pool.query("DELETE FROM jobs");
  await ctx.pool.query("DELETE FROM agents");
  const response = await authed("POST", "/api/v1/agents", {
    cwd: "/tmp",
    useWorktree: false,
    name: "Surface owner",
  });
  expect(response.statusCode).toBe(201);
  agentId = response.json().agent.id;
  events.length = 0;
  service = new SurfaceService(ctx.pool, {
    publishUiEvent: (event) => events.push(event),
  });
});

describe("surface API", () => {
  it("lists authored documents with canonical order and unresolved counts", async () => {
    const first = await service.create(agentId, actionDocument);
    const second = await service.create(agentId, {
      title: "Notes",
      blocks: [{ id: "text", type: "text", text: "Hello" }],
    });
    await service.reorder(agentId, [second.id, first.id]);

    const response = await authed("GET", `/api/v1/agents/${agentId}/surfaces`);
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.surfaces.map((surface: { id: string }) => surface.id)).toEqual([
      second.id,
      first.id,
    ]);
    expect(body.surfaces[1]).toMatchObject({
      schemaVersion: 2,
      title: "Release choice",
      revision: 1,
      unresolvedInteractionCount: 0,
      latestInteractions: [],
    });
    // The HTTP list returns full documents; the MCP list below is the
    // summary projection and must exclude blocks and both slots.
    expect(events).toContainEqual({
      type: "surface.changed",
      agentId,
      surfaceId: first.id,
      change: "created",
    });
  });

  it("returns 404 when the owner agent does not exist", async () => {
    const response = await authed("GET", "/api/v1/agents/agt_missing/surfaces");
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Agent not found." });
  });

  it("persists before delivery, validates stable IDs, and deduplicates retries", async () => {
    const surface = await service.create(agentId, actionDocument);
    await ctx.pool.query(`UPDATE agents SET status='stopped' WHERE id=$1`, [
      agentId,
    ]);
    const request = {
      idempotencyKey: "click-1",
      kind: "action",
      blockId: "footer",
      actionId: "canary",
      baseRevision: 1,
    };
    const first = await authed(
      "POST",
      `/api/v1/agents/${agentId}/surfaces/${surface.id}/interactions`,
      request
    );
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({
      delivery: "queued",
      duplicate: false,
      interaction: {
        status: "queued",
        intent: "choose_canary",
        payload: { blockId: "footer", actionId: "canary" },
      },
    });

    const replay = await authed(
      "POST",
      `/api/v1/agents/${agentId}/surfaces/${surface.id}/interactions`,
      request
    );
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({
      duplicate: true,
      interaction: { id: first.json().interaction.id },
    });

    const invalid = await authed(
      "POST",
      `/api/v1/agents/${agentId}/surfaces/${surface.id}/interactions`,
      { ...request, idempotencyKey: "click-2", actionId: "made-up" }
    );
    expect(invalid.statusCode).toBe(400);
    const disabled = await authed(
      "POST",
      `/api/v1/agents/${agentId}/surfaces/${surface.id}/interactions`,
      { ...request, idempotencyKey: "click-3", actionId: "disabled" }
    );
    expect(disabled.statusCode).toBe(409);

    const listed = await authed("GET", `/api/v1/agents/${agentId}/surfaces`);
    expect(listed.json().surfaces[0].latestInteractions).toEqual([
      expect.objectContaining({
        id: first.json().interaction.id,
        tabRevision: 1,
        blockId: "footer",
        actionId: "canary",
        kind: "action",
        status: "queued",
        createdAt: expect.any(String),
      }),
    ]);
  });

  it("exposes the complete owner tool family over agent-scoped MCP", async () => {
    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/mcp/${agentId}`,
      headers: {
        cookie: await ctx.sessionCookie(),
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    });
    expect(response.statusCode).toBe(200);
    const data = response.body
      .split("\n")
      .find((line) => line.startsWith("data: "));
    const names = JSON.parse(data!.slice(6)).result.tools.map(
      (tool: { name: string }) => tool.name
    );
    expect(names).toEqual(
      expect.arrayContaining([
        "dispatch_surface_create",
        "dispatch_surface_update",
        "dispatch_surface_list",
        "dispatch_surface_get",
        "dispatch_surface_delete",
        "dispatch_surface_reorder",
        "dispatch_surface_interactions",
        "dispatch_surface_claim",
        "dispatch_surface_resolve",
      ])
    );
  });

  it("keeps the MCP surface list a summary projection without slots", async () => {
    await service.create(agentId, actionDocument);
    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/mcp/${agentId}`,
      headers: {
        cookie: await ctx.sessionCookie(),
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      payload: {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "dispatch_surface_list", arguments: {} },
      },
    });
    expect(response.statusCode).toBe(200);
    const data = response.body
      .split("\n")
      .find((line) => line.startsWith("data: "));
    const result = JSON.parse(data!.slice(6)).result;
    const listed = result.structuredContent.surfaces[0];
    expect(listed.title).toBe("Release choice");
    expect(listed).not.toHaveProperty("blocks");
    expect(listed).not.toHaveProperty("header");
    expect(listed).not.toHaveProperty("footer");
  });
});

describe("surface authoring and inbox", () => {
  it("accepts rich list items and rejects the retired state enum", () => {
    const document = {
      title: "Deployment steps",
      blocks: [
        {
          id: "steps",
          type: "list" as const,
          style: "check" as const,
          showItemCount: true,
          collapse: { after: 2, label: "Show remaining steps" },
          items: [
            {
              id: "prepare",
              text: "Prepare release",
              status: "In progress",
              tone: "info" as const,
              checked: false,
              group: "Before rollout",
              url: "https://example.com/runbook",
              actions: [
                {
                  id: "open-runbook",
                  label: "Open runbook",
                  intent: "open_release_runbook",
                },
              ],
            },
            { id: "verify", text: "Verify health" },
            { id: "announce", text: "Announce release" },
          ],
        },
      ],
    };
    expect(surfaceDocumentSchema.safeParse(document).success).toBe(true);
    expect(
      surfaceDocumentSchema.safeParse({
        ...document,
        blocks: [
          {
            ...document.blocks[0],
            collapse: { after: 3 },
            items: [{ id: "legacy", text: "Legacy", state: "done" }],
          },
        ],
      }).success
    ).toBe(false);
    // A collapse setting that currently hides nothing is valid: it remains
    // useful when a dynamic list grows again.
    expect(
      surfaceDocumentSchema.safeParse({
        ...document,
        blocks: [{ ...document.blocks[0], collapse: { after: 3 } }],
      }).success
    ).toBe(true);
    expect(
      surfaceDocumentSchema.safeParse({
        ...document,
        blocks: [{ ...document.blocks[0], collapse: { after: 0 } }],
      }).success
    ).toBe(false);
  });

  it("captures list and table item actions with unambiguous durable identity", async () => {
    const surface = await service.create(agentId, {
      title: "Action queue",
      blocks: [
        {
          id: "tasks",
          type: "list",
          items: [
            {
              id: "first",
              text: "First task",
              actions: [{ id: "run", label: "Run", intent: "run_first" }],
            },
            {
              id: "second",
              text: "Second task",
              actions: [{ id: "run", label: "Run", intent: "run_second" }],
            },
          ],
        },
        {
          id: "services",
          type: "table",
          showItemCount: true,
          columns: [{ id: "name", label: "Service" }],
          rows: [
            {
              id: "api",
              cells: { name: "API" },
              actions: [
                {
                  id: "restart",
                  label: "Restart",
                  intent: "restart_api",
                },
              ],
            },
          ],
        },
      ],
    });
    const list = await service.submitInteraction(agentId, surface.id, {
      idempotencyKey: "list-item",
      kind: "action",
      blockId: "tasks",
      itemId: "second",
      actionId: "run",
      baseRevision: 1,
    });
    expect(list.interaction).toMatchObject({
      intent: "run_second",
      payload: { blockId: "tasks", itemId: "second", actionId: "run" },
      definitionSnapshot: {
        item: { id: "second" },
        action: { id: "run", intent: "run_second" },
      },
    });
    const secondListItem = await service.submitInteraction(
      agentId,
      surface.id,
      {
        idempotencyKey: "list-first-item",
        kind: "action",
        blockId: "tasks",
        itemId: "first",
        actionId: "run",
        baseRevision: 1,
      }
    );
    expect(secondListItem.interaction.intent).toBe("run_first");
    const table = await service.submitInteraction(agentId, surface.id, {
      idempotencyKey: "table-row",
      kind: "action",
      blockId: "services",
      itemId: "api",
      actionId: "restart",
      baseRevision: 1,
    });
    expect(table.interaction.payload).toEqual({
      blockId: "services",
      itemId: "api",
      actionId: "restart",
    });
    await expect(
      service.submitInteraction(agentId, surface.id, {
        idempotencyKey: "missing-item",
        kind: "action",
        blockId: "tasks",
        actionId: "run",
        baseRevision: 1,
      })
    ).rejects.toThrow(/must include an itemId/);
    expect((await service.get(surface.id))?.latestInteractions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          blockId: "tasks",
          itemId: "first",
          actionId: "run",
        }),
        expect.objectContaining({
          blockId: "tasks",
          itemId: "second",
          actionId: "run",
        }),
        expect.objectContaining({
          blockId: "services",
          itemId: "api",
          actionId: "restart",
        }),
      ])
    );
  });

  it("validates bounded recursive sections and captures nested interactions", async () => {
    const document = {
      title: "Release plan",
      blocks: [
        {
          id: "rollout",
          type: "section" as const,
          title: "Rollout",
          description: "The current deployment steps.",
          collapse: { initiallyCollapsed: true },
          blocks: [
            { id: "deploy", type: "text" as const, text: "Deploy steps." },
          ],
          actions: [{ id: "start", label: "Start", intent: "start_deploy" }],
        },
      ],
    };
    expect(surfaceDocumentSchema.safeParse(document).success).toBe(true);
    expect(
      surfaceDocumentSchema.safeParse({
        ...document,
        blocks: [{ ...document.blocks[0], title: "   " }],
      }).success
    ).toBe(false);
    expect(
      surfaceDocumentSchema.safeParse({
        ...document,
        blocks: [
          ...document.blocks,
          {
            id: "other-section",
            type: "section" as const,
            title: "Other",
            blocks: [
              { id: "deploy", type: "text" as const, text: "Duplicate" },
            ],
          },
        ],
      }).success
    ).toBe(false);
    expect(
      surfaceDocumentSchema.safeParse({
        ...document,
        blocks: [
          {
            ...document.blocks[0],
            blocks: Array.from({ length: 21 }, (_, index) => ({
              id: `child-${index}`,
              type: "text" as const,
              text: "Step",
            })),
          },
        ],
      }).success
    ).toBe(false);
    const maximumSizedDocument = {
      title: "Maximum surface",
      blocks: [
        ...Array.from({ length: 5 }, (_, section) => ({
          id: `max-section-${section}`,
          type: "section" as const,
          title: `Section ${section}`,
          blocks: Array.from({ length: 20 }, (_, child) => ({
            id: `max-child-${section}-${child}`,
            type: "text" as const,
            text: "Nested block",
          })),
        })),
        ...Array.from({ length: 95 }, (_, index) => ({
          id: `max-top-level-${index}`,
          type: "text" as const,
          text: "Top-level block",
        })),
      ],
    };
    expect(surfaceDocumentSchema.safeParse(maximumSizedDocument).success).toBe(
      true
    );
    const tooManyNested = {
      ...document,
      blocks: Array.from({ length: 6 }, (_, section) => ({
        id: `section-${section}`,
        type: "section" as const,
        title: `Section ${section}`,
        blocks: Array.from({ length: 20 }, (_, child) => ({
          id: `block-${section}-${child}`,
          type: "text" as const,
          text: "Step",
        })),
      })),
    };
    expect(surfaceDocumentSchema.safeParse(tooManyNested).success).toBe(false);

    const surface = await service.create(agentId, document);
    const result = await service.submitInteraction(agentId, surface.id, {
      idempotencyKey: "nested-start",
      kind: "action",
      blockId: "rollout",
      actionId: "start",
      baseRevision: 1,
    });
    expect(result.interaction).toMatchObject({
      intent: "start_deploy",
      payload: { blockId: "rollout", actionId: "start" },
      definitionSnapshot: {
        block: { id: "rollout", type: "section" },
        action: { id: "start", intent: "start_deploy" },
      },
    });
    // The snapshot keeps the section's metadata but never its descendant
    // tree — a 100-block section must not be duplicated into every durable
    // interaction record.
    expect(
      (result.interaction.definitionSnapshot as { block: { blocks?: unknown } })
        .block.blocks
    ).toBeUndefined();
  });

  it("accepts up to 100 top-level blocks", () => {
    const blocks = Array.from(
      { length: MAX_SURFACE_TOP_LEVEL_BLOCKS },
      (_, index) => ({
        id: `top-level-${index}`,
        type: "text" as const,
        text: "Block",
      })
    );

    expect(
      surfaceDocumentSchema.safeParse({ title: "Full surface", blocks }).success
    ).toBe(true);
    expect(
      surfaceDocumentSchema.safeParse({
        title: "Overfull surface",
        blocks: [
          ...blocks,
          { id: "top-level-overflow", type: "text", text: "Too many" },
        ],
      }).success
    ).toBe(false);
  });

  it("accepts the complete seed gallery and semantic badge variants", () => {
    expect(surfaceExamples).toHaveLength(8);
    for (const example of surfaceExamples) {
      const { id: _id, sortOrder: _sortOrder, ...document } = example;
      const parsed = surfaceDocumentSchema.safeParse(document);
      expect(parsed.success, example.title).toBe(true);
    }
    const health = surfaceExamples.find(
      (example) => example.id === "tab_seed_service_health"
    )!;
    const table = health.blocks.find((block) => block.type === "table")!;
    expect(
      table.columns.find((column) => column.id === "status")
    ).toMatchObject({
      format: "badge",
      badgeVariants: {
        Healthy: "success",
        Degraded: "warning",
        Outage: "danger",
      },
    });
  });

  it("rejects semantic badge variants on non-badge columns", () => {
    const parsed = surfaceDocumentSchema.safeParse({
      title: "Invalid table",
      blocks: [
        {
          id: "table",
          type: "table",
          columns: [
            { id: "name", label: "Name", badgeVariants: { Alice: "success" } },
          ],
          rows: [{ id: "one", cells: { name: "Alice" } }],
        },
      ],
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toMatch(
      /badgeVariants requires badge format/
    );
  });

  it("bounds semantic badge maps and table cell strings", () => {
    const tableDocument = (
      badgeVariants: Record<string, "success">,
      cell: string = "Ready"
    ) => ({
      title: "Bounded table",
      blocks: [
        {
          id: "table",
          type: "table",
          columns: [
            {
              id: "state",
              label: "State",
              format: "badge",
              badgeVariants,
            },
          ],
          rows: [{ id: "one", cells: { state: cell } }],
        },
      ],
    });

    expect(
      surfaceDocumentSchema.safeParse(
        tableDocument({ ["x".repeat(201)]: "success" })
      ).success
    ).toBe(false);
    expect(
      surfaceDocumentSchema.safeParse(
        tableDocument(
          Object.fromEntries(
            Array.from({ length: 51 }, (_, index) => [
              `state-${index}`,
              "success" as const,
            ])
          )
        )
      ).success
    ).toBe(false);
    expect(
      surfaceDocumentSchema.safeParse(
        tableDocument({ Ready: "success" }, "x".repeat(501))
      ).success
    ).toBe(false);
  });

  it("allows only safe URL protocols in URL-formatted table cells", () => {
    const document = (format: "text" | "url", value: unknown) => ({
      title: "Links",
      blocks: [
        {
          id: "table",
          type: "table",
          columns: [{ id: "link", label: "Link", format }],
          rows: [{ id: "one", cells: { link: value } }],
        },
      ],
    });

    for (const value of [
      "https://example.com/path",
      "http://example.com",
      "mailto:hello@example.com",
    ]) {
      expect(
        surfaceDocumentSchema.safeParse(document("url", value)).success
      ).toBe(true);
    }
    for (const value of [
      "javascript:alert(1)",
      "data:text/html,bad",
      "/relative",
      7,
    ]) {
      const parsed = surfaceDocumentSchema.safeParse(document("url", value));
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues[0]?.message).toMatch(
        /must use http, https, or mailto/
      );
    }
    expect(
      surfaceDocumentSchema.safeParse(document("text", "javascript:plain text"))
        .success
    ).toBe(true);
  });

  it("enforces revisions, supports icon clearing, and blocks unresolved deletion", async () => {
    const surface = await service.create(agentId, actionDocument);
    await expect(
      service.update(agentId, surface.id, 999, { title: "Stale" })
    ).rejects.toMatchObject({ statusCode: 409 });
    const updated = await service.update(agentId, surface.id, 1, {
      title: "Updated",
      icon: null,
    });
    expect(updated).toMatchObject({ title: "Updated", revision: 2 });
    expect(updated.icon).toBeUndefined();
    await service.submitInteraction(agentId, surface.id, {
      idempotencyKey: "pending",
      kind: "action",
      blockId: "footer",
      actionId: "canary",
      baseRevision: 2,
    });
    await expect(service.delete(agentId, surface.id, 2)).rejects.toMatchObject({
      statusCode: 409,
    });
    await service.delete(agentId, surface.id, 2, true);
    const statuses = await ctx.pool.query(
      `SELECT status FROM agent_surface_interactions WHERE surface_id=$1`,
      [surface.id]
    );
    expect(statuses.rows).toEqual([{ status: "cancelled" }]);
  });

  it("validates form values and unlocks once forms only after non-completion", async () => {
    const surface = await service.create(agentId, {
      title: "Feedback",
      blocks: [
        {
          id: "form",
          type: "form",
          fields: [
            {
              id: "decision",
              type: "radio",
              label: "Decision",
              required: true,
              options: [
                { value: "yes", label: "Yes" },
                { value: "no", label: "No", disabled: true },
              ],
            },
            { id: "notes", type: "textarea", label: "Notes", minLength: 3 },
          ],
          submit: { id: "submit", label: "Send", intent: "feedback" },
          submitMode: "once",
        },
      ],
    });
    await expect(
      service.submitInteraction(agentId, surface.id, {
        idempotencyKey: "bad",
        kind: "form_submit",
        blockId: "form",
        actionId: "submit",
        baseRevision: 1,
        values: { decision: "no", notes: "ok" },
      })
    ).rejects.toThrow(/invalid option/i);
    const result = await service.submitInteraction(agentId, surface.id, {
      idempotencyKey: "good",
      kind: "form_submit",
      blockId: "form",
      actionId: "submit",
      baseRevision: 1,
      values: { decision: "yes", notes: "looks good" },
    });
    expect(result.interaction.payload).toMatchObject({
      values: { decision: "yes", notes: "looks good" },
    });
    await service.resolve(
      agentId,
      result.interaction.id,
      "rejected",
      "Please revise"
    );
    const retry = await service.submitInteraction(agentId, surface.id, {
      idempotencyKey: "retry-after-rejection",
      kind: "form_submit",
      blockId: "form",
      actionId: "submit",
      baseRevision: 1,
      values: { decision: "yes", notes: "revised response" },
    });
    expect(retry.interaction.status).toBe("queued");
    await expect(
      service.submitInteraction(agentId, surface.id, {
        idempotencyKey: "blocked-while-pending",
        kind: "form_submit",
        blockId: "form",
        actionId: "submit",
        baseRevision: 1,
        values: { decision: "yes", notes: "another response" },
      })
    ).rejects.toMatchObject({ statusCode: 409 });

    await service.resolve(agentId, retry.interaction.id, "completed", "Saved");
    await expect(
      service.submitInteraction(agentId, surface.id, {
        idempotencyKey: "blocked-after-completion",
        kind: "form_submit",
        blockId: "form",
        actionId: "submit",
        baseRevision: 1,
        values: { decision: "yes", notes: "one more response" },
      })
    ).rejects.toMatchObject({ statusCode: 409 });

    expect((await service.get(surface.id))?.latestInteractions).toEqual([
      expect.objectContaining({
        id: retry.interaction.id,
        tabRevision: 1,
        blockId: "form",
        actionId: "submit",
        kind: "form_submit",
        status: "completed",
        outcomeMessage: "Saved",
        createdAt: expect.any(String),
        resolvedAt: expect.any(String),
      }),
    ]);
  });

  it("claims batches atomically and resolves claimed work", async () => {
    const surface = await service.create(agentId, actionDocument);
    const make = (key: string) =>
      service.submitInteraction(agentId, surface.id, {
        idempotencyKey: key,
        kind: "action",
        blockId: "footer",
        actionId: "canary",
        baseRevision: 1,
      });
    const a = await make("a");
    const b = await make("b");
    await service.resolve(agentId, b.interaction.id, "completed");
    await expect(
      service.claim(agentId, [a.interaction.id, b.interaction.id])
    ).rejects.toMatchObject({ statusCode: 409 });
    const untouched = await service.listInteractions(agentId, {
      tabId: surface.id,
    });
    expect(untouched.find((item) => item.id === a.interaction.id)?.status).toBe(
      "queued"
    );
    events.length = 0;
    const [claimed] = await service.claim(agentId, [a.interaction.id]);
    expect(claimed.status).toBe("claimed");
    expect(
      await service.resolve(agentId, claimed.id, "rejected", "Not applicable")
    ).toMatchObject({ status: "rejected", outcomeMessage: "Not applicable" });
    expect(events).toEqual([
      {
        type: "surface.changed",
        agentId,
        surfaceId: surface.id,
        change: "interaction",
      },
      {
        type: "surface.changed",
        agentId,
        surfaceId: surface.id,
        change: "interaction",
      },
    ]);
  });

  it("notifies running agents only after insertion and retains queued work when delivery fails", async () => {
    const send = vi.fn(async () => {
      throw new Error("session unavailable");
    });
    const notifying = new SurfaceService(ctx.pool, {
      publishUiEvent: vi.fn(),
      sendAgentPrompt: send,
    });
    const surface = await notifying.create(agentId, actionDocument);
    const result = await notifying.submitInteraction(agentId, surface.id, {
      idempotencyKey: "durable",
      kind: "action",
      blockId: "footer",
      actionId: "canary",
      baseRevision: 1,
    });
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][1]).toContain(
      "--- DISPATCH: SURFACE INTERACTION ---"
    );
    expect(send.mock.calls[0][1]).toContain(
      "--- END DISPATCH: SURFACE INTERACTION ---"
    );
    expect(result).toMatchObject({
      delivery: "queued",
      interaction: { status: "queued" },
    });
    expect(
      (
        await ctx.pool.query(
          `SELECT id FROM agent_surface_interactions WHERE id=$1`,
          [result.interaction.id]
        )
      ).rowCount
    ).toBe(1);
  });

  it("coalesces stopped-agent work on resume and orphans it on archive", async () => {
    await ctx.pool.query(`UPDATE agents SET status='stopped' WHERE id=$1`, [
      agentId,
    ]);
    const send = vi.fn(async () => undefined);
    const notifying = new SurfaceService(ctx.pool, {
      publishUiEvent: vi.fn(),
      sendAgentPrompt: send,
    });
    const surface = await notifying.create(agentId, actionDocument);
    await notifying.submitInteraction(agentId, surface.id, {
      idempotencyKey: "one",
      kind: "action",
      blockId: "footer",
      actionId: "canary",
      baseRevision: 1,
    });
    await notifying.submitInteraction(agentId, surface.id, {
      idempotencyKey: "two",
      kind: "action",
      blockId: "footer",
      actionId: "canary",
      baseRevision: 1,
    });
    await notifying.notifyQueuedAfterResume(agentId);
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][1]).toContain(
      "--- DISPATCH: SURFACE INTERACTIONS QUEUED ---"
    );
    expect(send.mock.calls[0][1]).toContain(
      "--- END DISPATCH: SURFACE INTERACTIONS QUEUED ---"
    );
    expect(send.mock.calls[0][1]).toContain("Queued interactions: 2");
    expect(
      await notifying.listInteractions(agentId, { status: "notified" })
    ).toHaveLength(2);

    await notifying.freezeForArchive(agentId);
    expect((await notifying.get(surface.id))?.lifecycle).toBe("frozen");
    expect(
      await notifying.listInteractions(agentId, { status: "orphaned" })
    ).toHaveLength(2);
    await expect(
      notifying.submitInteraction(agentId, surface.id, {
        idempotencyKey: "three",
        kind: "action",
        blockId: "footer",
        actionId: "canary",
        baseRevision: 2,
      })
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("surface schema v2", () => {
  it("rejects block ids reserved for document slots", () => {
    const parsed = surfaceDocumentSchema.safeParse({
      title: "Reserved",
      blocks: [{ id: "footer", type: "text", text: "Nope" }],
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toMatch(/reserved/);
  });

  it("enforces the 3-primary-column table budget", () => {
    const table = (priorities: ("primary" | "secondary" | undefined)[]) => ({
      title: "Wide",
      blocks: [
        {
          id: "wide",
          type: "table",
          columns: priorities.map((priority, index) => ({
            id: `c${index}`,
            label: `C${index}`,
            ...(priority ? { priority } : {}),
          })),
          rows: [],
        },
      ],
    });
    expect(
      surfaceDocumentSchema.safeParse(
        table([undefined, undefined, undefined, undefined])
      ).success
    ).toBe(false);
    expect(
      surfaceDocumentSchema.safeParse(
        table([undefined, undefined, undefined, "secondary"])
      ).success
    ).toBe(true);
  });

  it("rejects the retired center alignment", () => {
    const parsed = surfaceDocumentSchema.safeParse({
      title: "Centered",
      blocks: [
        {
          id: "t",
          type: "table",
          columns: [{ id: "a", label: "A", align: "center" }],
          rows: [],
        },
      ],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a style knob on a form submit", () => {
    const parsed = surfaceDocumentSchema.safeParse({
      title: "Form",
      blocks: [
        {
          id: "f",
          type: "form",
          fields: [{ id: "note", type: "text", label: "Note" }],
          submit: {
            id: "send",
            label: "Send",
            intent: "send",
            style: "primary",
          },
        },
      ],
    });
    expect(parsed.success).toBe(false);
  });

  it("validates header and footer slots with duplicate-id checks", () => {
    const document = {
      title: "Slots",
      header: {
        status: { id: "hs", type: "status", status: "OK" },
        progress: { id: "hp", type: "progress", value: 1, max: 2 },
      },
      blocks: [{ id: "body", type: "text", text: "Body" }],
      footer: {
        actions: [
          { id: "go", label: "Go", intent: "go" },
          { id: "stop", label: "Stop", intent: "stop" },
        ],
      },
    };
    expect(surfaceDocumentSchema.safeParse(document).success).toBe(true);
    expect(
      surfaceDocumentSchema.safeParse({
        ...document,
        footer: {
          actions: [
            { id: "go", label: "Go", intent: "go" },
            { id: "go", label: "Again", intent: "again" },
          ],
        },
      }).success
    ).toBe(false);
    expect(
      surfaceDocumentSchema.safeParse({
        ...document,
        header: {
          status: { id: "body", type: "status", status: "OK" },
        },
      }).success
    ).toBe(false);
  });

  it("stores slots, requires full upgrades for v1 rows, and gates their interactions", async () => {
    const created = await service.create(agentId, {
      title: "Slots",
      header: { status: { id: "hs", type: "status", status: "OK" } },
      blocks: [{ id: "body", type: "text", text: "Body" }],
      footer: { actions: [{ id: "go", label: "Go", intent: "go" }] },
    });
    expect(created.schemaVersion).toBe(2);
    const fetched = await service.get(created.id);
    expect(fetched?.header?.status?.status).toBe("OK");
    expect(fetched?.footer?.actions[0]?.id).toBe("go");

    // A stored v1 row (legacy shape, schema_version 1) must not crash reads,
    // must refuse partial updates, and must refuse interactions.
    await ctx.pool.query(
      `INSERT INTO agent_surfaces (id, agent_id, title, sort_order, schema_version, blocks)
       VALUES ('tab_legacy_v1', $1, 'Legacy', 99, 1, $2)`,
      [
        agentId,
        JSON.stringify([
          {
            id: "old-actions",
            type: "actions",
            actions: [{ id: "go", label: "Go", intent: "go" }],
          },
        ]),
      ]
    );
    const legacy = await service.get("tab_legacy_v1");
    expect(legacy?.schemaVersion).toBe(1);
    await expect(
      service.update(agentId, "tab_legacy_v1", 1, { title: "Renamed" })
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      service.submitInteraction(agentId, "tab_legacy_v1", {
        idempotencyKey: "legacy-click",
        kind: "action",
        blockId: "old-actions",
        actionId: "go",
        baseRevision: 1,
      })
    ).rejects.toMatchObject({ statusCode: 409 });
    // A full v2 blocks replacement upgrades the row in place.
    const upgraded = await service.update(agentId, "tab_legacy_v1", 1, {
      blocks: [{ id: "body", type: "text", text: "Upgraded" }],
    });
    expect(upgraded.schemaVersion).toBe(2);
  });
});
