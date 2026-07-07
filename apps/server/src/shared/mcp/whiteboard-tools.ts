import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { toToolError } from "./tool-error.js";
import type { SimplifiedElement } from "../whiteboard.js";

export type WhiteboardToolsContext = {
  agentId: string;
  getWhiteboard?: (agentId: string) => Promise<{
    elements: SimplifiedElement[];
    version: number;
    updatedAt: string | null;
    updatedBy: string | null;
    snapshotPath: string | null;
  }>;
};

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
            elements: board.elements,
          };
          return {
            content: [
              {
                type: "text",
                text:
                  JSON.stringify(summary, null, 2) +
                  (board.snapshotPath
                    ? `\n\nTip: Read ${board.snapshotPath} to view the board visually.`
                    : "\n\nNo snapshot has been rendered yet (the board may be empty or never opened)."),
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
}
