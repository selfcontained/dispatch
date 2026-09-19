#!/usr/bin/env node
// Fake ACP agent for E2E: stands in for every harness engine binary. It
// infers which engine it is from the arguments the driver passes (or from
// FAKE_ACP_ENGINE), and emits what that engine emits: plans for Claude and
// Codex, usage with cost for Claude and OpenCode, a model option for the
// three that publish one, nested tool calls for Claude, a permission ask
// for OpenCode, and honors set_mode for Gemini. It never calls a model and
// never touches the workspace.
import { createRequire } from "node:module";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(
  path.resolve(here, "../../apps/server/package.json")
);
const acp = require("@agentclientprotocol/sdk");

function inferEngine(argv) {
  if (process.env.FAKE_ACP_ENGINE) return process.env.FAKE_ACP_ENGINE;
  if (argv.includes("--dangerously-skip-permissions")) return "claude";
  if (argv.includes("--experimental-acp")) return "gemini";
  if (argv.includes("acp")) return "opencode";
  return "codex";
}
const ENGINE = inferEngine(process.argv.slice(2));
const PROFILE = {
  claude: {
    plan: "plan",
    usage: true,
    cost: true,
    model: true,
    nested: true,
    ask: false,
  },
  codex: {
    plan: "plan_update",
    usage: true,
    cost: false,
    model: true,
    nested: false,
    ask: false,
  },
  gemini: {
    plan: null,
    usage: false,
    cost: false,
    model: false,
    nested: false,
    ask: false,
  },
  opencode: {
    plan: null,
    usage: true,
    cost: true,
    model: true,
    nested: false,
    ask: true,
  },
}[ENGINE];
if (!PROFILE) {
  process.stderr.write(`fake-acp-agent: unknown engine ${ENGINE}\n`);
  process.exit(2);
}

let conn;
const cwdBySession = new Map();
const modelBySession = new Map();
const SLEEP = /sleep:(\d+)/;
const RUN = /run:(\d+)/;
const sleeping = new Map();

const MODEL_OPTION = (current) => ({
  id: "model",
  name: "Model",
  category: "model",
  type: "select",
  currentValue: current,
  options: [
    { value: "default-model", name: "Default model" },
    { value: "other-model", name: "Other model" },
  ],
});
const configOptions = (sessionId) =>
  PROFILE.model
    ? [MODEL_OPTION(modelBySession.get(sessionId) ?? "default-model")]
    : [];

const agent = {
  async initialize() {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentInfo: { name: `fake-${ENGINE}`, version: "0.0.0" },
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
    const sessionId = `fake_${ENGINE}_${Date.now()}`;
    cwdBySession.set(sessionId, params.cwd);
    setTimeout(() => {
      void conn.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: [
            {
              name: "review",
              description: `Review the branch (${ENGINE})`,
              input: null,
            },
            {
              name: "compact",
              description: "Compact the context",
              input: { hint: "what to keep" },
            },
          ],
        },
      });
    }, 0);
    return { sessionId, configOptions: configOptions(sessionId) };
  },
  async resumeSession(params) {
    cwdBySession.set(params.sessionId, params.cwd);
    return { configOptions: configOptions(params.sessionId) };
  },
  async setSessionMode() {
    return {};
  },
  async setSessionConfigOption(params) {
    if (params.configId === "model")
      modelBySession.set(params.sessionId, params.value);
    return { configOptions: configOptions(params.sessionId) };
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
    const run = RUN.exec(text);
    if (run) {
      await emit({
        sessionUpdate: "tool_call",
        toolCallId: "run1",
        title: "bash",
        kind: "execute",
        status: "in_progress",
        rawInput: { command: `sleep ${Number(run[1]) / 1000}` },
        content: [],
      });
      await new Promise((resolve) => setTimeout(resolve, Number(run[1])));
      await emit({
        sessionUpdate: "tool_call_update",
        toolCallId: "run1",
        status: "completed",
        content: [
          { type: "content", content: { type: "text", text: "slept well" } },
        ],
      });
    }
    if (PROFILE.ask) {
      await conn.requestPermission({
        sessionId: params.sessionId,
        toolCall: { toolCallId: "c1", title: "Read README.md" },
        options: [
          { optionId: "once", name: "Allow once", kind: "allow_once" },
          { optionId: "always", name: "Always", kind: "allow_always" },
          { optionId: "no", name: "Reject", kind: "reject_once" },
        ],
      });
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
    if (PROFILE.nested && /subagent:/.test(text)) {
      await emit({
        sessionUpdate: "tool_call",
        toolCallId: "task1",
        title: "Task",
        kind: "other",
        status: "in_progress",
        rawInput: { description: "look around" },
        content: [],
      });
      await emit({
        sessionUpdate: "tool_call",
        toolCallId: "child1",
        title: "Read",
        kind: "read",
        status: "completed",
        locations: [{ path: path.join(cwd, "src/index.ts") }],
        content: [],
        _meta: { claudeCode: { toolName: "Read", parentToolUseId: "task1" } },
      });
      await emit({
        sessionUpdate: "tool_call_update",
        toolCallId: "task1",
        status: "completed",
        content: [
          {
            type: "content",
            content: { type: "text", text: "child finished" },
          },
        ],
      });
    }
    if (PROFILE.plan && /tasks:/.test(text)) {
      const entries = [
        { content: "Read the README", status: "completed", priority: "high" },
        {
          content: "Echo the prompt",
          status: "in_progress",
          priority: "medium",
        },
        { content: "Wrap up", status: "pending", priority: "low" },
      ];
      await emit(
        PROFILE.plan === "plan"
          ? { sessionUpdate: "plan", entries }
          : {
              sessionUpdate: "plan_update",
              plan: { type: "items", planId: "p1", entries },
            }
      );
    }
    if (PROFILE.usage) {
      await emit({
        sessionUpdate: "usage_update",
        used: 12_000,
        size: 200_000,
        ...(PROFILE.cost ? { cost: { amount: 0.42, currency: "USD" } } : {}),
      });
    }
    for (const piece of [
      "You said: ",
      text.replace(/^[\s\S]*?--- DISPATCH CHAT[^\n]*\n/, ""),
    ]) {
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
