import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import type { NotifyInput } from "./server.js";
import { jsonText, LIST_STRING_MAX, truncateLongStrings } from "./response.js";
import { toToolError } from "./tool-error.js";

/**
 * One row of a media listing. `ownerAgentId` is always present: a listing can
 * mix owners once family reads exist, so every row says whose it is.
 */
export type ListedMediaItem = {
  ownerAgentId: string;
  fileName: string;
  filePath: string;
  source: string;
  description: string | null;
  sizeBytes: number;
  createdAt: string;
};

export type AgentLifecycleContext = {
  agentId: string;
  upsertEvent?: (
    agentId: string,
    event: { type: string; message: string; metadata?: Record<string, unknown> }
  ) => Promise<void>;
  renameSession?: (
    agentId: string,
    name: string
  ) => Promise<{ id: string; name: string }>;
  sendNotify?: (
    agentId: string,
    input: NotifyInput
  ) => Promise<{
    sent: boolean;
    reason?: string;
  }>;
  listMedia?: (
    agentId: string,
    opts: { source?: string; ownerAgentId?: string }
  ) => Promise<ListedMediaItem[]>;
  deleteMedia?: (agentId: string, fileName: string) => Promise<void>;
  listPins?: (
    agentId: string,
    opts?: { ownerAgentId?: string }
  ) => Promise<
    Array<{ id: string; label: string; value: string; type: string }>
  >;
};

export function registerAgentLifecycleTools(
  server: McpServer,
  allowed: Set<string>,
  context: AgentLifecycleContext
): void {
  const { agentId } = context;

  // ── rename_session ───────────────────────────────────────
  if (allowed.has("rename_session") && context.renameSession) {
    const renameSession = context.renameSession;

    server.registerTool(
      "rename_session",
      {
        description:
          "Update the current session's display name. Use this to rename a default-generated session to a short goal or topic, or when the user explicitly asks for a rename.",
        inputSchema: {
          name: z
            .string()
            .min(1)
            .max(120)
            .describe("New session display name."),
        },
      },
      async (args) => {
        try {
          const result = await renameSession(agentId, args.name);
          return {
            content: [
              { type: "text", text: `Renamed session to \"${result.name}\".` },
            ],
            structuredContent: result,
          };
        } catch (error) {
          return toToolError(error);
        }
      }
    );
  }

  // ── notify ───────────────────────────────────────────────
  // ── list_media ──────────────────────────────────────────
  if (allowed.has("list_media") && context.listMedia) {
    const listMedia = context.listMedia;

    server.registerTool(
      "list_media",
      {
        description:
          "List media files shared with or by this agent, or by its parent or one of its direct children when ownerAgentId is supplied (read-only; an archived one still lists). Returns metadata only — use file reading tools to access content via filePath.",
        inputSchema: {
          source: z
            .string()
            .optional()
            .describe(
              'Optional source filter (e.g. "user", "screenshot", "text", "simulator", "stream"). Omit to list all media.'
            ),
          ownerAgentId: z
            .string()
            .min(1)
            .optional()
            .describe(
              "Whose media to list: omit for your own, or pass your parent's or a direct child's id (see list_agents). Any other agent reports as not found."
            ),
        },
      },
      async (args) => {
        try {
          const items = await listMedia(agentId, {
            source: args.source,
            ownerAgentId: args.ownerAgentId,
          });
          return {
            content: [{ type: "text" as const, text: jsonText(items) }],
          };
        } catch (error) {
          return toToolError(error);
        }
      }
    );
  }

  if (allowed.has("delete_media") && context.deleteMedia) {
    const deleteMedia = context.deleteMedia;
    server.registerTool(
      "delete_media",
      {
        description:
          "Permanently remove one of this agent's shared media files. Call list_media first to identify the exact fileName. This removes both the stored file and its Dispatch media record.",
        inputSchema: {
          fileName: z
            .string()
            .describe("Exact fileName returned by list_media."),
        },
      },
      async (args) => {
        try {
          await deleteMedia(agentId, args.fileName);
          return {
            content: [
              { type: "text", text: `Deleted media \"${args.fileName}\".` },
            ],
          };
        } catch (error) {
          return toToolError(error);
        }
      }
    );
  }

  if (allowed.has("list_pins") && context.listPins) {
    const listPins = context.listPins;
    server.registerTool(
      "list_pins",
      {
        description:
          "List this agent's current Dispatch sidebar pins, or — with ownerAgentId — the pins of its parent or one of its direct children, read-only. Use delete_pin with a returned id to remove a stale pin of your own. " +
          `Pin values longer than ${LIST_STRING_MAX} characters are truncated (marked with the number of characters dropped). ` +
          "Pass an id to get that one pin back in full instead — that is how you read a long shortcut pin's whole prompt.",
        inputSchema: {
          id: z
            .string()
            .min(1)
            .optional()
            .describe(
              "Return only this pin, untruncated. Omit to list every pin."
            ),
          ownerAgentId: z
            .string()
            .min(1)
            .optional()
            .describe(
              "Whose pins to list: omit for your own, or pass your parent's or a direct child's id (see list_agents). Any other agent reports as not found."
            ),
        },
      },
      async (args) => {
        try {
          const pins = await listPins(agentId, {
            ownerAgentId: args.ownerAgentId,
          });
          if (args.id !== undefined) {
            const pin = pins.find((candidate) => candidate.id === args.id);
            if (!pin) {
              return toToolError(new Error(`Pin ${args.id} not found.`));
            }
            // A request for one pin is the detail read, so it is not truncated.
            return {
              content: [{ type: "text" as const, text: jsonText(pin) }],
            };
          }
          return {
            content: [
              {
                type: "text" as const,
                text: jsonText(truncateLongStrings(pins, LIST_STRING_MAX)),
              },
            ],
          };
        } catch (error) {
          return toToolError(error);
        }
      }
    );
  }
}
