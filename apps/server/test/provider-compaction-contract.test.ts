import { SessionBackgroundWork } from "@agentclientprotocol/claude-agent-acp/dispatch-test/background-work";
import { ClaudeAcpAgent } from "@agentclientprotocol/claude-agent-acp/dispatch-test/acp-agent";
import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";
import { ContextCompactionLifecycle } from "@agentclientprotocol/claude-agent-acp/dispatch-test/context-compaction";
import fixtures from "../../../test-fixtures/provider-compactions.json";
import { compactionPayloadOf } from "../src/agents/acp/stream-recorder.js";
import { assembleTurns, type TurnSourceRow } from "../src/chat/turns.js";

function stepFromPayload(
  sample: (typeof fixtures.samples)[number],
  payload: Record<string, unknown>,
  live: boolean
) {
  const createdAt = new Date(sample.createdAt);
  const rows: TurnSourceRow[] = [
    {
      id: 1,
      seq: 1,
      kind: "turn",
      key: null,
      payload: {
        state: "started",
        prompt: { source: "system", text: "fixture" },
      },
      createdAt: new Date(createdAt.getTime() - 1),
      updatedAt: createdAt,
    },
    {
      id: sample.seq,
      seq: sample.seq,
      kind: "compaction",
      key: sample.key,
      payload,
      createdAt,
      updatedAt: new Date(live ? sample.createdAt : sample.updatedAt),
    },
  ];
  return assembleTurns(rows, new Map())[0].trace.steps[0];
}

describe("recorded provider compaction contract", () => {
  it.each(fixtures.samples)(
    "maps $runtime/$model recorded seq$seq through ACP payload and server wire step",
    (sample) => {
      const running = compactionPayloadOf(sample.acpStart, {});
      expect(running).toEqual({ status: "in_progress", summary: "" });
      expect(stepFromPayload(sample, running, true)).toEqual(sample.liveStep);
      // Codex status-only payloads normalize to empty summary. Claude's stored
      // summary content is redacted; its recorded length is provenance only.
      const terminal = compactionPayloadOf(
        sample.originalSummaryLength
          ? {
              ...sample.acpEnd,
              summary: [{ type: "text", text: sample.payload.summary }],
            }
          : sample.acpEnd,
        running
      );
      expect(terminal).toEqual(sample.payload);
      if (sample.runtime === "claude")
        expect(
          compactionPayloadOf(sample.acpEnd, {
            ...running,
            summary: sample.payload.summary,
          })
        ).toEqual(sample.payload);
      expect(stepFromPayload(sample, terminal, false)).toMatchObject(
        sample.terminalStep
      );
    }
  );
  it("the installed Claude lifecycle emits the fixture's real ACP shape without a model", async () => {
    const sample = fixtures.samples.find(
      (sample) => sample.runtime === "claude"
    )!;
    const emitted: unknown[] = [];
    const lifecycle = new ContextCompactionLifecycle(
      async (notification) => {
        emitted.push(notification.update);
      },
      { sessionId: "fixture", presentation: "compaction_update" }
    );
    await lifecycle.start(sample.key);
    expect(emitted[0]).toEqual(sample.acpStart);
    lifecycle.recordSummary(sample.payload.summary);
    await lifecycle.finish(sample.key, "completed");
    expect(emitted[1]).toMatchObject(sample.acpEnd);
    expect(
      compactionPayloadOf(emitted[1] as Record<string, unknown>, {})
    ).toEqual(sample.payload);
  });
});

it("the installed Claude consumer maps native SDK compacting status to the fixture ACP entry", async () => {
  const sample = fixtures.samples.find(
    (sample) => sample.runtime === "claude"
  )!;
  const sessionUpdate = vi.fn(async () => {});
  const error = vi.fn();
  const adapter = new ClaudeAcpAgent(
    { sessionUpdate } as unknown as AgentSideConnection,
    { error, log: vi.fn() }
  ) as unknown as {
    clientCapabilities: unknown;
    sessions: Record<string, unknown>;
    runConsumer(session: unknown, params: { sessionId: string }): Promise<void>;
  };
  adapter.clientCapabilities = { session: { compaction: {} } };
  const turn = {
    events: { inserted: vi.fn(), running: vi.fn() },
    settled: false,
    steeredEchoes: new Set(),
    reject: vi.fn(),
    resolve: vi.fn(),
  };
  const session = {
    activeTurn: turn as typeof turn | undefined,
    cancelController: new AbortController(),
    turnQueue: [],
    sessionFailureState: {},
    messageIdToUuid: new Map(),
    background: new SessionBackgroundWork("fixture"),
    liveBackgroundTasks: new Map(),
    accumulatedUsage: {
      inputTokens: 0,
      outputTokens: 0,
      cachedReadTokens: 0,
      cachedWriteTokens: 0,
    },
    settingsManager: { dispose: vi.fn() },
    input: { end: vi.fn() },
    query: Object.assign(
      (async function* () {
        yield {
          type: "system",
          subtype: "status",
          status: "compacting",
          uuid: sample.key,
        };
        yield {
          type: "system",
          subtype: "status",
          status: null,
          compact_result: "success",
          uuid: sample.key,
        };
        session.activeTurn = undefined;
      })(),
      { close: vi.fn() }
    ),
  };
  adapter.sessions.fixture = session;
  await adapter.runConsumer(session, { sessionId: "fixture" });
  expect(error).not.toHaveBeenCalled();
  expect(
    sessionUpdate.mock.calls.map(
      (call) => (call as unknown as [{ update: unknown }])[0].update
    )
  ).toEqual([sample.acpStart, sample.acpEnd]);
});
