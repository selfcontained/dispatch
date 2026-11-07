import type { Stream, AnyMessage } from "@agentclientprotocol/sdk";
import { z } from "zod";

// Only this extension is negotiated. Native subagent routing remains unchanged.
export const backgroundCapability = {
  jetbrains: { air: { version: 1, capabilities: ["asyncTasks"] } },
};

const id = z.string().min(1).max(512);
const text = z.string().max(4096);
const common = {
  asyncTaskId: id,
  toolCallId: id.optional(),
};
const updateSchema = z.discriminatedUnion("sessionUpdate", [
  z.object({
    ...common,
    sessionUpdate: z.literal("async_task_spawned"),
    name: text,
    taskType: z.enum(["shell", "monitor"]),
    description: text.optional(),
    showInTranscript: z.boolean(),
    canStop: z.boolean(),
  }),
  z.object({
    ...common,
    sessionUpdate: z.literal("async_task_progress"),
    description: text.optional(),
    summary: text.optional(),
    lastToolName: text.optional(),
  }),
  z.object({
    ...common,
    sessionUpdate: z.literal("async_task_state_update"),
    state: z.enum(["running", "paused", "completed", "failed", "stopped"]),
    summary: text.optional(),
  }),
]);
export const backgroundNotificationSchema = z.object({
  sessionId: id,
  update: updateSchema,
});
export type BackgroundNotification = z.infer<
  typeof backgroundNotificationSchema
>;
export type BackgroundUpdate = BackgroundNotification["update"];

/**
 * SDK 1.8 validates a closed update union. Intercept only the three pinned
 * extension notifications, validate them separately, and leave every ordinary
 * message to the SDK. Zod strips paths, usage and arbitrary provider metadata;
 * none of those fields grants file access or belongs in the public projection.
 * Malformed extension messages are dropped without exposing their contents.
 */
export function backgroundIngress(
  stream: Stream,
  receive: (notification: BackgroundNotification) => void,
  rejected: () => void
): Stream {
  return {
    writable: stream.writable,
    readable: stream.readable.pipeThrough(
      new TransformStream<AnyMessage, AnyMessage>({
        transform(message, controller) {
          if (
            "method" in message &&
            message.method === "session/update" &&
            !("id" in message)
          ) {
            const envelope = z
              .object({ update: z.object({ sessionUpdate: z.string() }) })
              .safeParse(message.params);
            const tag = envelope.success
              ? envelope.data.update.sessionUpdate
              : "";
            if (
              [
                "async_task_spawned",
                "async_task_progress",
                "async_task_state_update",
              ].includes(tag)
            ) {
              const parsed = backgroundNotificationSchema.safeParse(
                message.params
              );
              if (parsed.success) receive(parsed.data);
              else rejected();
              return;
            }
          }
          controller.enqueue(message);
        },
      })
    ),
  };
}

export function supportsBackground(meta: unknown): boolean {
  return (
    z
      .object({
        jetbrains: z.object({
          air: z.object({
            version: z.number().int().min(1),
            capabilities: z.array(z.string()),
          }),
        }),
      })
      .safeParse(meta)
      .data?.jetbrains.air.capabilities.includes("asyncTasks") ?? false
  );
}
