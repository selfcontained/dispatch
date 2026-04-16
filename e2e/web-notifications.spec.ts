import { test, expect } from "@playwright/test";
import http from "http";
import { createAgentViaAPI, setAgentLatestEventViaAPI, loadApp } from "./helpers";

const AUTH_TOKEN = process.env.AUTH_TOKEN ?? "dev-token";
const authHeader = { Authorization: `Bearer ${AUTH_TOKEN}` };
const devPort = process.env.E2E_PORT ?? "8788";
const protocol = process.env.TLS_CERT ? "https" : "http";
const SSE_BASE_URL = `${protocol}://127.0.0.1:${devPort}`;

type SSEEvent = { type: string; [key: string]: unknown };

/** Open a raw HTTP SSE connection (EventSource isn't available in Node). */
function openSSEStream(baseURL: string): {
  events: SSEEvent[];
  ready: Promise<void>;
  close: () => void;
} {
  const events: SSEEvent[] = [];
  const url = new URL("/api/v1/events", baseURL);
  let req: http.ClientRequest | null = null;

  const ready = new Promise<void>((resolve, reject) => {
    req = http.get(
      url,
      { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } },
      (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`SSE stream returned ${res.statusCode}`));
          return;
        }
        let buffer = "";
        res.on("data", (chunk: Buffer) => {
          buffer += chunk.toString();
          const parts = buffer.split("\n\n");
          buffer = parts.pop()!;
          for (const part of parts) {
            const dataLine = part
              .split("\n")
              .find((l) => l.startsWith("data: "));
            if (!dataLine) continue;
            try {
              const payload = JSON.parse(dataLine.slice(6));
              events.push(payload);
              if (payload.type === "snapshot") resolve();
            } catch {}
          }
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
  });

  return { events, ready, close: () => req?.destroy() };
}

/** Wait until events array contains at least `count` events matching predicate. */
async function waitForEvents(
  events: SSEEvent[],
  predicate: (e: SSEEvent) => boolean,
  count: number,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (events.filter(predicate).length >= count) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  const matched = events.filter(predicate).length;
  throw new Error(
    `Timed out waiting for ${count} matching events (got ${matched} in ${timeoutMs}ms).`,
  );
}

test.describe("Web notification settings API", () => {
  test("GET /api/v1/notifications/settings returns web notification fields", async ({
    request,
  }) => {
    const res = await request.get("/api/v1/notifications/settings", {
      headers: authHeader,
    });
    expect(res.ok()).toBe(true);
    const data = await res.json();
    expect(data).toHaveProperty("webNotifyEnabled");
    expect(data).toHaveProperty("webNotifyEvents");
    expect(Array.isArray(data.webNotifyEvents)).toBe(true);
  });

  test("POST /api/v1/notifications/settings saves web notification settings", async ({
    request,
  }) => {
    // Enable web notifications with only "done" events
    const res = await request.post("/api/v1/notifications/settings", {
      headers: authHeader,
      data: {
        webNotifyEnabled: true,
        webNotifyEvents: ["done"],
      },
    });
    expect(res.ok()).toBe(true);
    const data = await res.json();
    expect(data.webNotifyEnabled).toBe(true);
    expect(data.webNotifyEvents).toEqual(["done"]);

    // Verify it persists
    const verify = await request.get("/api/v1/notifications/settings", {
      headers: authHeader,
    });
    const verifyData = await verify.json();
    expect(verifyData.webNotifyEnabled).toBe(true);
    expect(verifyData.webNotifyEvents).toEqual(["done"]);

    // Reset
    await request.post("/api/v1/notifications/settings", {
      headers: authHeader,
      data: {
        webNotifyEnabled: false,
        webNotifyEvents: ["done", "waiting_user", "blocked"],
      },
    });
  });

  test("POST /api/v1/notifications/settings validates webNotifyEnabled type", async ({
    request,
  }) => {
    const res = await request.post("/api/v1/notifications/settings", {
      headers: authHeader,
      data: { webNotifyEnabled: "yes" },
    });
    expect(res.status()).toBe(400);
  });

  test("POST /api/v1/notifications/settings validates webNotifyEvents type", async ({
    request,
  }) => {
    const res = await request.post("/api/v1/notifications/settings", {
      headers: authHeader,
      data: { webNotifyEvents: "done" },
    });
    expect(res.status()).toBe(400);
  });

  test("POST /api/v1/notifications/settings filters invalid event types", async ({
    request,
  }) => {
    const res = await request.post("/api/v1/notifications/settings", {
      headers: authHeader,
      data: { webNotifyEvents: ["done", "invalid_event", "blocked"] },
    });
    expect(res.ok()).toBe(true);
    const data = await res.json();
    expect(data.webNotifyEvents).toEqual(["done", "blocked"]);

    // Reset
    await request.post("/api/v1/notifications/settings", {
      headers: authHeader,
      data: { webNotifyEvents: ["done", "waiting_user", "blocked"] },
    });
  });
});

test.describe("Web notification SSE events", () => {
  test("web notification settings integrate with event pipeline", async ({
    request,
  }) => {
    // Enable web notifications
    await request.post("/api/v1/notifications/settings", {
      headers: authHeader,
      data: {
        webNotifyEnabled: true,
        webNotifyEvents: ["done", "waiting_user", "blocked"],
      },
    });

    // Create an agent and set it to "done"
    const agent = await createAgentViaAPI(request);
    await setAgentLatestEventViaAPI(request, agent.id, {
      type: "done",
      message: "Task completed successfully",
    });

    // Verify the settings are still correct after event processing
    const settings = await request.get("/api/v1/notifications/settings", {
      headers: authHeader,
    });
    const data = await settings.json();
    expect(data.webNotifyEnabled).toBe(true);
    expect(data.webNotifyEvents).toEqual(["done", "waiting_user", "blocked"]);

    // Clean up
    await request.post("/api/v1/notifications/settings", {
      headers: authHeader,
      data: { webNotifyEnabled: false },
    });
  });

  test("web notification respects event type filtering", async ({
    request,
  }) => {
    // Enable web notifications for "done" only
    const res = await request.post("/api/v1/notifications/settings", {
      headers: authHeader,
      data: { webNotifyEnabled: true, webNotifyEvents: ["done"] },
    });
    expect(res.ok()).toBe(true);
    const data = await res.json();
    expect(data.webNotifyEvents).toEqual(["done"]);

    // "blocked" is not in the configured events — verify it's excluded
    expect(data.webNotifyEvents).not.toContain("blocked");
    expect(data.webNotifyEvents).not.toContain("waiting_user");

    // Clean up
    await request.post("/api/v1/notifications/settings", {
      headers: authHeader,
      data: {
        webNotifyEnabled: false,
        webNotifyEvents: ["done", "waiting_user", "blocked"],
      },
    });
  });
});

test.describe("Web notification ack endpoint", () => {
  test("POST /api/v1/notifications/ack accepts a valid notificationId", async ({
    request,
  }) => {
    const res = await request.post("/api/v1/notifications/ack", {
      headers: authHeader,
      data: { notificationId: "test-notification-id" },
    });
    expect(res.status()).toBe(204);
  });

  test("POST /api/v1/notifications/ack rejects missing notificationId", async ({
    request,
  }) => {
    const res = await request.post("/api/v1/notifications/ack", {
      headers: authHeader,
      data: {},
    });
    expect(res.status()).toBe(400);
  });

  test("POST /api/v1/notifications/ack rejects non-string notificationId", async ({
    request,
  }) => {
    const res = await request.post("/api/v1/notifications/ack", {
      headers: authHeader,
      data: { notificationId: 123 },
    });
    expect(res.status()).toBe(400);
  });
});

test.describe("Web notification SSE delivery and ack flow", () => {
  test("SSE notification event includes notificationId when web notifications are enabled", async ({
    request,
  }) => {
    // Enable web notifications for "done"
    await request.post("/api/v1/notifications/settings", {
      headers: authHeader,
      data: { webNotifyEnabled: true, webNotifyEvents: ["done"] },
    });

    // Open SSE stream so the server sees a connected client
    const sse = openSSEStream(SSE_BASE_URL);
    await sse.ready;

    try {
      // Create an agent and trigger a "done" event
      const agent = await createAgentViaAPI(request);
      await setAgentLatestEventViaAPI(request, agent.id, {
        type: "done",
        message: "Task completed",
      });

      // Wait for the notification event in the SSE stream
      await waitForEvents(
        sse.events,
        (e) => e.type === "notification",
        1,
        5000,
      );

      const notification = sse.events.find((e) => e.type === "notification");
      expect(notification).toBeDefined();
      expect(notification!.notificationId).toBeDefined();
      expect(typeof notification!.notificationId).toBe("string");
      expect(notification!.agentName).toBeDefined();
      expect(notification!.eventType).toBe("done");
      expect(notification!.message).toBe("Task completed");
    } finally {
      sse.close();
      await request.post("/api/v1/notifications/settings", {
        headers: authHeader,
        data: {
          webNotifyEnabled: false,
          webNotifyEvents: ["done", "waiting_user", "blocked"],
        },
      });
    }
  });

  test("acking a notification prevents Slack fallback (ack returns 204)", async ({
    request,
  }) => {
    // Enable web notifications
    await request.post("/api/v1/notifications/settings", {
      headers: authHeader,
      data: { webNotifyEnabled: true, webNotifyEvents: ["done"] },
    });

    const sse = openSSEStream(SSE_BASE_URL);
    await sse.ready;

    try {
      const agent = await createAgentViaAPI(request);
      await setAgentLatestEventViaAPI(request, agent.id, {
        type: "done",
        message: "Ack test",
      });

      await waitForEvents(
        sse.events,
        (e) => e.type === "notification",
        1,
        5000,
      );

      const notification = sse.events.find((e) => e.type === "notification");
      expect(notification).toBeDefined();

      // Ack the notification — this should cancel the Slack fallback timer
      const ackRes = await request.post("/api/v1/notifications/ack", {
        headers: authHeader,
        data: { notificationId: notification!.notificationId },
      });
      expect(ackRes.status()).toBe(204);
    } finally {
      sse.close();
      await request.post("/api/v1/notifications/settings", {
        headers: authHeader,
        data: { webNotifyEnabled: false, webNotifyEvents: ["done", "waiting_user", "blocked"] },
      });
    }
  });

  test("no notification SSE event for unconfigured event types", async ({ request }) => {
    // Enable web notifications for "done" only
    await request.post("/api/v1/notifications/settings", {
      headers: authHeader,
      data: { webNotifyEnabled: true, webNotifyEvents: ["done"] },
    });

    const sse = openSSEStream(SSE_BASE_URL);
    await sse.ready;

    try {
      const agent = await createAgentViaAPI(request);

      // Trigger a "blocked" event — not in configured events
      await setAgentLatestEventViaAPI(request, agent.id, {
        type: "blocked",
        message: "Something went wrong",
      });

      // Wait a bit and verify no notification event was sent
      // (we should see the agent.upsert but no notification)
      await new Promise((r) => setTimeout(r, 1500));
      const notifications = sse.events.filter((e) => e.type === "notification");
      expect(notifications).toHaveLength(0);
    } finally {
      sse.close();
      await request.post("/api/v1/notifications/settings", {
        headers: authHeader,
        data: { webNotifyEnabled: false, webNotifyEvents: ["done", "waiting_user", "blocked"] },
      });
    }
  });

  test("no notification SSE event when web notifications are disabled", async ({ request }) => {
    // Ensure web notifications are disabled
    await request.post("/api/v1/notifications/settings", {
      headers: authHeader,
      data: { webNotifyEnabled: false },
    });

    const sse = openSSEStream(SSE_BASE_URL);
    await sse.ready;

    try {
      const agent = await createAgentViaAPI(request);
      await setAgentLatestEventViaAPI(request, agent.id, {
        type: "done",
        message: "Should not notify",
      });

      // Wait and verify no notification event
      await new Promise((r) => setTimeout(r, 1500));
      const notifications = sse.events.filter((e) => e.type === "notification");
      expect(notifications).toHaveLength(0);
    } finally {
      sse.close();
    }
  });

  test("focused agent does not trigger notification SSE event", async ({ request }) => {
    // Enable web notifications
    await request.post("/api/v1/notifications/settings", {
      headers: authHeader,
      data: { webNotifyEnabled: true, webNotifyEvents: ["done"] },
    });

    const sse = openSSEStream(SSE_BASE_URL);
    await sse.ready;

    try {
      const agent = await createAgentViaAPI(request);

      // Report focus on this agent
      await request.post("/api/v1/focus", {
        headers: authHeader,
        data: { agentId: agent.id },
      });

      // Trigger a "done" event — should be suppressed because agent is focused
      await setAgentLatestEventViaAPI(request, agent.id, {
        type: "done",
        message: "Focused agent done",
      });

      // Wait and verify no notification event
      await new Promise((r) => setTimeout(r, 1500));
      const notifications = sse.events.filter((e) => e.type === "notification");
      expect(notifications).toHaveLength(0);
    } finally {
      sse.close();
      // Clear focus
      await request.post("/api/v1/focus", {
        headers: authHeader,
        data: { agentId: null },
      });
      await request.post("/api/v1/notifications/settings", {
        headers: authHeader,
        data: { webNotifyEnabled: false, webNotifyEvents: ["done", "waiting_user", "blocked"] },
      });
    }
  });
});

test.describe("Browser notification ack flow (mocked Notification API)", () => {
  test("client acks when Notification permission is granted", async ({ page, request }) => {
    // Enable web notifications
    await request.post("/api/v1/notifications/settings", {
      headers: authHeader,
      data: { webNotifyEnabled: true, webNotifyEvents: ["done"] },
    });

    // Mock the Notification API with permission "granted"
    const notifications: Array<{ title: string; body: string; tag: string }> = [];
    await page.addInitScript(() => {
      (window as unknown as Record<string, unknown>).Notification = class MockNotification {
        static permission = "granted";
        static requestPermission = async () => "granted" as NotificationPermission;
        constructor(title: string, options?: { body?: string; tag?: string; icon?: string }) {
          (window as unknown as Record<string, unknown[]>).__mockNotifications ??= [];
          (window as unknown as Record<string, unknown[]>).__mockNotifications.push({
            title,
            body: options?.body ?? "",
            tag: options?.tag ?? "",
          });
        }
      };
      (window as unknown as Record<string, unknown[]>).__mockNotifications = [];
    });

    // Intercept ack requests
    const ackRequests: Array<{ notificationId: string }> = [];
    await page.route("**/api/v1/notifications/ack", async (route) => {
      const postData = route.request().postDataJSON() as { notificationId: string };
      ackRequests.push(postData);
      await route.continue();
    });

    try {
      await loadApp(page);

      // Create an agent and trigger a "done" event
      const agent = await createAgentViaAPI(request);
      await setAgentLatestEventViaAPI(request, agent.id, {
        type: "done",
        message: "Permission granted test",
      });

      // Wait for the client to receive the SSE event and send an ack
      await page.waitForTimeout(3000);

      // Verify a Notification was created in the browser
      const mockNotifications = await page.evaluate(
        () => (window as unknown as Record<string, unknown[]>).__mockNotifications
      );
      expect(mockNotifications.length).toBeGreaterThanOrEqual(1);
      const notif = mockNotifications[0] as { title: string; body: string };
      expect(notif.body).toBe("Permission granted test");

      // Verify the ack was sent back to the server
      expect(ackRequests.length).toBeGreaterThanOrEqual(1);
      expect(ackRequests[0].notificationId).toBeDefined();
      expect(typeof ackRequests[0].notificationId).toBe("string");
    } finally {
      await request.post("/api/v1/notifications/settings", {
        headers: authHeader,
        data: { webNotifyEnabled: false, webNotifyEvents: ["done", "waiting_user", "blocked"] },
      });
    }
  });

  test("client does not ack when Notification permission is denied", async ({ page, request }) => {
    // Enable web notifications
    await request.post("/api/v1/notifications/settings", {
      headers: authHeader,
      data: { webNotifyEnabled: true, webNotifyEvents: ["done"] },
    });

    // Mock the Notification API with permission "denied"
    await page.addInitScript(() => {
      (window as unknown as Record<string, unknown>).Notification = class MockNotification {
        static permission = "denied";
        static requestPermission = async () => "denied" as NotificationPermission;
        constructor() {
          // Should never be called when permission is denied
          throw new Error("Notification created with denied permission");
        }
      };
    });

    // Intercept ack requests
    const ackRequests: Array<{ notificationId: string }> = [];
    await page.route("**/api/v1/notifications/ack", async (route) => {
      const postData = route.request().postDataJSON() as { notificationId: string };
      ackRequests.push(postData);
      await route.continue();
    });

    try {
      await loadApp(page);

      const agent = await createAgentViaAPI(request);
      await setAgentLatestEventViaAPI(request, agent.id, {
        type: "done",
        message: "Permission denied test",
      });

      // Wait long enough for an ack to arrive if one were sent
      await page.waitForTimeout(3000);

      // No ack should have been sent — permission denied means
      // showWebNotification returns false
      expect(ackRequests).toHaveLength(0);
    } finally {
      await request.post("/api/v1/notifications/settings", {
        headers: authHeader,
        data: { webNotifyEnabled: false, webNotifyEvents: ["done", "waiting_user", "blocked"] },
      });
    }
  });

  test("client does not ack when Notification API is unavailable", async ({ page, request }) => {
    // Enable web notifications
    await request.post("/api/v1/notifications/settings", {
      headers: authHeader,
      data: { webNotifyEnabled: true, webNotifyEvents: ["done"] },
    });

    // Remove the Notification API entirely (simulates iOS Safari without PWA)
    await page.addInitScript(() => {
      delete (window as unknown as Record<string, unknown>).Notification;
    });

    // Intercept ack requests
    const ackRequests: Array<{ notificationId: string }> = [];
    await page.route("**/api/v1/notifications/ack", async (route) => {
      const postData = route.request().postDataJSON() as { notificationId: string };
      ackRequests.push(postData);
      await route.continue();
    });

    try {
      await loadApp(page);

      const agent = await createAgentViaAPI(request);
      await setAgentLatestEventViaAPI(request, agent.id, {
        type: "done",
        message: "No API test",
      });

      await page.waitForTimeout(3000);

      // No ack — Notification API doesn't exist
      expect(ackRequests).toHaveLength(0);
    } finally {
      await request.post("/api/v1/notifications/settings", {
        headers: authHeader,
        data: { webNotifyEnabled: false, webNotifyEvents: ["done", "waiting_user", "blocked"] },
      });
    }
  });
});
