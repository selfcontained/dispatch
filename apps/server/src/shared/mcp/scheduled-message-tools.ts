import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { ScheduledMessageService } from "../../scheduled-messages/service.js";
import { scheduleMessageSchema } from "../../scheduled-messages/validation.js";
import { jsonText } from "./response.js";
import { toToolError } from "./tool-error.js";
export function registerScheduledMessageTools(
  server: McpServer,
  allowed: ReadonlySet<string>,
  agentId: string,
  service: ScheduledMessageService
) {
  if (allowed.has("schedule_message"))
    server.registerTool(
      "schedule_message",
      {
        description:
          "Schedule a freeform message to yourself once or repeatedly. Recurrence requires completion criteria and a count or expiry. Messages can steer your active turn without interrupting tools. Repeated ticks collapse until pickup. Cancel when the criteria are met. Maximum lifetime seven days, 100 accepted deliveries, ten active schedules; minimum interval 60 seconds. Timestamps must include a timezone offset. Cancellation cannot recall an engine-accepted message.",
        inputSchema: scheduleMessageSchema.shape,
      },
      async (input) => {
        try {
          return {
            content: [
              {
                type: "text" as const,
                text: jsonText(await service.create(agentId, input)),
              },
            ],
          };
        } catch (error) {
          return toToolError(error);
        }
      }
    );
  if (allowed.has("list_scheduled_messages"))
    server.registerTool(
      "list_scheduled_messages",
      {
        description:
          "List your scheduled messages, including timing, completion criteria, delivery status and history.",
        inputSchema: {
          id: z
            .uuid()
            .optional()
            .describe(
              "Return full details for this schedule; omit for a compact list."
            ),
        },
      },
      async (input) => {
        try {
          const all = await service.list(agentId);
          const result = input.id
            ? all.find((s) => s.id === input.id)
            : all.map((s) => ({
                id: s.id,
                title: s.title,
                status: s.status,
                nextDueAt: s.nextDueAt,
                expiresAt: s.expiresAt,
                deliveredCount: s.deliveredCount,
                maxDeliveries: s.maxDeliveries,
                outstanding: s.outstanding?.phase ?? null,
              }));
          if (!result) throw new Error("Schedule not found for this agent.");
          return {
            content: [{ type: "text" as const, text: jsonText(result) }],
          };
        } catch (error) {
          return toToolError(error);
        }
      }
    );
  if (allowed.has("cancel_scheduled_message"))
    server.registerTool(
      "cancel_scheduled_message",
      {
        description:
          "Stop future deliveries and discard unaccepted pending messages. Already accepted messages remain with the engine. Set completed when the purpose has been fulfilled.",
        inputSchema: { id: z.uuid(), completed: z.boolean().optional() },
      },
      async (input) => {
        try {
          return {
            content: [
              {
                type: "text" as const,
                text: jsonText(
                  await service.change(
                    agentId,
                    input.id,
                    "cancel",
                    input.completed
                  )
                ),
              },
            ],
          };
        } catch (error) {
          return toToolError(error);
        }
      }
    );
}
