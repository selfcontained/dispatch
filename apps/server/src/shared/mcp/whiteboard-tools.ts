import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import { toToolError } from "./tool-error.js";
import type { SimplifiedElement } from "../whiteboard.js";
import type { WhiteboardOp } from "../whiteboard-builder.js";
import { MAX_OPS } from "../whiteboard-builder.js";

export type WhiteboardToolsContext = {
  agentId: string;
  getWhiteboard?: (agentId: string) => Promise<{
    elements: SimplifiedElement[];
    version: number;
    updatedAt: string | null;
    updatedBy: string | null;
    snapshotPath: string | null;
    snapshotStale: boolean;
  }>;
  updateWhiteboard?: (
    agentId: string,
    ops: WhiteboardOp[]
  ) => Promise<{
    version: number;
    created: Array<{ id: string; type: string }>;
    errors: string[];
    elements: SimplifiedElement[];
  }>;
};

const opSchema = z.object({
  op: z
    .enum(["add", "update", "delete"])
    .describe("add a new element, or update/delete an existing one by id."),
  type: z
    .enum(["rect", "ellipse", "diamond", "arrow", "line", "text", "frame"])
    .optional()
    .describe("Element shape (required for add)."),
  id: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/)
    .optional()
    .describe(
      "Element id. Required for update/delete. On add, supply your own " +
        "readable id (e.g. 'api-box') so later ops and arrows can reference it."
    ),
  x: z.number().optional().describe("Left edge (canvas px)."),
  y: z.number().optional().describe("Top edge (canvas px)."),
  w: z.number().positive().optional().describe("Width (default 100)."),
  h: z.number().positive().optional().describe("Height (default 60)."),
  label: z
    .string()
    .max(1000)
    .optional()
    .describe(
      "Text centered on the shape/arrow, the content for type:text, or the " +
        "title for type:frame. Keep it short."
    ),
  from: z
    .string()
    .optional()
    .describe(
      "Arrow start: an element id. The arrow binds to it and follows moves."
    ),
  to: z.string().optional().describe("Arrow end: an element id (see from)."),
  color: z
    .string()
    .max(32)
    .optional()
    .describe(
      "Stroke color: hex (#rrggbb) or black|gray|violet|blue|cyan|teal|" +
        "green|yellow|orange|red. Defaults to violet — your signature ink; " +
        "keep it unless the user asks otherwise."
    ),
});

export function registerWhiteboardTools(
  server: McpServer,
  allowed: Set<string>,
  context: WhiteboardToolsContext
): void {
  if (allowed.has("whiteboard_get") && context.getWhiteboard) {
    const agentId = context.agentId;
    const getWhiteboard = context.getWhiteboard;

    server.registerTool(
      "whiteboard_get",
      {
        description:
          "Get the current state of this agent's shared whiteboard — a canvas the user sketches on " +
          "(architecture diagrams, flows, ideas). Returns a simplified element list (geometry, text, " +
          "arrow connections via from/to element ids) plus snapshotPath: a PNG rendering of the board. " +
          "Read the snapshot file to SEE the drawing — freehand sketches are hard to interpret from " +
          "elements alone. Use this whenever the user refers to the whiteboard/board/drawing.",
        inputSchema: {},
      },
      async () => {
        try {
          const board = await getWhiteboard(agentId);
          const summary = {
            elementCount: board.elements.length,
            version: board.version,
            updatedAt: board.updatedAt,
            updatedBy: board.updatedBy,
            snapshotPath: board.snapshotPath,
            snapshotStale: board.snapshotStale,
            elements: board.elements,
          };
          const snapshotNote = board.snapshotPath
            ? board.snapshotStale
              ? `\n\nNote: ${board.snapshotPath} was rendered BEFORE the latest edits — trust the element list over the image until a browser re-exports it.`
              : `\n\nTip: Read ${board.snapshotPath} to view the board visually.`
            : "\n\nNo snapshot has been rendered yet (the board may be empty or never opened).";
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(summary, null, 2) + snapshotNote,
              },
            ],
            structuredContent: summary,
          };
        } catch (error) {
          return toToolError(error);
        }
      }
    );
  }

  if (allowed.has("whiteboard_update") && context.updateWhiteboard) {
    const agentId = context.agentId;
    const updateWhiteboard = context.updateWhiteboard;

    server.registerTool(
      "whiteboard_update",
      {
        description:
          "Draw on the shared whiteboard — the user sees your edits live. Use it to answer " +
          "visually: sketch a fresh diagram in empty space, or annotate the user's drawing by " +
          "pointing at it (arrow + short label placed NEAR their work, never on top of it). " +
          "Call whiteboard_get first to learn current elements, their ids, and where free space is. " +
          "Arrows with from/to bind to elements and follow them when moved; give added elements " +
          "readable ids so arrows in the same call can reference them. Prefer updating or deleting " +
          "your own elements by id over redrawing. Your strokes default to violet so the user can " +
          "tell your ink from theirs. Layout rules: name a shape with its `label` (centered, sized " +
          "to fit) — never a separate text element; text at 20px runs ~11px per character, so size " +
          "w to fit labels; typical box w 160, h 70 with ~80px gaps; when inserting between " +
          "existing elements, first move others (update x/y) to make room rather than squeezing in.",
        inputSchema: {
          ops: z
            .array(opSchema)
            .min(1)
            .max(MAX_OPS)
            .describe("Drawing operations, applied in order."),
        },
      },
      async (args) => {
        try {
          const result = await updateWhiteboard(
            agentId,
            args.ops as WhiteboardOp[]
          );
          const summary = {
            ok: result.errors.length === 0,
            version: result.version,
            created: result.created,
            errors: result.errors,
            elementCount: result.elements.length,
            elements: result.elements,
          };
          return {
            content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
            structuredContent: summary,
          };
        } catch (error) {
          return toToolError(error);
        }
      }
    );
  }
}
