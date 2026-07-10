import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import { toToolError } from "./tool-error.js";

type WhiteboardToolDeps = {
  agentId: string;
  getWhiteboard: (
    agentId: string
  ) => Promise<{
    scene: unknown;
    version: number;
    elements: unknown[];
    snapshotPath: string | null;
  }>;
  updateWhiteboard: (
    agentId: string,
    ops: unknown[]
  ) => Promise<{ version: number; elementCount: number }>;
};

export function registerWhiteboardTools(
  server: McpServer,
  allowed: Set<string>,
  deps: WhiteboardToolDeps
): void {
  if (allowed.has("whiteboard_get")) {
    server.registerTool(
      "whiteboard_get",
      {
        description:
          "Get the current whiteboard state for this agent. Returns the scene data, a simplified element list, and the path to the latest PNG snapshot (if available).",
        inputSchema: {},
      },
      async () => {
        try {
          const result = await deps.getWhiteboard(deps.agentId);
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            structuredContent: result,
          };
        } catch (error) {
          return toToolError(error);
        }
      }
    );
  }

  if (allowed.has("whiteboard_update")) {
    server.registerTool(
      "whiteboard_update",
      {
        description:
          "Update the agent's whiteboard by applying operations. Supports adding shapes (rect, ellipse, diamond, arrow, line, text, frame), updating existing shapes, and deleting shapes. Returns the new version and element count.",
        inputSchema: {
          ops: z
            .array(
              z.object({
                op: z.enum(["add", "update", "delete"]),
                type: z
                  .enum([
                    "rect",
                    "ellipse",
                    "diamond",
                    "arrow",
                    "line",
                    "text",
                    "frame",
                  ])
                  .optional(),
                id: z
                  .string()
                  .optional()
                  .describe(
                    "Shape identifier. Required for update/delete. Optional for add (auto-generated if omitted)."
                  ),
                x: z.number().optional(),
                y: z.number().optional(),
                w: z.number().optional(),
                h: z.number().optional(),
                label: z.string().optional(),
                from: z
                  .string()
                  .optional()
                  .describe("Arrow binding source shape id."),
                to: z
                  .string()
                  .optional()
                  .describe("Arrow binding target shape id."),
                color: z
                  .string()
                  .optional()
                  .describe(
                    "Shape color. Valid: black, grey, light-violet, violet, blue, light-blue, yellow, orange, green, light-green, light-red, red, white."
                  ),
                fill: z
                  .string()
                  .optional()
                  .describe("Fill style: none, semi, solid, pattern."),
                style: z
                  .enum(["solid", "dashed", "dotted"])
                  .optional()
                  .describe("Line style."),
                startHead: z
                  .enum(["none", "arrow", "triangle", "bar", "dot", "diamond"])
                  .optional(),
                endHead: z
                  .enum(["none", "arrow", "triangle", "bar", "dot", "diamond"])
                  .optional(),
              })
            )
            .describe("Array of whiteboard operations to apply."),
        },
      },
      async (args) => {
        try {
          const result = await deps.updateWhiteboard(deps.agentId, args.ops);
          return {
            content: [
              {
                type: "text",
                text: `Whiteboard updated: ${result.elementCount} elements, version ${result.version}.`,
              },
            ],
            structuredContent: result,
          };
        } catch (error) {
          return toToolError(error);
        }
      }
    );
  }
}
