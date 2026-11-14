import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createNotificationRuntime } from "../src/server/notification-runtime.js";

function makeDeps(overrides: Record<string, unknown> = {}) {
  let attentionCb: ((payload: Record<string, unknown>) => void) | null = null;
  return {
    agentManager: {
      onAttention: vi.fn((cb: (payload: Record<string, unknown>) => void) => {
        attentionCb = cb;
      }),
      ...((overrides.agentManager as Record<string, unknown>) ?? {}),
    },
    slackNotifier: {
      shouldWebNotify: vi.fn().mockResolvedValue(null),
      ...((overrides.slackNotifier as Record<string, unknown>) ?? {}),
    },
    uiEventBroker: {
      publish: vi.fn(),
      hasConnectedClient: vi.fn().mockReturnValue(false),
      ...((overrides.uiEventBroker as Record<string, unknown>) ?? {}),
    },
    appLog: {
      debug: vi.fn(),
      warn: vi.fn(),
    },
    webNotifyAckTimeoutMs: 5000,
    autoArchiveJobAgent: vi.fn().mockResolvedValue(undefined),
    get _attentionCb() {
      return attentionCb;
    },
  };
}

describe("createNotificationRuntime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("registers an onAttention callback", () => {
    const deps = makeDeps();
    createNotificationRuntime(deps as never);
    expect(deps.agentManager.onAttention).toHaveBeenCalledWith(
      expect.any(Function)
    );
  });

  describe("onAttention handler", () => {
    it("publishes nothing when no web client is connected", async () => {
      const deps = makeDeps();
      createNotificationRuntime(deps as never);

      const agent = { id: "agt_1", name: "my-agent" };
      deps._attentionCb!({
        agent,
        type: "waiting_user",
        message: "Needs input",
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(deps.slackNotifier.shouldWebNotify).toHaveBeenCalledWith(agent, {
        type: "waiting_user",
        message: "Needs input",
      });
      expect(deps.uiEventBroker.publish).not.toHaveBeenCalled();
    });

    it("publishes nothing when shouldWebNotify returns null", async () => {
      const deps = makeDeps({
        uiEventBroker: {
          publish: vi.fn(),
          hasConnectedClient: vi.fn().mockReturnValue(true),
        },
      });
      createNotificationRuntime(deps as never);

      const agent = { id: "agt_1", name: "my-agent" };
      deps._attentionCb!({
        agent,
        type: "waiting_user",
        message: "Needs input",
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(deps.uiEventBroker.publish).not.toHaveBeenCalled();
    });

    it("publishes web notification when client is connected and shouldWebNotify returns payload", async () => {
      const webPayload = { title: "Test", body: "Hello" };
      const deps = makeDeps({
        slackNotifier: {
          shouldWebNotify: vi.fn().mockResolvedValue(webPayload),
        },
        uiEventBroker: {
          publish: vi.fn(),
          hasConnectedClient: vi.fn().mockReturnValue(true),
        },
      });
      createNotificationRuntime(deps as never);

      const agent = { id: "agt_1", name: "my-agent" };
      deps._attentionCb!({
        agent,
        type: "waiting_user",
        message: "Needs input",
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(deps.uiEventBroker.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "notification",
          notificationId: expect.any(String),
          title: "Test",
          body: "Hello",
        })
      );
    });

    it("expires an unacked web notification without sending to Slack", async () => {
      const webPayload = { title: "Test", body: "Hello" };
      const deps = makeDeps({
        slackNotifier: {
          shouldWebNotify: vi.fn().mockResolvedValue(webPayload),
        },
        uiEventBroker: {
          publish: vi.fn(),
          hasConnectedClient: vi.fn().mockReturnValue(true),
        },
      });
      createNotificationRuntime(deps as never);

      const agent = { id: "agt_1", name: "my-agent" };
      deps._attentionCb!({
        agent,
        type: "waiting_user",
        message: "Needs input",
      });
      await vi.advanceTimersByTimeAsync(0);

      await vi.advanceTimersByTimeAsync(5000);

      expect(deps.uiEventBroker.publish).toHaveBeenCalledTimes(1);
      expect(deps.appLog.debug).toHaveBeenCalledWith(
        expect.objectContaining({ notificationId: expect.any(String) }),
        expect.stringContaining("not acked")
      );
    });

    it("catches and logs errors without rethrowing", async () => {
      const deps = makeDeps({
        slackNotifier: {
          shouldWebNotify: vi
            .fn()
            .mockRejectedValue(new Error("network error")),
        },
      });
      createNotificationRuntime(deps as never);

      const agent = { id: "agt_1", name: "my-agent" };
      deps._attentionCb!({
        agent,
        type: "waiting_user",
        message: "Needs input",
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(deps.appLog.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          err: expect.any(Error),
          agentId: "agt_1",
        }),
        "Agent notification failed"
      );
    });
  });

  describe("ackWebNotification", () => {
    it("returns true and clears timer for a pending notification", async () => {
      const webPayload = { title: "Test", body: "Hello" };
      const deps = makeDeps({
        slackNotifier: {
          shouldWebNotify: vi.fn().mockResolvedValue(webPayload),
        },
        uiEventBroker: {
          publish: vi.fn(),
          hasConnectedClient: vi.fn().mockReturnValue(true),
        },
      });
      const rt = createNotificationRuntime(deps as never);

      const agent = { id: "agt_1", name: "my-agent" };
      deps._attentionCb!({
        agent,
        type: "waiting_user",
        message: "Needs input",
      });
      await vi.advanceTimersByTimeAsync(0);

      const publishCall = (
        deps.uiEventBroker.publish as ReturnType<typeof vi.fn>
      ).mock.calls[0][0];
      const notificationId = publishCall.notificationId;

      const result = rt.ackWebNotification(notificationId);
      expect(result).toBe(true);

      // After timeout, Slack should NOT be called since we acked
      await vi.advanceTimersByTimeAsync(5000);
    });

    it("returns false for unknown notification id", () => {
      const deps = makeDeps();
      const rt = createNotificationRuntime(deps as never);
      expect(rt.ackWebNotification("unknown-id")).toBe(false);
    });
  });

  describe("publishJobChanged", () => {
    it("publishes a job.changed event", () => {
      const deps = makeDeps();
      const rt = createNotificationRuntime(deps as never);
      rt.publishJobChanged();
      expect(deps.uiEventBroker.publish).toHaveBeenCalledWith({
        type: "job.changed",
      });
    });
  });

  describe("maybeAutoArchiveJobRun", () => {
    it("archives when status is terminal, agentId present, and autoArchive defaults true", async () => {
      const deps = makeDeps();
      const rt = createNotificationRuntime(deps as never);
      const terminalStatuses = new Set(["completed", "failed"]);

      await rt.maybeAutoArchiveJobRun(
        { status: "completed", agentId: "agt_1", config: {} },
        terminalStatuses
      );

      expect(deps.autoArchiveJobAgent).toHaveBeenCalledWith("agt_1");
    });

    it("archives when config is null (autoArchive defaults true)", async () => {
      const deps = makeDeps();
      const rt = createNotificationRuntime(deps as never);
      const terminalStatuses = new Set(["completed", "failed"]);

      await rt.maybeAutoArchiveJobRun(
        { status: "failed", agentId: "agt_2", config: null },
        terminalStatuses
      );

      expect(deps.autoArchiveJobAgent).toHaveBeenCalledWith("agt_2");
    });

    it("does not archive when autoArchive is false", async () => {
      const deps = makeDeps();
      const rt = createNotificationRuntime(deps as never);
      const terminalStatuses = new Set(["completed", "failed"]);

      await rt.maybeAutoArchiveJobRun(
        {
          status: "completed",
          agentId: "agt_1",
          config: { autoArchive: false },
        },
        terminalStatuses
      );

      expect(deps.autoArchiveJobAgent).not.toHaveBeenCalled();
    });

    it("does not archive when status is not terminal", async () => {
      const deps = makeDeps();
      const rt = createNotificationRuntime(deps as never);
      const terminalStatuses = new Set(["completed", "failed"]);

      await rt.maybeAutoArchiveJobRun(
        { status: "running", agentId: "agt_1", config: {} },
        terminalStatuses
      );

      expect(deps.autoArchiveJobAgent).not.toHaveBeenCalled();
    });

    it("does not archive when agentId is null", async () => {
      const deps = makeDeps();
      const rt = createNotificationRuntime(deps as never);
      const terminalStatuses = new Set(["completed", "failed"]);

      await rt.maybeAutoArchiveJobRun(
        { status: "completed", agentId: null, config: {} },
        terminalStatuses
      );

      expect(deps.autoArchiveJobAgent).not.toHaveBeenCalled();
    });
  });

  describe("clearPendingWebNotifications", () => {
    it("clears all pending timers", async () => {
      const webPayload = { title: "Test", body: "Hello" };
      const deps = makeDeps({
        slackNotifier: {
          shouldWebNotify: vi.fn().mockResolvedValue(webPayload),
        },
        uiEventBroker: {
          publish: vi.fn(),
          hasConnectedClient: vi.fn().mockReturnValue(true),
        },
      });
      const rt = createNotificationRuntime(deps as never);

      // Trigger two notifications
      deps._attentionCb!({
        agent: { id: "agt_1", name: "agent-1" },
        type: "waiting_user",
        message: "Needs input",
      });
      deps._attentionCb!({
        agent: { id: "agt_2", name: "agent-2" },
        type: "blocked",
        message: "Failed",
      });
      await vi.advanceTimersByTimeAsync(0);

      rt.clearPendingWebNotifications();

      // After timeout, Slack should NOT be called since we cleared everything
      await vi.advanceTimersByTimeAsync(5000);
    });
  });
});
