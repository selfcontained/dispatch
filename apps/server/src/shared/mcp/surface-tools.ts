import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { SurfaceService } from "../../surfaces/service.js";
import {
  MAX_SURFACE_TOP_LEVEL_BLOCKS,
  surfaceBlockSchema,
  surfaceFooterSchema,
  surfaceHeaderSchema,
  surfaceIconSchema,
} from "../../surfaces/types.js";
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

  const designContract =
    "Design contract — the renderer owns styling; supply meaning, not layout. " +
    "Put the surface's headline state in header (status + progress) and its verbs in footer.actions — they render as a compact split button with an overflow menu. " +
    "One primary action per surface; leave others default. Use destructive only for irreversible verbs and always with confirm — it renders in the overflow menu on purpose. " +
    "Sections group related blocks and take their own actions footer for group-scoped verbs. List items and table rows take actions (one renders inline, more become a per-item menu); repeating one label across every item is fine. " +
    "Tables: at most 3 primary columns; mark the rest secondary (they collapse behind a per-row disclosure); 2-column tables render as a key/value list. " +
    'Color means state: tone neutral for categories (environment, repo, owner), danger/warning for exceptions; write human labels ("Rolled back"), never enum tokens. ' +
    "text takes a tone — use it for the one sentence that changes a decision. Collapse finished work, never the thesis. " +
    "Shapes: dashboard = header+table+footer · worklist = header+list(group, actions) · approval = text(tone warning)+form · board = section-per-column+check list · report = text+2-col table+list.";

  register(
    "dispatch_surface_create",
    'Create a custom sidebar tab (fixed 400px column): optional header { status?, progress? }, blocks (text, list, table, status, progress, form, section; up to 100 top-level and 100 nested), optional footer { actions }. Sections nest four levels, hold 20 direct children, take collapse: { initiallyCollapsed? } and an optional actions footer. Keep block, item, action, and field IDs stable; item/row action IDs are scoped to their item, and footer actions use the reserved block id "footer" in interactions. ' +
      designContract,
    {
      title: z.string().min(1).max(32),
      icon: surfaceIconSchema.optional(),
      header: surfaceHeaderSchema.optional(),
      blocks: z.array(surfaceBlockSchema).max(MAX_SURFACE_TOP_LEVEL_BLOCKS),
      footer: surfaceFooterSchema.optional(),
    },
    async ({ title, icon, header, blocks, footer }) => {
      const s = await service.create(context.agentId, {
        title,
        icon,
        header,
        blocks,
        footer,
      });
      return { tabId: s.id, revision: s.revision, sortOrder: s.sortOrder };
    }
  );

  register(
    "dispatch_surface_update",
    "Replace all or part of an owned surface document using expectedRevision. Whole-document blocks replacement only; no JSON Patch. header and footer accept null to clear the slot. Same design contract as dispatch_surface_create.",
    {
      tabId: z.string().min(1),
      expectedRevision: z.number().int().positive(),
      title: z.string().min(1).max(32).optional(),
      icon: z
        .union([surfaceIconSchema, z.null()])
        .optional()
        .describe("Set null to clear the icon."),
      header: z
        .union([surfaceHeaderSchema, z.null()])
        .optional()
        .describe("Set null to clear the header slot."),
      blocks: z
        .array(surfaceBlockSchema)
        .max(MAX_SURFACE_TOP_LEVEL_BLOCKS)
        .optional(),
      footer: z
        .union([surfaceFooterSchema, z.null()])
        .optional()
        .describe("Set null to clear the footer slot."),
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
        // List is the tab-summary projection: the complete document (slots
        // included) comes from dispatch_surface_get.
        surfaces: (await service.list(owner)).map(
          ({ blocks: _blocks, header: _header, footer: _footer, ...surface }) =>
            surface
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
