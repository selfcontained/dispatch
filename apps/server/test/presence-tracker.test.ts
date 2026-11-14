import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  PRESENCE_ACTIVE_WINDOW_MS,
  PRESENCE_TTL_MS,
  PresenceTracker,
} from "../src/presence-tracker.js";
import { createNotificationRuntime } from "../src/server/notification-runtime.js";
import { UiEventBroker } from "../src/server/ui-events.js";

function clock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const visible = (viewingAgentId: string | null = null, idleMs = 0) => ({
  visible: true,
  idleMs,
  viewingAgentId,
});

describe("PresenceTracker", () => {
  it("turns active on a heartbeat and expires after the TTL", () => {
    const time = clock();
    const presence = new PresenceTracker(time.now);
    expect(presence.isPresent()).toBe(false);

    presence.heartbeat("tab-aaaaaaaa", visible());
    expect(presence.isPresent()).toBe(true);
    expect(presence.activeSessions().map((s) => s.sessionId)).toEqual([
      "tab-aaaaaaaa",
    ]);

    time.advance(PRESENCE_TTL_MS + 1);
    expect(presence.isPresent()).toBe(false);
    expect(presence.activeSessions()).toEqual([]);
  });

  it("counts only visible sessions with a recent interaction", () => {
    const time = clock();
    const presence = new PresenceTracker(time.now);

    presence.heartbeat("hidden-aaaa", { ...visible(), visible: false });
    presence.heartbeat(
      "idle-aaaaaa",
      visible(null, PRESENCE_ACTIVE_WINDOW_MS + 1)
    );
    expect(presence.isPresent()).toBe(false);

    // Heartbeats keep an idle session alive, but idle time keeps growing.
    presence.heartbeat("busy-aaaaaa", visible(null, 0));
    time.advance(PRESENCE_ACTIVE_WINDOW_MS - 1_000);
    presence.heartbeat("busy-aaaaaa", visible(null, PRESENCE_ACTIVE_WINDOW_MS));
    expect(presence.isPresent()).toBe(true);
    time.advance(1_001);
    expect(presence.isPresent()).toBe(false);
  });

  it("tracks two sessions on different devices separately", () => {
    const time = clock();
    const presence = new PresenceTracker(time.now);

    presence.heartbeat("laptop-aaaa", visible("agt_a"));
    presence.heartbeat("phone-aaaaa", visible("agt_b"));
    expect(
      presence
        .activeSessions()
        .map((s) => [s.sessionId, s.viewingAgentId])
        .sort()
    ).toEqual([
      ["laptop-aaaa", "agt_a"],
      ["phone-aaaaa", "agt_b"],
    ]);

    // The phone hides; the laptop stays active.
    presence.heartbeat("phone-aaaaa", { ...visible("agt_b"), visible: false });
    expect(presence.activeSessions().map((s) => s.sessionId)).toEqual([
      "laptop-aaaa",
    ]);

    presence.remove("laptop-aaaa");
    expect(presence.isPresent()).toBe(false);
  });
});

describe("attention toasts", () => {
  function setup() {
    const time = clock();
    const presence = new PresenceTracker(time.now);
    const broker = new UiEventBroker();
    const received = new Map<string, Array<Record<string, unknown>>>();
    const connect = (sessionId: string) => {
      const stream = new PassThrough();
      const events: Array<Record<string, unknown>> = [];
      received.set(sessionId, events);
      stream.on("data", (chunk: Buffer) => {
        for (const line of chunk.toString().split("\n")) {
          if (line.startsWith("data: ")) events.push(JSON.parse(line.slice(6)));
        }
      });
      broker.subscribe(stream, sessionId);
    };
    let attention: ((event: Record<string, unknown>) => void) | null = null;
    const shouldWebNotify = vi.fn().mockResolvedValue({
      agentId: "agt_b",
      agentName: "Builder",
      eventType: "waiting_user",
      message: "Ship it?",
    });
    createNotificationRuntime({
      agentManager: {
        onAttention: (cb: (event: Record<string, unknown>) => void) => {
          attention = cb;
        },
      },
      slackNotifier: { shouldWebNotify },
      presence,
      uiEventBroker: broker,
      appLog: { debug: vi.fn(), warn: vi.fn() },
      webNotifyAckTimeoutMs: 10,
      autoArchiveJobAgent: vi.fn(),
    } as never);
    const question = {
      agent: { id: "agt_b", name: "Builder" },
      type: "waiting_user",
      message: "Ship it?",
      target: { streamId: "agt_b", threadId: null, blockId: "blk_1" },
    };
    const toasts = (sessionId: string) =>
      (received.get(sessionId) ?? []).filter(
        (e) => e.type === "attention.toast"
      );
    const flush = () => new Promise((resolve) => setImmediate(resolve));
    return {
      presence,
      connect,
      toasts,
      received,
      shouldWebNotify,
      flush,
      raise: (event: Record<string, unknown> = question) => attention!(event),
    };
  }

  it("toasts the active session not viewing the agent exactly once, and not the one viewing it", async () => {
    const t = setup();
    t.connect("viewer-aaaa");
    t.connect("other-aaaaa");
    t.presence.heartbeat("viewer-aaaa", visible("agt_b"));
    t.presence.heartbeat("other-aaaaa", visible("agt_a"));

    t.raise();
    t.raise(); // the same question again: still one toast
    await t.flush();

    expect(t.toasts("viewer-aaaa")).toEqual([]);
    expect(t.toasts("other-aaaaa")).toEqual([
      {
        type: "attention.toast",
        toastId: "block:blk_1",
        agentId: "agt_b",
        agentName: "Builder",
        message: "Ship it?",
        target: { streamId: "agt_b", threadId: null, blockId: "blk_1" },
      },
    ]);
    // Present, so no OS notification anywhere.
    expect(t.shouldWebNotify).not.toHaveBeenCalled();
    expect(
      [...t.received.values()].flat().some((e) => e.type === "notification")
    ).toBe(false);
  });

  it("toasts each separate blocked event without a target", async () => {
    const t = setup();
    t.connect("other-aaaaa");
    t.presence.heartbeat("other-aaaaa", visible(null));

    const blocked = {
      agent: { id: "agt_b", name: "Builder" },
      type: "blocked",
      message: "Turn failed",
    };
    t.raise(blocked);
    await t.flush();
    expect(t.toasts("other-aaaaa")).toHaveLength(1);
    expect(t.toasts("other-aaaaa")[0]).toMatchObject({
      message: "Turn failed",
      target: null,
    });
  });

  it("sends no toast when no session is active, and falls back to the OS notification", async () => {
    const t = setup();
    t.connect("hidden-aaaa");
    t.presence.heartbeat("hidden-aaaa", {
      ...visible("agt_a"),
      visible: false,
    });

    t.raise();
    await t.flush();

    expect(t.toasts("hidden-aaaa")).toEqual([]);
    expect(t.shouldWebNotify).toHaveBeenCalledTimes(1);
    expect(
      (t.received.get("hidden-aaaa") ?? []).filter(
        (e) => e.type === "notification"
      )
    ).toHaveLength(1);
  });
});
