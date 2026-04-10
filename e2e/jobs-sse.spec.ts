import { test, expect } from "@playwright/test";
import { mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import http from "http";

const AUTH_TOKEN = process.env.AUTH_TOKEN ?? "dev-token";
const AUTH_HEADER = { Authorization: `Bearer ${AUTH_TOKEN}` };
const HEADERS = { ...AUTH_HEADER, "Content-Type": "application/json" };

const devPort = process.env.E2E_PORT ?? "8788";
const protocol = process.env.TLS_CERT ? "https" : "http";
const SSE_BASE_URL = `${protocol}://127.0.0.1:${devPort}`;

/**
 * Collect SSE events from /api/v1/events using raw HTTP (EventSource isn't
 * available in Node). Returns a handle with the collected events and a
 * cleanup function.
 */
function openSSEStream(baseURL: string): {
  events: Array<{ type: string; [key: string]: unknown }>;
  ready: Promise<void>;
  close: () => void;
} {
  const events: Array<{ type: string; [key: string]: unknown }> = [];
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
          // Parse complete SSE messages (double newline delimited)
          const parts = buffer.split("\n\n");
          buffer = parts.pop()!; // keep incomplete tail
          for (const part of parts) {
            const dataLine = part
              .split("\n")
              .find((l) => l.startsWith("data: "));
            if (!dataLine) continue;
            try {
              const payload = JSON.parse(dataLine.slice(6));
              events.push(payload);
              // Resolve ready after receiving snapshot (first event)
              if (payload.type === "snapshot") resolve();
            } catch {}
          }
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
  });

  return {
    events,
    ready,
    close: () => req?.destroy(),
  };
}

/** Wait until events array contains at least `count` events matching predicate. */
async function waitForEvents(
  events: Array<{ type: string }>,
  predicate: (e: { type: string }) => boolean,
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
    `Timed out waiting for ${count} matching events (got ${matched} in ${timeoutMs}ms). All events: ${JSON.stringify(events.map((e) => e.type))}`,
  );
}

test.describe("Jobs SSE events", () => {
  const jobDir = join(tmpdir(), `dispatch-e2e-sse-${Date.now()}`);
  mkdirSync(jobDir, { recursive: true });

  test("job config mutations emit job.changed SSE events", async ({
    request,
  }) => {
    const sse = openSSEStream(SSE_BASE_URL);
    try {
      await sse.ready;
      // Clear snapshot from events count
      const baselineCount = sse.events.filter(
        (e) => e.type === "job.changed",
      ).length;

      // 1. Create a job → expect job.changed
      const createRes = await request.post("/api/v1/jobs", {
        headers: HEADERS,
        data: {
          name: "SSE Test Job",
          directory: jobDir,
          prompt: "SSE test prompt.",
          schedule: "0 * * * *",
          timeoutMs: 120000,
          needsInputTimeoutMs: 86400000,
        },
      });
      expect(createRes.ok()).toBeTruthy();
      await waitForEvents(
        sse.events,
        (e) => e.type === "job.changed",
        baselineCount + 1,
      );

      // 2. Update the job → expect another job.changed
      const updateRes = await request.patch("/api/v1/jobs", {
        headers: HEADERS,
        data: {
          name: "SSE Test Job",
          directory: jobDir,
          schedule: "*/30 * * * *",
          enabled: true,
        },
      });
      expect(updateRes.ok()).toBeTruthy();
      await waitForEvents(
        sse.events,
        (e) => e.type === "job.changed",
        baselineCount + 2,
      );

      // 3. Enable the job → expect another job.changed
      const enableRes = await request.post("/api/v1/jobs/enable", {
        headers: HEADERS,
        data: { name: "SSE Test Job", directory: jobDir },
      });
      expect(enableRes.ok()).toBeTruthy();
      await waitForEvents(
        sse.events,
        (e) => e.type === "job.changed",
        baselineCount + 3,
      );

      // 4. Disable the job → expect another job.changed
      const disableRes = await request.post("/api/v1/jobs/disable", {
        headers: HEADERS,
        data: { name: "SSE Test Job", directory: jobDir },
      });
      expect(disableRes.ok()).toBeTruthy();
      await waitForEvents(
        sse.events,
        (e) => e.type === "job.changed",
        baselineCount + 4,
      );

      // 5. Delete the job → expect another job.changed
      const deleteRes = await request.delete("/api/v1/jobs", {
        headers: HEADERS,
        data: { name: "SSE Test Job", directory: jobDir },
      });
      expect(deleteRes.ok()).toBeTruthy();
      await waitForEvents(
        sse.events,
        (e) => e.type === "job.changed",
        baselineCount + 5,
      );
    } finally {
      sse.close();
    }
  });

  test("running a job emits job.changed for started and running transitions", async ({
    request,
  }) => {
    const runDir = join(tmpdir(), `dispatch-e2e-sse-run-${Date.now()}`);
    mkdirSync(runDir, { recursive: true });

    // Create a job to run
    const createRes = await request.post("/api/v1/jobs", {
      headers: HEADERS,
      data: {
        name: "SSE Run Job",
        directory: runDir,
        prompt:
          'Call job_complete immediately with status "completed", summary "done", and one task "check" with status "success".',
        schedule: "0 * * * *",
        timeoutMs: 120000,
        needsInputTimeoutMs: 86400000,
      },
    });
    expect(createRes.ok()).toBeTruthy();

    const sse = openSSEStream(SSE_BASE_URL);
    try {
      await sse.ready;
      const baselineCount = sse.events.filter(
        (e) => e.type === "job.changed",
      ).length;

      // Run the job (non-blocking)
      const runRes = await request.post("/api/v1/jobs/run", {
        headers: HEADERS,
        data: { name: "SSE Run Job", directory: runDir, wait: false },
      });
      expect(runRes.ok()).toBeTruthy();

      // We should get at least 2 job.changed events: one for "started", one for "running"
      await waitForEvents(
        sse.events,
        (e) => e.type === "job.changed",
        baselineCount + 2,
      );
    } finally {
      sse.close();
    }
  });
});
