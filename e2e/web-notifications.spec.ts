import { test, expect } from "@playwright/test";
import http from "http";
import { callMcpToolViaAPI, createAgentViaAPI } from "./helpers";

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
      }
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
  timeoutMs = 5000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (events.filter(predicate).length >= count) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  const matched = events.filter(predicate).length;
  throw new Error(
    `Timed out waiting for ${count} matching events (got ${matched} in ${timeoutMs}ms).`
  );
}

async function settings(
  request: import("@playwright/test").APIRequestContext,
  enabled: boolean,
  events = ["waiting_user", "blocked"]
) {
  const res = await request.post("/api/v1/notifications/settings", {
    headers: authHeader,
    data: { webNotifyEnabled: enabled, webNotifyEvents: events },
  });
  expect(res.ok()).toBe(true);
  return res.json();
}

async function postQuestion(
  request: import("@playwright/test").APIRequestContext,
  agentId: string
) {
  await expect
    .poll(async () => {
      const res = await request.get(`/api/v1/agents/${agentId}`, {
        headers: authHeader,
      });
      const body = (await res.json()) as { agent: { status: string } };
      return body.agent.status;
    })
    .toBe("running");
  await callMcpToolViaAPI(request, agentId, "post", {
    text: "Which option should I use?",
    question: { options: [{ label: "First" }, { label: "Second" }] },
  });
}

test.describe("Web notifications from stream actions", () => {
  test.afterEach(async ({ request }) => {
    await settings(request, false);
    await request.post("/api/v1/focus", {
      headers: authHeader,
      data: { agentId: null },
    });
  });

  test("settings accept real attention events and discard old done status", async ({
    request,
  }) => {
    const data = await settings(request, true, ["done", "waiting_user"]);
    expect(data.webNotifyEvents).toEqual(["waiting_user"]);
  });

  test("an agent question sends a browser notification with an ack ID", async ({
    request,
  }) => {
    await settings(request, true, ["waiting_user"]);
    const sse = openSSEStream(SSE_BASE_URL);
    await sse.ready;
    try {
      const agent = await createAgentViaAPI(request);
      await postQuestion(request, agent.id);
      await waitForEvents(
        sse.events,
        (e) => e.type === "notification" && e.agentId === agent.id,
        1
      );
      const notification = sse.events.find(
        (e) => e.type === "notification" && e.agentId === agent.id
      )!;
      expect(notification.agentId).toBe(agent.id);
      expect(notification.eventType).toBe("waiting_user");
      expect(notification.message).toBe("Which option should I use?");
      expect(typeof notification.notificationId).toBe("string");
      const ack = await request.post("/api/v1/notifications/ack", {
        headers: authHeader,
        data: { notificationId: notification.notificationId },
      });
      expect(ack.status()).toBe(204);
    } finally {
      sse.close();
    }
  });

  test("an explicit notify post sends a browser notice", async ({
    request,
  }) => {
    await settings(request, true);
    const sse = openSSEStream(SSE_BASE_URL);
    await sse.ready;
    try {
      const agent = await createAgentViaAPI(request);
      await callMcpToolViaAPI(request, agent.id, "post", {
        text: "Please review the result",
        notify: true,
      });
      await waitForEvents(
        sse.events,
        (e) => e.type === "notification" && e.agentId === agent.id,
        1
      );
      expect(
        sse.events.find(
          (e) => e.type === "notification" && e.agentId === agent.id
        )
      ).toMatchObject({
        agentId: agent.id,
        eventType: "notice",
        message: "Please review the result",
      });
    } finally {
      sse.close();
    }
  });

  test("a focused agent's question does not send a browser notification", async ({
    request,
  }) => {
    await settings(request, true, ["waiting_user"]);
    const sse = openSSEStream(SSE_BASE_URL);
    await sse.ready;
    try {
      const agent = await createAgentViaAPI(request);
      await request.post("/api/v1/focus", {
        headers: authHeader,
        data: { agentId: agent.id },
      });
      await postQuestion(request, agent.id);
      await waitForEvents(
        sse.events,
        (e) => e.type === "stream.entry" && e.agentId === agent.id,
        1
      );
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(
        sse.events.filter(
          (e) => e.type === "notification" && e.agentId === agent.id
        )
      ).toHaveLength(0);
    } finally {
      sse.close();
    }
  });
});
