import { ClaudeAcpAgent } from "@agentclientprotocol/claude-agent-acp/dist/acp-agent.js";
import { describe, expect, it, vi } from "vitest";
import type { DriverUpdate } from "../src/agents/acp/driver.js";
import { StreamRecorder } from "../src/agents/acp/stream-recorder.js";
import type {
  StreamEventRow,
  StreamStore,
} from "../src/agents/acp/stream-store.js";

// Exercise the installed pnpm-patched adapter and real recorder. Only the SDK
// iterator and persistence are doubles; no reconciliation logic is copied here.
async function record(messages: unknown[]) {
  const rows: StreamEventRow[] = [];
  const store = {
    openTurn: vi.fn(async () => null),
    upsertByKey: vi.fn(),
    append: vi.fn(async (agentId, kind, payload) => {
      const row = {
        id: String(rows.length),
        agentId,
        kind,
        payload,
      } as StreamEventRow;
      rows.push(row);
      return row;
    }),
    updatePayload: vi.fn(async (id, payload) => {
      rows.find((row) => row.id === id)!.payload = payload;
    }),
  };
  const recorder = new StreamRecorder(store as unknown as StreamStore);
  const logger = { log: vi.fn(), error: vi.fn(), warn: vi.fn() };
  const adapter = new ClaudeAcpAgent(
    {
      sessionUpdate: async ({ update }: { update: DriverUpdate }) => {
        await recorder.handle({
          type: "update",
          agentId: "output-test",
          update,
        });
      },
    } as never,
    logger
  );
  const iterator = (async function* () {
    yield* messages;
  })();
  const session = {
    activeTurn: null,
    turnQueue: [],
    query: { next: () => iterator.next(), close: vi.fn() },
    input: { end: vi.fn() },
    settingsManager: { dispose: vi.fn() },
    msgLifecycleV1: true,
    orphanCommands: new Map(),
    liveBackgroundTasks: new Map(),
    emittedToolCalls: new Set(),
    messageIdToUuid: new Map(),
    emittedAssistantText: false,
    owedTrailingIdles: 0,
    accumulatedUsage: {
      inputTokens: 0,
      outputTokens: 0,
      cachedReadTokens: 0,
      cachedWriteTokens: 0,
    },
    accumulatedModelUsage: {},
    toolUseCache: {},
    titles: { onAssistantText: vi.fn(), onTurnEnd: vi.fn() },
  };
  Object.assign(adapter, { sessions: { "output-test": session } });
  Reflect.get(adapter, "ensureConsumer").call(adapter, session, "output-test");
  await Reflect.get(session, "consumer");
  await recorder.handle({ type: "exit", agentId: "output-test", code: 0 });
  expect(logger.error.mock.calls).toEqual([]);
  return rows
    .filter((row) => row.kind === "assistant" || row.kind === "thought")
    .map((row) => ({
      kind: row.kind,
      text: (row.payload as { text: string }).text,
    }));
}

const stream = (event: unknown) => ({
  type: "stream_event",
  parent_tool_use_id: null,
  event,
});
const start = (id: string) =>
  stream({
    type: "message_start",
    message: {
      id,
      model: "claude-test",
      usage: { input_tokens: 1, output_tokens: 0 },
    },
  });
const delta = (text: string, index = 0, thinking = false) =>
  stream({
    type: "content_block_delta",
    index,
    delta: thinking
      ? { type: "thinking_delta", thinking: text }
      : { type: "text_delta", text },
  });
const assistant = (id: string, content: unknown[]) => ({
  type: "assistant",
  uuid: id,
  parent_tool_use_id: null,
  message: {
    id,
    role: "assistant",
    model: "claude-test",
    usage: { input_tokens: 1, output_tokens: 1 },
    content,
  },
});
const text = (value: string) => ({ type: "text", text: value });

describe("Claude adapter output reconciliation", () => {
  it("reconciles captured 2.1.304 fresh/resumed event shapes and preserves identical later replies", async () => {
    // CLI 2.1.304 emits its assembled assistant before content_block_stop.
    // These are captured event shapes, not an exercise of session/resume.
    const reply = "Verified reply once.";
    const events = ["fresh", "resumed"].flatMap((id) => [
      start(id),
      delta(reply),
      assistant(id, [text(reply)]),
      stream({ type: "content_block_stop", index: 0 }),
      stream({ type: "message_stop" }),
    ]);
    expect(await record(events)).toEqual([
      { kind: "assistant", text: reply + reply },
    ]);
  });

  it.each(["", "Part", "Partial reply."])(
    "preserves an unstreamed tail after %j",
    async (prefix) => {
      expect(
        await record([
          start("partial"),
          delta(prefix),
          assistant("partial", [text("Partial reply.")]),
        ])
      ).toEqual([{ kind: "assistant", text: "Partial reply." }]);
    }
  );

  it("keeps thinking and text distinct without duplicating either", async () => {
    expect(
      await record([
        start("thinking"),
        delta("Reasoning", 0, true),
        assistant("thinking", [{ type: "thinking", thinking: "Reasoning" }]),
        delta("Answer", 1),
        assistant("thinking", [text("Answer")]),
      ])
    ).toEqual([
      { kind: "thought", text: "Reasoning" },
      { kind: "assistant", text: "Answer" },
    ]);
  });

  it("keeps identical replies separated by a tool call", async () => {
    expect(
      await record([
        start("before-tool"),
        delta("Done"),
        assistant("before-tool", [
          text("Done"),
          {
            type: "tool_use",
            id: "read-tool",
            name: "Read",
            input: { file_path: "/tmp/example" },
          },
        ]),
        start("after-tool"),
        delta("Done"),
        assistant("after-tool", [text("Done")]),
      ])
    ).toEqual([
      { kind: "assistant", text: "Done" },
      { kind: "assistant", text: "Done" },
    ]);
  });

  it("preserves a literal timestamp generated as part of the reply", async () => {
    const reply = "[23:26:49] Example log entry.";
    expect(
      await record([
        start("timestamp"),
        delta(reply),
        assistant("timestamp", [text(reply)]),
      ])
    ).toEqual([{ kind: "assistant", text: reply }]);
  });
});
