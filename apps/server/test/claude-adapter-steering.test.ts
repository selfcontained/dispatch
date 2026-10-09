import { ClaudeAcpAgent } from "@agentclientprotocol/claude-agent-acp/dist/acp-agent.js";
import { describe, expect, it, vi } from "vitest";

const sessionId = "steering-test";

function fixture(active = true) {
  const turn = {
    promptUuid: "original-prompt",
    settled: false,
    resolve: vi.fn(),
  };
  const session = {
    activeTurn: active ? turn : null,
    turnQueue: [turn],
    input: { push: vi.fn() },
    query: {
      cancelAsyncMessage: vi.fn(async (_uuid: string) => true),
      interrupt: vi.fn(async () => undefined),
    },
    pendingUserInputCount: 0,
  };
  const agent = {
    sessions: { [sessionId]: session },
    respawnSignedOutSession: vi.fn(),
    publishGoalFromPrompt: vi.fn(),
    exitPlan: { cancel: vi.fn() },
    trackOrphanCommand: vi.fn(),
    logger: { error: vi.fn() },
  };
  // Minimal session/transport doubles; the methods under test are the actual
  // installed (pnpm-patched) adapter, not a copy of its implementation.
  const adapter = agent as unknown as ClaudeAcpAgent;
  const steer = () =>
    ClaudeAcpAgent.prototype.steer.call(adapter, {
      sessionId,
      prompt: [{ type: "text", text: "Apply this correction" }],
    });
  const cancel = () =>
    ClaudeAcpAgent.prototype.cancel.call(adapter, { sessionId });
  return { agent, session, turn, steer, cancel };
}

describe("patched Claude adapter steering", () => {
  it.each([0, 1, 2])(
    "uses next between tools, later with %i pending user-input callbacks",
    async (pending) => {
      const { session, steer } = fixture();
      session.pendingUserInputCount = pending;
      await expect(steer()).resolves.toEqual({ outcome: "injected" });
      expect(session.input.push).toHaveBeenCalledWith(
        expect.objectContaining({ priority: pending > 0 ? "later" : "next" })
      );
      expect(session.query.interrupt).not.toHaveBeenCalled();
    }
  );

  it.each([true, false])(
    "withdraws every queued steer before interrupt (active=%s)",
    async (active) => {
      const { session, agent, steer, cancel } = fixture(active);
      await steer();
      await steer();
      const uuids = session.input.push.mock.calls.map(
        ([message]) => message.uuid
      );
      await cancel();
      expect(session.query.cancelAsyncMessage.mock.calls).toEqual(
        uuids.map((uuid) => [uuid])
      );
      expect(
        session.query.cancelAsyncMessage.mock.invocationCallOrder.at(-1)
      ).toBeLessThan(session.query.interrupt.mock.invocationCallOrder[0]!);
      for (const uuid of uuids) {
        expect(agent.trackOrphanCommand).not.toHaveBeenCalledWith(
          session,
          uuid,
          "pending"
        );
      }
    }
  );

  it("waits for withdrawal to finish before interrupting", async () => {
    const { session, steer, cancel } = fixture();
    session.pendingUserInputCount = 1;
    await steer();
    let release!: (withdrawn: boolean) => void;
    session.query.cancelAsyncMessage.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        })
    );
    const cancellation = cancel();
    await vi.waitFor(() =>
      expect(session.query.cancelAsyncMessage).toHaveBeenCalledOnce()
    );
    expect(session.query.interrupt).not.toHaveBeenCalled();
    release(true);
    await cancellation;
    expect(session.query.interrupt).toHaveBeenCalledOnce();
  });

  it.each(["consumed", "error", "unsupported"])(
    "retains orphan tracking and interrupts when withdrawal is %s",
    async (outcome) => {
      const { session, agent, steer, cancel } = fixture();
      await steer();
      const uuid = session.input.push.mock.calls[0]![0].uuid;
      if (outcome === "error") {
        session.query.cancelAsyncMessage.mockRejectedValue(
          new Error("transport closed")
        );
      } else if (outcome === "consumed") {
        session.query.cancelAsyncMessage.mockResolvedValue(false);
      } else {
        Object.assign(session.query, { cancelAsyncMessage: undefined });
      }
      await cancel();
      expect(agent.trackOrphanCommand).toHaveBeenCalledWith(
        session,
        uuid,
        "pending"
      );
      expect(session.query.interrupt).toHaveBeenCalledOnce();
    }
  );
});
