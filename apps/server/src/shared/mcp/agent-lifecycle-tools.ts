import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import type { NotifyInput } from "./server.js";
import { jsonText, LIST_STRING_MAX, truncateLongStrings } from "./response.js";
import { toToolError } from "./tool-error.js";

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
  ) => Promise<
    Array<{
      ownerAgentId?: string;
      fileName: string;
      filePath: string;
      source: string;
      description: string | null;
      sizeBytes: number;
      createdAt: string;
    }>
  >;
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

  // ── dispatch_event ────────────────────────────────────────────────
  if (allowed.has("dispatch_event") && context.upsertEvent) {
    const upsertEvent = context.upsertEvent;

    server.registerTool(
      "dispatch_event",
      {
        description:
          "Report agent status to Dispatch. Must be called at the start of each turn (working), when stuck and unable to proceed (blocked), waiting for user input (waiting_user), and before the final response (done or idle).",
        inputSchema: {
          type: z
            .enum(["working", "blocked", "waiting_user", "done", "idle"])
            .describe("The status event type."),
          message: z
            .string()
            .describe("A short description of what is happening."),
          metadata: z
            .record(z.string(), z.unknown())
            .optional()
            .describe("Optional metadata object."),
        },
      },
      async (args) => {
        try {
          await upsertEvent(agentId, {
            type: args.type,
            message: args.message,
            metadata: args.metadata as Record<string, unknown> | undefined,
          });
          return {
            content: [
              {
                type: "text",
                text: `Updated ${agentId}: ${args.type} - ${args.message}`,
              },
            ],
          };
        } catch (error) {
          return toToolError(error);
        }
      }
    );
  }

  // ── dispatch_rename_session ───────────────────────────────────────
  if (allowed.has("dispatch_rename_session") && context.renameSession) {
    const renameSession = context.renameSession;

    server.registerTool(
      "dispatch_rename_session",
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

  // ── dispatch_notify ───────────────────────────────────────────────
  if (allowed.has("dispatch_notify") && context.sendNotify) {
    const sendNotify = context.sendNotify;

    server.registerTool(
      "dispatch_notify",
      {
        description:
          "Send a Slack notification. Use this to proactively share summaries, results, or important updates " +
          "with the user via Slack. The message supports Slack mrkdwn formatting. " +
          "Requires a Slack webhook to be configured in Dispatch settings. " +
          "Rate limited to 5 messages per minute.",
        inputSchema: {
          message: z
            .string()
            .max(3000)
            .describe(
              "The notification message body. Supports Slack mrkdwn formatting (bold, links, lists, code blocks, etc). Max 3000 characters."
            ),
          title: z
            .string()
            .max(150)
            .optional()
            .describe(
              "Optional title displayed above the message. Defaults to 'Notification from <agent>'. Max 150 characters."
            ),
          level: z
            .enum(["info", "success", "warning", "error"])
            .default("info")
            .describe(
              "Notification level — controls the color and emoji. info (blue), success (green), warning (amber), error (red)."
            ),
          respectFocus: z
            .boolean()
            .default(false)
            .describe(
              "When true, the notification is suppressed if the user is actively viewing this agent in Dispatch. Default false — notifications are always sent."
            ),
        },
      },
      async (args) => {
        try {
          const result = await sendNotify(agentId, {
            message: args.message,
            title: args.title,
            level: args.level as NotifyInput["level"],
            respectFocus: args.respectFocus,
          });
          return {
            content: [
              {
                type: "text",
                text: result.sent
                  ? "Notification sent to Slack."
                  : `Notification not sent: ${result.reason}`,
              },
            ],
          };
        } catch (error) {
          return toToolError(error);
        }
      }
    );
  }

  // ── dispatch_list_media ──────────────────────────────────────────
  if (allowed.has("dispatch_list_media") && context.listMedia) {
    const listMedia = context.listMedia;

    server.registerTool(
      "dispatch_list_media",
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

  if (allowed.has("dispatch_delete_media") && context.deleteMedia) {
    const deleteMedia = context.deleteMedia;
    server.registerTool(
      "dispatch_delete_media",
      {
        description:
          "Permanently remove one of this agent's shared media files. Call dispatch_list_media first to identify the exact fileName. This removes both the stored file and its Dispatch media record.",
        inputSchema: {
          fileName: z
            .string()
            .describe("Exact fileName returned by dispatch_list_media."),
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

  if (allowed.has("dispatch_list_pins") && context.listPins) {
    const listPins = context.listPins;
    server.registerTool(
      "dispatch_list_pins",
      {
        description:
          "List this agent's current Dispatch sidebar pins, or — with ownerAgentId — the pins of its parent or one of its direct children, read-only. Use dispatch_delete_pin with a returned id to remove a stale pin of your own. " +
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
