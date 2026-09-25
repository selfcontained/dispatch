import { ClaudeAcpAgent } from "@agentclientprotocol/claude-agent-acp/dist/acp-agent.js";
import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";

describe("bundled Claude steering receipt patch", () => {
  it.each(["steer", "prompt"])(
    "emits one receipt in the owning session for a current %s echo",
    async (kind) => {
      const sessionUpdate = vi.fn(async () => {});
      const error = vi.fn();
      // Exercise the installed patched consumer, not a replacement ACP fixture.
      // Only the SDK query is fake: no credentials or live model are needed.
      const adapter = new ClaudeAcpAgent(
        { sessionUpdate } as unknown as AgentSideConnection,
        { error, log: vi.fn() }
      ) as unknown as {
        sessions: Record<string, unknown>;
        runConsumer(
          session: unknown,
          params: { sessionId: string }
        ): Promise<void>;
      };
      const receiptId = "a1234567-0000-4000-8000-000000000000";
      const turn = {
        settled: false,
        promptUuid: kind === "prompt" ? receiptId : undefined,
        receiptId: kind === "prompt" ? receiptId : undefined,
        steeredEchoes: new Set([receiptId]),
        reject: vi.fn(),
        resolve: vi.fn(),
      };
      const session = {
        activeTurn: turn as typeof turn | undefined,
        cancelController: new AbortController(),
        turnQueue: kind === "prompt" ? [turn] : [],
        sessionFailureState: {},
        messageIdToUuid: new Map(),
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
            for (const uuid of ["unrelated-replay", receiptId, receiptId]) {
              yield {
                type: "user",
                uuid,
                isReplay: true,
                parent_tool_use_id: null,
                message: { role: "user", content: "identical text" },
              };
            }
            session.activeTurn = undefined;
            session.turnQueue = [];
          })(),
          { close: vi.fn() }
        ),
      };
      adapter.sessions["owning-session"] = session;
      await adapter.runConsumer(session, { sessionId: "owning-session" });
      expect(error).not.toHaveBeenCalled();
      expect(turn.reject).not.toHaveBeenCalled();
      expect(sessionUpdate.mock.calls).toEqual([
        [
          {
            sessionId: "owning-session",
            update: {
              sessionUpdate: "session_info_update",
              _meta: { "dispatch/steering": { pickedUp: receiptId } },
            },
          },
        ],
      ]);
    }
  );
});
