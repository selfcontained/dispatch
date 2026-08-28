import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { SurfaceService } from "../../surfaces/service.js";
import { surfaceBlockSchema, surfaceIconSchema } from "../../surfaces/types.js";
import { jsonText } from "./response.js";
import { toToolError } from "./tool-error.js";

export function registerSurfaceTools(
  server: McpServer,
  allowed: Set<string>,
  context: { agentId: string; surfaces?: SurfaceService }
): void {
  if (!context.surfaces) return;
  const service = context.surfaces;
  const register = (
    name: string,
    description: string,
    inputSchema: Record<string, z.ZodType>,
    run: (args: any) => Promise<unknown>
  ) => {
    if (!allowed.has(name)) return;
    server.registerTool(name, { description, inputSchema }, async (args) => {
      try {
        const value = await run(args);
        return {
          content: [{ type: "text" as const, text: jsonText(value) }],
          structuredContent: value as Record<string, unknown>,
        };
      } catch (error) {
        return toToolError(error);
      }
    });
  };

  register(
    "dispatch_surface_create",
    "Create a one-column custom sidebar tab. Blocks support text, list, table, status, progress, actions, and form. Keep block, item, and field IDs stable; list/table action IDs are scoped to their item or row.",
    {
      title: z.string().min(1).max(32),
      icon: surfaceIconSchema.optional(),
      blocks: z.array(surfaceBlockSchema).max(40),
    },
    async ({ title, icon, blocks }) => {
      const s = await service.create(context.agentId, { title, icon, blocks });
      return { tabId: s.id, revision: s.revision, sortOrder: s.sortOrder };
    }
  );

  register(
    "dispatch_surface_update",
    "Replace all or part of an owned surface document using expectedRevision. Whole-document blocks replacement only; no JSON Patch.",
    {
      tabId: z.string().min(1),
      expectedRevision: z.number().int().positive(),
      title: z.string().min(1).max(32).optional(),
      icon: z
        .union([surfaceIconSchema, z.null()])
        .optional()
        .describe("Set null to clear the icon."),
      blocks: z.array(surfaceBlockSchema).max(40).optional(),
      lifecycle: z.enum(["active", "frozen"]).optional(),
    },
    async ({ tabId, expectedRevision, ...patch }) => {
      const s = await service.update(
        context.agentId,
        tabId,
        expectedRevision,
        patch
      );
      return { tabId, revision: s.revision, lifecycle: s.lifecycle };
    }
  );

  register(
    "dispatch_surface_list",
    "List owned surfaces, or direct-child surfaces read-only when ownerAgentId is supplied.",
    {
      ownerAgentId: z.string().min(1).optional(),
    },
    async ({ ownerAgentId }) => {
      const owner = ownerAgentId ?? context.agentId;
      await service.assertReadable(context.agentId, owner);
      return {
        surfaces: (await service.list(owner)).map(
          ({ blocks: _blocks, ...surface }) => surface
        ),
      };
    }
  );

  register(
    "dispatch_surface_get",
    "Get one owned or direct-child surface with its complete document and unresolved interaction count.",
    {
      tabId: z.string().min(1),
    },
    async ({ tabId }) => {
      const surface = await service.get(tabId);
      if (!surface) throw new Error("Surface not found.");
      await service.assertReadable(context.agentId, surface.ownerAgentId);
      return surface;
    }
  );

  register(
    "dispatch_surface_delete",
    "Delete an owned surface at expectedRevision. force cancels unresolved interactions first.",
    {
      tabId: z.string().min(1),
      expectedRevision: z.number().int().positive(),
      force: z.boolean().optional(),
    },
    async ({ tabId, expectedRevision, force }) => {
      await service.delete(context.agentId, tabId, expectedRevision, force);
      return { tabId, deleted: true };
    }
  );

  register(
    "dispatch_surface_reorder",
    "Replace the canonical order of every active custom tab owned by this agent.",
    {
      surfaceIds: z.array(z.string().min(1)).max(8),
    },
    async ({ surfaceIds }) => {
      await service.reorder(context.agentId, surfaceIds);
      return { surfaceIds };
    }
  );

  register(
    "dispatch_surface_interactions",
    "List durable surface interactions for this agent. Use status filters to read queued work.",
    {
      tabId: z.string().min(1).optional(),
      status: z
        .enum([
          "queued",
          "notified",
          "claimed",
          "completed",
          "rejected",
          "cancelled",
          "orphaned",
        ])
        .optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    async (args) => ({
      interactions: await service.listInteractions(context.agentId, args),
    })
  );

  register(
    "dispatch_surface_claim",
    "Claim one or more queued/notified durable interactions before working them.",
    {
      ids: z.array(z.string().min(1)).min(1).max(100),
    },
    async ({ ids }) => ({
      interactions: await service.claim(context.agentId, ids),
    })
  );

  register(
    "dispatch_surface_resolve",
    "Resolve a durable interaction after processing it.",
    {
      id: z.string().min(1),
      outcome: z.enum(["completed", "rejected"]),
      message: z.string().max(1000).optional(),
    },
    async ({ id, outcome, message }) =>
      service.resolve(context.agentId, id, outcome, message)
  );
}
