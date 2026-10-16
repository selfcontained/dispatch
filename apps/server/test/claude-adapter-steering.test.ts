import { ClaudeAcpAgent } from "@agentclientprotocol/claude-agent-acp/dist/acp-agent.js";
import { Pushable } from "@agentclientprotocol/claude-agent-acp/dist/utils.js";
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
    openUserInputs: new Set(),
    msgLifecycleV1: true,
    orphanCommands: new Map<string, string>(),
    pendingOrphanResults: 0,
  };
  const agent = {
    sessions: { [sessionId]: session },
    respawnSignedOutSession: vi.fn(),
    publishGoalFromPrompt: vi.fn(),
    exitPlan: { cancel: vi.fn() },
    trackOrphanCommand: vi.fn(
      Reflect.get(ClaudeAcpAgent.prototype, "trackOrphanCommand")
    ),
    forgetLegacyOrphan: Reflect.get(
      ClaudeAcpAgent.prototype,
      "forgetLegacyOrphan"
    ),
    cancelTurns: Reflect.get(ClaudeAcpAgent.prototype, "cancelTurns"),
    dropQueuedMessages: Reflect.get(
      ClaudeAcpAgent.prototype,
      "dropQueuedMessages"
    ),
    stopBackgroundWorkflows: Reflect.get(
      ClaudeAcpAgent.prototype,
      "stopBackgroundWorkflows"
    ),
    forceCancelGraceMs: 30_000,
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
      session.openUserInputs = new Set(
        Array.from({ length: pending }, () => ({}))
      );
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
        [...uuids, ...(active ? [] : ["original-prompt"])].map((uuid) => [uuid])
      );
      expect(
        session.query.cancelAsyncMessage.mock.invocationCallOrder.at(-1)
      ).toBeLessThan(session.query.interrupt.mock.invocationCallOrder[0]!);
      for (const uuid of uuids) {
        expect(session.orphanCommands.has(uuid)).toBe(false);
        expect(agent.trackOrphanCommand).toHaveBeenCalledWith(
          session,
          uuid,
          "pending"
        );
      }
    }
  );

  it("waits for withdrawal to finish before interrupting", async () => {
    const { session, steer, cancel } = fixture();
    session.openUserInputs.add({});
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

  it("drops a queued prompt once alongside withdrawn steers", async () => {
    const { session, steer, cancel } = fixture();
    await steer();
    const uuid = session.input.push.mock.calls[0]![0].uuid;
    const queued = {
      promptUuid: "queued-prompt",
      settled: false,
      resolve: vi.fn(),
    };
    session.turnQueue.push(queued);
    await cancel();
    expect(queued.resolve).toHaveBeenCalledWith({ stopReason: "cancelled" });
    expect(session.query.cancelAsyncMessage.mock.calls).toEqual([
      [uuid],
      ["queued-prompt"],
    ]);
    expect(
      session.query.cancelAsyncMessage.mock.invocationCallOrder.at(-1)
    ).toBeLessThan(session.query.interrupt.mock.invocationCallOrder[0]!);
  });

  it("drops remaining steers without duplicating a timed-out withdrawal", async () => {
    const { agent, session, steer, cancel } = fixture();
    agent.forceCancelGraceMs = 40;
    await steer();
    await steer();
    const uuids = session.input.push.mock.calls.map(
      ([message]) => message.uuid
    );
    session.query.cancelAsyncMessage.mockImplementation(
      () => new Promise<boolean>(() => {})
    );
    await cancel();
    expect(session.query.cancelAsyncMessage.mock.calls).toEqual(
      uuids.map((uuid) => [uuid])
    );
    expect(session.query.interrupt).toHaveBeenCalledOnce();
  });

  it("reconciles only outstanding steers from the interrupt receipt", async () => {
    const { session, steer, cancel } = fixture();
    session.msgLifecycleV1 = false;
    // One unrelated orphan must survive; a successfully withdrawn steer must
    // not be subtracted again when it is absent from the interrupt receipt.
    session.pendingOrphanResults = 1;
    await steer();
    await steer();
    session.query.cancelAsyncMessage
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    session.query.interrupt.mockResolvedValue({ still_queued: [] } as never);
    await cancel();
    expect(session.pendingOrphanResults).toBe(1);
  });

  it("keeps teardown nonblocking and drops each abandoned message once", async () => {
    const { agent, session, steer } = fixture(false);
    await steer();
    const uuid = session.input.push.mock.calls[0]![0].uuid;
    session.query.cancelAsyncMessage.mockImplementation(
      () => new Promise<boolean>(() => {})
    );
    session.query.interrupt.mockImplementation(() => new Promise(() => {}));
    await agent.cancelTurns.call(
      agent,
      { sessionId },
      { awaitInterrupt: false }
    );
    expect(session.query.cancelAsyncMessage.mock.calls).toEqual([
      [uuid],
      ["original-prompt"],
    ]);
    expect(session.query.interrupt).toHaveBeenCalledOnce();
  });

  it("reconciles successful withdrawal in the legacy count lane", async () => {
    const { session, steer, cancel } = fixture();
    session.msgLifecycleV1 = false;
    await steer();
    await steer();
    await cancel();
    expect(session.pendingOrphanResults).toBe(0);
  });

  it.each(["active", "queued"])(
    "does not interrupt an %s replacement turn after a late withdrawal response",
    async (state) => {
      const { session, steer, cancel } = fixture();
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
      const replacement = {
        promptUuid: "replacement",
        settled: false,
        resolve: vi.fn(),
      };
      if (state === "active") session.activeTurn = replacement;
      else {
        session.activeTurn = null;
        session.turnQueue.push(replacement);
      }
      release(false);
      await cancellation;
      expect(session.query.interrupt).not.toHaveBeenCalled();
    }
  );

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

function consumerFixture() {
  const messages = new Pushable<unknown>();
  const iterator = messages[Symbol.asyncIterator]();
  const updates = vi.fn();
  const logger = { log: vi.fn(), error: vi.fn(), warn: vi.fn() };
  const adapter = new ClaudeAcpAgent(
    { sessionUpdate: updates } as never,
    logger
  );
  const session = {
    activeTurn: null as ReturnType<typeof makeTurn> | null,
    turnQueue: [] as ReturnType<typeof makeTurn>[],
    query: {
      next: vi.fn(() => iterator.next()),
      close: () => messages.end(),
      cancelAsyncMessage: vi.fn(async (_uuid: string) => false),
      interrupt: vi.fn(async () => undefined),
    },
    input: { push: vi.fn(), end: vi.fn() },
    settingsManager: { dispose: vi.fn() },
    msgLifecycleV1: true,
    orphanCommands: new Map<string, string>(),
    liveBackgroundTasks: new Map(),
    emittedToolCalls: new Set(),
    emittedAssistantText: false,
    owedTrailingIdles: 0,
    accumulatedUsage: {
      inputTokens: 0,
      outputTokens: 0,
      cachedReadTokens: 0,
      cachedWriteTokens: 0,
    },
    accumulatedModelUsage: {},
    titles: { onAssistantText: vi.fn(), onTurnEnd: vi.fn() },
  };
  Object.assign(adapter, { sessions: { [sessionId]: session } });
  Reflect.get(adapter, "ensureConsumer").call(adapter, session, sessionId);
  const stop = async () => {
    messages.end();
    await Reflect.get(session, "consumer");
  };
  return { adapter, session, messages, logger, stop };
}

function makeTurn(uuid: string) {
  return {
    promptUuid: uuid,
    events: { inserted: vi.fn(), running: vi.fn() },
    settled: false,
    isLocalOnlyCommand: true,
    resolve: vi.fn(),
    reject: vi.fn(),
    steeredEchoes: undefined as Set<string> | undefined,
  };
}

function result(uuid?: string) {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "",
    num_turns: 1,
    ...(uuid ? { user_message_uuid: uuid } : {}),
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  };
}

const lifecycle = (uuid: string, state: string) => ({
  type: "command_lifecycle",
  command_uuid: uuid,
  state,
});
const idle = {
  type: "system",
  subtype: "session_state_changed",
  state: "idle",
};

describe("Claude cancellation with concurrent consumer events", () => {
  it.each([
    ["false", "completed"],
    ["rejection", "completed"],
    ["false", "cancelled"],
    ["rejection", "cancelled"],
  ])(
    "does not recreate drained steer orphans after %s withdrawal and %s lifecycle",
    async (outcome, terminal) => {
      const { adapter, session, messages, logger, stop } = consumerFixture();
      const active = makeTurn("original");
      active.steeredEchoes = new Set(["first-steer", "second-steer"]);
      session.activeTurn = active;
      session.turnQueue.push(active);
      let release!: (value: boolean) => void;
      let reject!: (error: Error) => void;
      session.query.cancelAsyncMessage.mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve, fail) => {
            release = resolve;
            reject = fail;
          })
      );
      try {
        const cancellation = adapter.cancel({ sessionId });
        await vi.waitFor(() =>
          expect(session.query.cancelAsyncMessage).toHaveBeenCalledOnce()
        );
        expect(session.orphanCommands.size).toBe(2);
        const readsBefore = session.query.next.mock.calls.length;
        for (const uuid of active.steeredEchoes) {
          messages.push(lifecycle(uuid, "started"));
          messages.push(result(uuid));
          messages.push(lifecycle(uuid, terminal));
        }
        await vi.waitFor(() =>
          expect(session.query.next.mock.calls.length).toBeGreaterThanOrEqual(
            readsBefore + 6
          )
        );
        expect(session.orphanCommands.size).toBe(0);
        if (outcome === "rejection")
          reject(new Error("late withdrawal failure"));
        else release(false);
        await cancellation;
        messages.push(idle);
        await vi.waitFor(() =>
          expect(active.resolve).toHaveBeenCalledWith(
            expect.objectContaining({ stopReason: "cancelled" })
          )
        );
        expect(session.orphanCommands.size).toBe(0);
        const next = makeTurn("echo-less-command");
        session.turnQueue.push(next);
        messages.push(result());
        await vi.waitFor(() => {
          expect(
            logger.error.mock.calls.filter(([text]) =>
              String(text).includes("query stream error")
            )
          ).toEqual([]);
          expect(next.reject.mock.calls).toEqual([]);
          expect(next.resolve).toHaveBeenCalledWith(
            expect.objectContaining({ stopReason: "end_turn" })
          );
        });
        expect(next.reject).not.toHaveBeenCalled();
      } finally {
        await stop();
      }
      expect(
        logger.error.mock.calls.filter(([text]) =>
          String(text).includes("consumer terminated")
        )
      ).toEqual([]);
    }
  );

  it("withdraws all remaining steers when idle settles the owner during withdrawal", async () => {
    const { adapter, session, messages, stop } = consumerFixture();
    const active = makeTurn("settles-during-withdrawal");
    active.steeredEchoes = new Set(["first-steer", "second-steer"]);
    session.activeTurn = active;
    session.turnQueue.push(active);
    let release!: (value: boolean) => void;
    session.query.cancelAsyncMessage.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        })
    );
    session.query.cancelAsyncMessage.mockResolvedValue(true);
    try {
      const cancellation = adapter.cancel({ sessionId });
      await vi.waitFor(() =>
        expect(session.query.cancelAsyncMessage).toHaveBeenCalledOnce()
      );
      messages.push(idle);
      await vi.waitFor(() =>
        expect(active.resolve).toHaveBeenCalledWith(
          expect.objectContaining({ stopReason: "cancelled" })
        )
      );
      expect(session.activeTurn).toBeNull();
      release(true);
      await cancellation;
      expect(session.query.cancelAsyncMessage.mock.calls).toEqual([
        ["first-steer"],
        ["second-steer"],
      ]);
      expect(session.orphanCommands.size).toBe(0);
      expect(session.query.interrupt).toHaveBeenCalledOnce();
    } finally {
      await stop();
    }
  });

  it.each(
    ["queued-prompt", "second-steer"].flatMap((remaining) => [
      [remaining, "withdrawal", "false"],
      [remaining, "withdrawal", "true"],
      [remaining, "withdrawal", "rejection"],
      [remaining, "interrupt", "false"],
    ])
  )(
    "keeps the %s orphan when a steer result drains during %s (%s reply)",
    async (remaining, phase, outcome) => {
      const { adapter, session, messages, stop } = consumerFixture();
      Object.assign(session, {
        msgLifecycleV1: false,
        pendingOrphanResults: 0,
      });
      const active = makeTurn("legacy-owner");
      active.steeredEchoes = new Set([
        "consumed-steer",
        ...(remaining === "second-steer" ? [remaining] : []),
      ]);
      session.activeTurn = active;
      session.turnQueue.push(active);
      if (remaining === "queued-prompt")
        session.turnQueue.push(makeTurn(remaining));
      let release!: () => void;
      if (phase === "withdrawal") {
        session.query.cancelAsyncMessage.mockImplementationOnce(
          () =>
            new Promise<boolean>((resolve, reject) => {
              release = () =>
                outcome === "rejection"
                  ? reject(new Error("late withdrawal failure"))
                  : resolve(outcome === "true");
            })
        );
        session.query.interrupt.mockResolvedValue({
          still_queued: [remaining],
        } as never);
      } else {
        session.query.interrupt.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              release = () => resolve({ still_queued: [remaining] } as never);
            })
        );
      }
      try {
        const cancellation = adapter.cancel({ sessionId });
        await vi.waitFor(() =>
          phase === "withdrawal"
            ? expect(session.query.cancelAsyncMessage).toHaveBeenCalledOnce()
            : expect(session.query.interrupt).toHaveBeenCalledOnce()
        );
        expect(Reflect.get(session, "pendingOrphanResults")).toBe(2);
        messages.push(idle);
        await vi.waitFor(() => expect(active.resolve).toHaveBeenCalled());
        messages.push(result());
        await vi.waitFor(() =>
          expect(Reflect.get(session, "pendingOrphanResults")).toBe(1)
        );
        release();
        await cancellation;
        expect(Reflect.get(session, "pendingOrphanResults")).toBe(1);
        const next = makeTurn("next-echo-less-command");
        session.turnQueue.push(next);
        const readsBefore = session.query.next.mock.calls.length;
        messages.push(result());
        await vi.waitFor(() =>
          expect(session.query.next.mock.calls.length).toBeGreaterThan(
            readsBefore
          )
        );
        expect(Reflect.get(session, "pendingOrphanResults")).toBe(0);
        expect(next.resolve).not.toHaveBeenCalled();
        messages.push(result());
        await vi.waitFor(() =>
          expect(next.resolve).toHaveBeenCalledWith(
            expect.objectContaining({ stopReason: "end_turn" })
          )
        );
        expect(next.reject).not.toHaveBeenCalled();
      } finally {
        await stop();
      }
    }
  );

  it.each(["single", "multiple"])(
    "uses a %s stamped legacy result when an earlier seed was dropped",
    async (stamp) => {
      const { adapter, session, messages, stop } = consumerFixture();
      Object.assign(session, {
        msgLifecycleV1: false,
        pendingOrphanResults: 0,
      });
      const active = makeTurn("legacy-owner");
      const consumed = [
        "consumed-second",
        ...(stamp === "multiple" ? ["consumed-third"] : []),
      ];
      active.steeredEchoes = new Set(["dropped-first", ...consumed]);
      session.activeTurn = active;
      session.turnQueue.push(active);
      let release!: () => void;
      session.query.interrupt.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = () => resolve({ still_queued: consumed } as never);
          })
      );
      try {
        const cancellation = adapter.cancel({ sessionId });
        await vi.waitFor(() =>
          expect(session.query.interrupt).toHaveBeenCalledOnce()
        );
        messages.push(idle);
        await vi.waitFor(() => expect(active.resolve).toHaveBeenCalled());
        messages.push(
          stamp === "single"
            ? result("consumed-second")
            : {
                ...result(),
                user_message_uuids: consumed,
              }
        );
        await vi.waitFor(() =>
          expect(Reflect.get(session, "pendingOrphanResults")).toBe(1)
        );
        release();
        await cancellation;
        expect(Reflect.get(session, "pendingOrphanResults")).toBe(0);
        const next = makeTurn("next-echo-less-command");
        session.turnQueue.push(next);
        messages.push(result());
        await vi.waitFor(() =>
          expect(next.resolve).toHaveBeenCalledWith(
            expect.objectContaining({ stopReason: "end_turn" })
          )
        );
        expect(next.reject).not.toHaveBeenCalled();
      } finally {
        await stop();
      }
    }
  );

  it.each(["immediate", "late"])(
    "reconciles a legacy fallback drop with a %s response before the next echo-less result",
    async (response) => {
      const { adapter, session, messages, stop } = consumerFixture();
      adapter.forceCancelGraceMs = 100;
      Object.assign(session, {
        msgLifecycleV1: false,
        pendingOrphanResults: 0,
      });
      const active = makeTurn("legacy-owner");
      active.steeredEchoes = new Set(["first-steer", "fallback-steer"]);
      session.activeTurn = active;
      session.turnQueue.push(active);
      let releaseFallback!: (value: boolean) => void;
      session.query.cancelAsyncMessage
        .mockImplementationOnce(() => new Promise<boolean>(() => {}))
        .mockImplementationOnce(() =>
          response === "immediate"
            ? Promise.resolve(true)
            : new Promise<boolean>((resolve) => {
                releaseFallback = resolve;
              })
        );
      session.query.interrupt.mockResolvedValue({
        still_queued: ["first-steer"],
      } as never);
      try {
        await adapter.cancel({ sessionId });
        expect(session.query.cancelAsyncMessage.mock.calls).toEqual([
          ["first-steer"],
          ["fallback-steer"],
        ]);
        expect(Reflect.get(session, "pendingOrphanResults")).toBe(1);
        messages.push(idle);
        await vi.waitFor(() => expect(active.resolve).toHaveBeenCalled());
        // Only the first steer survived the interrupt and can produce a result.
        messages.push(result());
        await vi.waitFor(() =>
          expect(Reflect.get(session, "pendingOrphanResults")).toBe(0)
        );
        const next = makeTurn("next-echo-less-command");
        session.turnQueue.push(next);
        messages.push(result());
        await vi.waitFor(() =>
          expect(next.resolve).toHaveBeenCalledWith(
            expect.objectContaining({ stopReason: "end_turn" })
          )
        );
        if (response === "late") {
          // A late control reply must not subtract from a later cancellation's
          // legacy accounting. No asynchronous fallback reconciliation is needed:
          // the interrupt receipt already accounted for this dropped UUID.
          Object.assign(session, { pendingOrphanResults: 1 });
          releaseFallback(true);
          await new Promise((resolve) => setTimeout(resolve, 0));
          expect(Reflect.get(session, "pendingOrphanResults")).toBe(1);
        }
        expect(next.reject).not.toHaveBeenCalled();
      } finally {
        await stop();
      }
    }
  );

  it("settles the owning prompt at the floor when withdrawal never resolves", async () => {
    const { adapter, session, stop } = consumerFixture();
    adapter.forceCancelGraceMs = 40;
    const active = makeTurn("wedged-original");
    active.steeredEchoes = new Set(["queued-steer"]);
    session.activeTurn = active;
    session.turnQueue.push(active);
    session.query.cancelAsyncMessage.mockImplementation(
      () => new Promise<boolean>(() => {})
    );
    try {
      const cancellation = adapter.cancel({ sessionId });
      await vi.waitFor(
        () =>
          expect(active.resolve).toHaveBeenCalledWith(
            expect.objectContaining({ stopReason: "cancelled" })
          ),
        { timeout: 500, interval: 5 }
      );
      expect(session.query.interrupt).toHaveBeenCalledOnce();
      await cancellation;
    } finally {
      await stop();
    }
  });
});
