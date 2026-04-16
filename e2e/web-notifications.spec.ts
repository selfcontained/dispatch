import { test, expect } from "@playwright/test";
import { createAgentViaAPI, setAgentLatestEventViaAPI } from "./helpers";

const authHeader = { Authorization: `Bearer ${process.env.AUTH_TOKEN ?? "dev-token"}` };

test.describe("Web notification settings API", () => {
  test("GET /api/v1/notifications/settings returns web notification fields", async ({ request }) => {
    const res = await request.get("/api/v1/notifications/settings", {
      headers: authHeader,
    });
    expect(res.ok()).toBe(true);
    const data = await res.json();
    expect(data).toHaveProperty("webNotifyEnabled");
    expect(data).toHaveProperty("webNotifyEvents");
    expect(Array.isArray(data.webNotifyEvents)).toBe(true);
  });

  test("POST /api/v1/notifications/settings saves web notification settings", async ({ request }) => {
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
      data: { webNotifyEnabled: false, webNotifyEvents: ["done", "waiting_user", "blocked"] },
    });
  });

  test("POST /api/v1/notifications/settings validates webNotifyEnabled type", async ({ request }) => {
    const res = await request.post("/api/v1/notifications/settings", {
      headers: authHeader,
      data: { webNotifyEnabled: "yes" },
    });
    expect(res.status()).toBe(400);
  });

  test("POST /api/v1/notifications/settings validates webNotifyEvents type", async ({ request }) => {
    const res = await request.post("/api/v1/notifications/settings", {
      headers: authHeader,
      data: { webNotifyEvents: "done" },
    });
    expect(res.status()).toBe(400);
  });

  test("POST /api/v1/notifications/settings filters invalid event types", async ({ request }) => {
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
  test("web notification settings integrate with event pipeline", async ({ request }) => {
    // Enable web notifications
    await request.post("/api/v1/notifications/settings", {
      headers: authHeader,
      data: { webNotifyEnabled: true, webNotifyEvents: ["done", "waiting_user", "blocked"] },
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

  test("web notification respects event type filtering", async ({ request }) => {
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
      data: { webNotifyEnabled: false, webNotifyEvents: ["done", "waiting_user", "blocked"] },
    });
  });
});

test.describe("Web notification ack endpoint", () => {
  test("POST /api/v1/notifications/ack accepts a valid notificationId", async ({ request }) => {
    const res = await request.post("/api/v1/notifications/ack", {
      headers: authHeader,
      data: { notificationId: "test-notification-id" },
    });
    expect(res.status()).toBe(204);
  });

  test("POST /api/v1/notifications/ack rejects missing notificationId", async ({ request }) => {
    const res = await request.post("/api/v1/notifications/ack", {
      headers: authHeader,
      data: {},
    });
    expect(res.status()).toBe(400);
  });

  test("POST /api/v1/notifications/ack rejects non-string notificationId", async ({ request }) => {
    const res = await request.post("/api/v1/notifications/ack", {
      headers: authHeader,
      data: { notificationId: 123 },
    });
    expect(res.status()).toBe(400);
  });
});
