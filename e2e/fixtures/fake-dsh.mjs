#!/usr/bin/env node
// Fake `dsh` for E2E: speaks the Agent Client Protocol on stdio, ignores
// --profile/--patch, and scripts one turn per prompt: a tool call that
// completes, an assistant message echoing the prompt, and a usage total.
// It never calls a model and never touches the workspace.
import { createRequire } from "node:module";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(
  path.resolve(here, "../../apps/server/package.json")
);
const acp = require("@agentclientprotocol/sdk");

let conn;
const cwdBySession = new Map();
// A prompt containing "sleep:<ms>" holds its turn that long (or until the
// client cancels it), so a spec can watch what queues behind a running turn.
const SLEEP = /sleep:(\d+)/;
// One resolver per sleeping session, so a cancel reaches the right turn.
const sleeping = new Map();

const agent = {
  async initialize() {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentInfo: { name: "fake-dsh", version: "0.0.0" },
      agentCapabilities: {
        mcpCapabilities: { http: true },
        sessionCapabilities: { close: {}, resume: {} },
      },
      authMethods: [],
    };
  },
  async authenticate() {
    return {};
  },
  async newSession(params) {
    const sessionId = `fake_${Date.now()}`;
    cwdBySession.set(sessionId, params.cwd);
    process.stderr.write(
      `fake-dsh newSession cwd=${params.cwd} mcp=${JSON.stringify(
        (params.mcpServers ?? []).map((s) => s.name)
      )}\n`
    );
    return { sessionId, configOptions: [] };
  },
  async resumeSession(params) {
    cwdBySession.set(params.sessionId, params.cwd);
    return { configOptions: [] };
  },
  async prompt(params) {
    const text = params.prompt
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
    const cwd = cwdBySession.get(params.sessionId) ?? process.cwd();
    const emit = (update) =>
      conn.sessionUpdate({ sessionId: params.sessionId, update });
    const sleep = SLEEP.exec(text);
    if (sleep) {
      const cancelled = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), Number(sleep[1]));
        sleeping.set(params.sessionId, () => {
          clearTimeout(timer);
          resolve(true);
        });
      });
      sleeping.delete(params.sessionId);
      if (cancelled) return { stopReason: "cancelled" };
    }
    await emit({
      sessionUpdate: "tool_call",
      toolCallId: "c1",
      title: "Read README.md",
      kind: "read",
      status: "in_progress",
      locations: [{ path: path.join(cwd, "README.md") }],
      content: [],
    });
    await emit({
      sessionUpdate: "tool_call_update",
      toolCallId: "c1",
      status: "completed",
    });
    // A prompt mentioning "tasks:" writes a task list the way dsh's todo
    // tool does, so the view's task strip and step have something to show.
    if (/tasks:/.test(text)) {
      const todos = [
        { content: "Read the README", status: "completed" },
        { content: "Echo the prompt", status: "in_progress" },
        { content: "Wrap up", status: "pending" },
      ];
      await emit({
        sessionUpdate: "tool_call",
        toolCallId: "todo1",
        title: "todo_write",
        kind: "edit",
        status: "in_progress",
        rawInput: { todos },
        content: [],
      });
      await emit({
        sessionUpdate: "tool_call_update",
        toolCallId: "todo1",
        status: "completed",
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: "Updated todo list: 1 pending, 1 in progress, 1 completed.",
            },
          },
        ],
      });
    }
    for (const piece of ["You said: ", text]) {
      await emit({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: piece },
      });
    }
    return {
      stopReason: "end_turn",
      usage: {
        totalTokens: 120,
        inputTokens: 100,
        outputTokens: 20,
        thoughtTokens: 0,
        cachedReadTokens: 0,
        cachedWriteTokens: 0,
      },
    };
  },
  async cancel(params) {
    sleeping.get(params.sessionId)?.();
  },
  async closeSession() {
    return {};
  },
};

const stream = acp.ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin)
);
conn = new acp.AgentSideConnection(() => agent, stream);
process.stdin.on("end", () => process.exit(0));
