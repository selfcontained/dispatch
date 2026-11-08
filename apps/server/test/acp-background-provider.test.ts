import { expect, it } from "vitest";
import { backgroundNotificationSchema } from "../src/agents/acp/background-ingress.js";

it("accepts actual pinned Claude autonomous turn reports without a provider call", async () => {
  const { AsyncTaskRuntime } = await import(
    new URL(
      "../node_modules/@agentclientprotocol/claude-agent-acp/dist/async-tasks.js",
      import.meta.url
    ).href
  );
  const reports: unknown[] = [];
  const runtime = new AsyncTaskRuntime(
    true,
    "inert-session",
    async (notification: unknown) => {
      reports.push(notification);
    }
  );
  await runtime.autonomousTurnStarted("Synthetic background notification");
  await runtime.autonomousTurnEnded("completed");
  const parsed = reports.map((report) =>
    backgroundNotificationSchema.parse(report)
  );
  expect(parsed[0].update).toMatchObject({
    sessionUpdate: "async_task_spawned",
    taskType: "turn",
    name: "Claude is working",
  });
  expect(parsed.at(-1)?.update).toMatchObject({ state: "completed" });
});
