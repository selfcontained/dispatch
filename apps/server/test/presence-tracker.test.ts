import { PassThrough } from "node:stream";

import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import {
  isActivityRequest,
  PRESENCE_ACTIVITY_WINDOW_MS,
  PRESENCE_TTL_MS,
  PresenceTracker,
} from "../src/presence-tracker.js";
import { createNotificationRuntime } from "../src/server/notification-runtime.js";
import { registerPresenceActivity } from "../src/server/presence-activity.js";
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

/** A visible, focused tab's routine (interval) beat. */
const visible = (viewingAgentId: string | null = null) => ({
  visible: true,
  focused: true,
  viewingAgentId,
});
/** A visible tab in an unfocused window. */
const unfocused = (viewingAgentId: string | null = null) => ({
  ...visible(viewingAgentId),
  focused: false,
});

describe("PresenceTracker", () => {
  it("counts a visible, focused tab as present until its beats stop", () => {
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
  });

  it("counts a visible, unfocused tab with no action in 5 minutes as away", () => {
    const time = clock();
    const presence = new PresenceTracker(time.now);

    // The user opened the tab (an active beat), then moved to another window.
    presence.heartbeat("tab-aaaaaaaa", { ...visible(), active: true });
    presence.heartbeat("tab-aaaaaaaa", unfocused());
    expect(presence.isPresent()).toBe(true);

    // Routine beats keep the session alive but are not activity.
    for (let t = 0; t < PRESENCE_ACTIVITY_WINDOW_MS; t += 15_000) {
      time.advance(15_000);
      presence.heartbeat("tab-aaaaaaaa", unfocused());
    }
    time.advance(1_000);
    presence.heartbeat("tab-aaaaaaaa", unfocused());
    expect(presence.isPresent()).toBe(false);

    // A hidden tab is away even if it is the focused window.
    presence.heartbeat("tab-aaaaaaaa", { ...visible(), visible: false });
    expect(presence.isPresent()).toBe(false);
  });

  it("marks an unfocused session present when the user acts in it", () => {
    const time = clock();
    const presence = new PresenceTracker(time.now);
    presence.heartbeat("tab-aaaaaaaa", unfocused());
    expect(presence.isPresent()).toBe(false);

    presence.noteActivity("tab-aaaaaaaa");
    expect(presence.isPresent()).toBe(true);

    time.advance(PRESENCE_ACTIVITY_WINDOW_MS - 1_000);
    presence.heartbeat("tab-aaaaaaaa", unfocused());
    expect(presence.isPresent()).toBe(true);
    time.advance(2_000);
    expect(presence.isPresent()).toBe(false);

    // Activity for a session the server has never heard from is ignored.
    presence.noteActivity("unknown-aaaa");
    expect(presence.size).toBe(1);
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

    // The phone hides; the laptop stays present.
    presence.heartbeat("phone-aaaaa", { ...visible("agt_b"), visible: false });
    expect(presence.activeSessions().map((s) => s.sessionId)).toEqual([
      "laptop-aaaa",
    ]);

    // A session that stops heartbeating is forgotten on the next heartbeat.
    time.advance(PRESENCE_TTL_MS + 1);
    presence.heartbeat("phone-aaaaa", { ...visible("agt_b"), visible: false });
    expect(presence.size).toBe(1);
  });
});

describe("presence activity requests", () => {
  it("counts chat actions, not reads or read receipts", () => {
    const route = "/api/v1/streams/:rootId/blocks";
    expect(isActivityRequest("POST", route)).toBe(true);
    expect(
      isActivityRequest(
        "POST",
        "/api/v1/streams/:rootId/blocks/:blockId/answer"
      )
    ).toBe(true);
    expect(
      isActivityRequest(
        "POST",
        "/api/v1/streams/:rootId/blocks/:blockId/submit"
      )
    ).toBe(true);
    expect(isActivityRequest("GET", route)).toBe(false);
    expect(isActivityRequest("POST", "/api/v1/streams/:rootId/read")).toBe(
      false
    );
    expect(isActivityRequest("POST", "/api/v1/focus")).toBe(false);
  });

  it("marks the session present when it posts a message", async () => {
    const time = clock();
    const presence = new PresenceTracker(time.now);
    presence.heartbeat("ses_aaaaaaaa", unfocused());
    const app = Fastify();
    registerPresenceActivity(app, presence);
    app.post("/api/v1/streams/:rootId/blocks", async () => ({ ok: true }));
    app.get("/api/v1/streams/:rootId/blocks", async () => ({ ok: true }));

    await app.inject({
      method: "GET",
      url: "/api/v1/streams/agt_a/blocks",
      headers: { "x-dispatch-session": "ses_aaaaaaaa" },
    });
    expect(presence.isPresent()).toBe(false);

    await app.inject({
      method: "POST",
      url: "/api/v1/streams/agt_a/blocks",
      headers: { "x-dispatch-session": "ses_aaaaaaaa" },
      payload: { text: "hi" },
    });
    expect(presence.isPresent()).toBe(true);
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

  it("falls back to the OS notification when no recipient has a live stream", async () => {
    const t = setup();
    t.connect("viewer-aaaa");
    t.presence.heartbeat("viewer-aaaa", visible("agt_a"));
    // Active by heartbeat, but its event stream is down (reconnecting).
    t.presence.heartbeat("gone-aaaaaa", visible(null));

    t.raise();
    await t.flush();
    expect(t.toasts("viewer-aaaa")).toHaveLength(1);

    // Only the stream-less session is active now: nothing can show a toast.
    t.presence.remove("viewer-aaaa");
    t.raise({
      agent: { id: "agt_b", name: "Builder" },
      type: "waiting_user",
      message: "Another?",
      target: { streamId: "agt_b", threadId: null, blockId: "blk_2" },
    });
    await t.flush();
    expect(t.shouldWebNotify).toHaveBeenCalledTimes(1);
    expect(
      (t.received.get("viewer-aaaa") ?? []).filter(
        (e) => e.type === "notification"
      )
    ).toHaveLength(1);
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
