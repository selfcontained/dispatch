import { PassThrough, Readable, Writable } from "node:stream";
import { createInterface } from "node:readline";
import * as acp from "@agentclientprotocol/sdk";
import { describe, it, expect, vi } from "vitest";
import {
  backgroundIngress,
  backgroundCapability,
  type BackgroundNotification,
} from "../src/agents/acp/background-ingress.js";

// Inert wire peers: no process, provider request, filesystem or model call.
function peer() {
  const input = new PassThrough();
  const output = new PassThrough();
  const requests: unknown[] = [];
  const lines = createInterface({ input: output });
  lines.on("line", (line) => {
    const request = JSON.parse(line);
    requests.push(request);
    if (request.method === "initialize")
      send({
        jsonrpc: "2.0",
        id: request.id,
        result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] },
      });
  });
  function send(message: unknown) {
    input.write(JSON.stringify(message) + "\n");
  }
  return {
    input,
    output,
    lines,
    requests,
    send,
    stream: acp.ndJsonStream(Writable.toWeb(output), Readable.toWeb(input)),
  };
}

describe("pinned SDK background extension ingress", () => {
  it.each(["claude", "codex"])(
    "keeps SDK validation while accepting %s lifecycle notifications",
    async (provider) => {
      const wire = peer();
      const received: BackgroundNotification[] = [];
      const ordinary = vi.fn();
      const rejected = vi.fn();
      const conn = new acp.ClientSideConnection(
        () => ({
          sessionUpdate: ordinary,
          requestPermission: async () => ({
            outcome: { outcome: "cancelled" },
          }),
        }),
        backgroundIngress(wire.stream, (n) => received.push(n), rejected)
      );
      try {
        const initialized = await conn.initialize({
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: { _meta: backgroundCapability },
        });
        expect(initialized.agentCapabilities).toEqual({}); // old host capability fallback
        expect(wire.requests[0]).toMatchObject({
          method: "initialize",
          params: {
            clientCapabilities: {
              _meta: {
                jetbrains: {
                  air: { version: 1, capabilities: ["asyncTasks"] },
                },
              },
            },
          },
        });
        const notify = (update: unknown, sessionId = "session-1") =>
          wire.send({
            jsonrpc: "2.0",
            method: "session/update",
            params: { sessionId, update },
          });
        const spawn = {
          sessionUpdate: "async_task_spawned",
          asyncTaskId: "task-1",
          name: "Watch build",
          taskType: provider === "claude" ? "monitor" : "shell",
          showInTranscript: false,
          canStop: provider !== "claude",
          outputFilePath: "/private/never-read",
        };
        notify(spawn);
        notify({
          sessionUpdate: "async_task_progress",
          asyncTaskId: "task-1",
          summary: "working",
          toolCallId: "tool-1",
        });
        notify({
          sessionUpdate: "async_task_state_update",
          asyncTaskId: "task-1",
          state: "paused",
        });
        notify({
          sessionUpdate: "async_task_state_update",
          asyncTaskId: "task-1",
          state: "completed",
        });
        notify({ ...spawn, asyncTaskId: 4 });
        notify({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "ordinary" },
        });
        await vi.waitFor(() => expect(ordinary).toHaveBeenCalledOnce());
        expect(received).toHaveLength(4);
        expect(received[0].update).not.toHaveProperty("outputFilePath");
        expect(received[0].update).toMatchObject({
          taskType: provider === "claude" ? "monitor" : "shell",
          canStop: provider !== "claude",
        });
        expect(rejected).toHaveBeenCalledOnce();
        // Unknown extension variants stay on the SDK path, never become lifecycle.
        notify({ sessionUpdate: "async_task_future", asyncTaskId: "task-1" });
        notify({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "after unknown" },
        });
        await vi.waitFor(() => expect(ordinary).toHaveBeenCalledTimes(2));
        expect(received).toHaveLength(4);
      } finally {
        wire.input.end();
        wire.output.end();
        wire.lines.close();
      }
    }
  );
});
