import { test, expect } from "@playwright/test";
import { mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const AUTH_HEADER = { Authorization: `Bearer ${process.env.AUTH_TOKEN ?? "dev-token"}` };
const HEADERS = { ...AUTH_HEADER, "Content-Type": "application/json" };

// Use a unique directory per test run to avoid collisions
const jobDir = join(tmpdir(), `dispatch-e2e-jobs-${Date.now()}`);
mkdirSync(jobDir, { recursive: true });

// Helper to create the shared test job used by several tests
async function ensureTestJob(request: import("@playwright/test").APIRequestContext) {
  // Try to create — ignore if already exists
  const res = await request.post("/api/v1/jobs", {
    headers: HEADERS,
    data: {
      name: "E2E Test Job",
      directory: jobDir,
      prompt: 'This is an E2E test job. Call job_complete immediately with status "completed", summary "E2E passed", and one task "check" with status "success" and summary "ok".',
      schedule: "0 * * * *",
      timeoutMs: 120000,
      needsInputTimeoutMs: 86400000,
    },
  });
  return res;
}

test.describe.configure({ mode: "serial" });

test.describe("Jobs API", () => {
  test("GET /api/v1/jobs returns array", async ({ request }) => {
    const res = await request.get("/api/v1/jobs", { headers: AUTH_HEADER });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test("POST /api/v1/jobs creates a job", async ({ request }) => {
    const res = await ensureTestJob(request);
    expect(res.ok()).toBeTruthy();

    const body = await res.json();
    expect(body.name).toBe("E2E Test Job");
    expect(body.directory).toBe(jobDir);
    expect(body.schedule).toBe("0 * * * *");
    expect(body.enabled).toBe(false);
    expect(body.prompt).toContain("E2E test job");
  });

  test("POST /api/v1/jobs/run runs a job", async ({ request }) => {
    await ensureTestJob(request);

    const res = await request.post("/api/v1/jobs/run", {
      headers: HEADERS,
      data: { name: "E2E Test Job", directory: jobDir, wait: false },
    });
    const body = await res.json();
    expect(res.ok(), `Run failed: ${JSON.stringify(body)}`).toBeTruthy();

    expect(body.jobId).toBeTruthy();
    expect(body.runId).toBeTruthy();
    expect(body.agentId).toBeTruthy();
    expect(body.status).toBe("running");

    const params = new URLSearchParams({ name: "E2E Test Job", directory: jobDir });
    const historyRes = await request.get(`/api/v1/jobs/history?${params}`, { headers: AUTH_HEADER });
    expect(historyRes.ok()).toBeTruthy();
    const history = await historyRes.json();
    const run = history.runs.find((entry: { id: string }) => entry.id === body.runId);
    expect(run.config.triggerSource).toBe("manual");
  });

  test("GET /api/v1/jobs lists job after creation", async ({ request }) => {
    await ensureTestJob(request);

    const res = await request.get("/api/v1/jobs", { headers: AUTH_HEADER });
    expect(res.ok()).toBeTruthy();

    const body = await res.json();
    const job = body.find((j: { name: string; directory: string }) => j.name === "E2E Test Job" && j.directory === jobDir);
    expect(job).toBeTruthy();
    expect(job.schedule).toBe("0 * * * *");
  });

  test("POST /api/v1/jobs accepts full config", async ({ request }) => {
    const configDir = join(tmpdir(), `dispatch-e2e-add-job-config-${Date.now()}`);
    const res = await request.post("/api/v1/jobs", {
      headers: HEADERS,
      data: {
        name: "Configured Job",
        directory: configDir,
        prompt: "This job is configured by the add job form.",
        schedule: "*/30 * * * *",
        timeoutMs: 600000,
        needsInputTimeoutMs: 3600000,
        agentType: "claude",
        useWorktree: true,
        branchName: "jobs/configurable",
        fullAccess: true,
        enabled: true,
      },
    });
    expect(res.ok()).toBeTruthy();

    const body = await res.json();
    expect(body.name).toBe("Configured Job");
    expect(body.schedule).toBe("*/30 * * * *");
    expect(body.timeoutMs).toBe(600000);
    expect(body.needsInputTimeoutMs).toBe(3600000);
    expect(body.agentType).toBe("claude");
    expect(body.useWorktree).toBe(true);
    expect(body.branchName).toBe("jobs/configurable");
    expect(body.fullAccess).toBe(true);
    expect(body.enabled).toBe(true);
  });

  test("PATCH /api/v1/jobs updates saved job settings", async ({ request }) => {
    const updateDir = join(tmpdir(), `dispatch-e2e-update-job-${Date.now()}`);
    // First create
    const addRes = await request.post("/api/v1/jobs", {
      headers: HEADERS,
      data: {
        name: "Editable Job",
        directory: updateDir,
        prompt: "This job is edited after it is added.",
        schedule: "*/15 * * * *",
        timeoutMs: 1800000,
        needsInputTimeoutMs: 86400000,
      },
    });
    expect(addRes.ok()).toBeTruthy();

    const updateRes = await request.patch("/api/v1/jobs", {
      headers: HEADERS,
      data: {
        name: "Editable Job",
        directory: updateDir,
        displayName: "Edited Job",
        schedule: "*/45 * * * *",
        timeoutMs: 900000,
        needsInputTimeoutMs: 1800000,
        agentType: "codex",
        fullAccess: true,
        enabled: true,
      },
    });
    expect(updateRes.ok()).toBeTruthy();
    const body = await updateRes.json();
    expect(body.name).toBe("Edited Job");
    expect(body.schedule).toBe("*/45 * * * *");
    expect(body.timeoutMs).toBe(900000);
    expect(body.needsInputTimeoutMs).toBe(1800000);
    expect(body.agentType).toBe("codex");
    expect(body.fullAccess).toBe(true);
    expect(body.enabled).toBe(true);
  });

  test("POST /api/v1/jobs/enable validates schedule exists", async ({ request }) => {
    const noScheduleDir = join(tmpdir(), `dispatch-e2e-nosched-${Date.now()}`);
    // Create a job without a schedule
    const createRes = await request.post("/api/v1/jobs", {
      headers: HEADERS,
      data: {
        name: "No Schedule",
        directory: noScheduleDir,
        prompt: "Do nothing.",
        timeoutMs: 1800000,
        needsInputTimeoutMs: 86400000,
      },
    });
    expect(createRes.ok()).toBeTruthy();

    const res = await request.post("/api/v1/jobs/enable", {
      headers: HEADERS,
      data: { name: "No Schedule", directory: noScheduleDir },
    });
    expect(res.status()).toBe(500);
    const body = await res.json();
    expect(body.error).toContain("no schedule");
  });

  test("POST /api/v1/jobs/enable + disable toggles enabled", async ({ request }) => {
    await ensureTestJob(request);

    // Enable
    const enableRes = await request.post("/api/v1/jobs/enable", {
      headers: HEADERS,
      data: { name: "E2E Test Job", directory: jobDir },
    });
    const enableBody = await enableRes.json();
    expect(enableRes.ok(), `Enable failed: ${JSON.stringify(enableBody)}`).toBeTruthy();
    expect(enableBody.enabled).toBe(true);

    // Verify in list
    const listRes = await request.get("/api/v1/jobs", { headers: AUTH_HEADER });
    const jobs = await listRes.json();
    const job = jobs.find((j: { id: string }) => j.id === enableBody.id);
    expect(job.enabled).toBe(true);
    expect(job.nextRun).toBeTruthy();

    // Disable
    const disableRes = await request.post("/api/v1/jobs/disable", {
      headers: HEADERS,
      data: { name: "E2E Test Job", directory: jobDir },
    });
    expect(disableRes.ok()).toBeTruthy();
    const disabled = await disableRes.json();
    expect(disabled.enabled).toBe(false);

    // Verify in list
    const listRes2 = await request.get("/api/v1/jobs", { headers: AUTH_HEADER });
    const jobs2 = await listRes2.json();
    const job2 = jobs2.find((j: { id: string }) => j.id === enableBody.id);
    expect(job2.enabled).toBe(false);
    expect(job2.nextRun).toBeNull();
  });

  test("GET /api/v1/jobs/history returns runs for a job", async ({ request }) => {
    await ensureTestJob(request);

    // Ensure job has at least one run
    await request.post("/api/v1/jobs/run", {
      headers: HEADERS,
      data: { name: "E2E Test Job", directory: jobDir, wait: false },
    });

    const params = new URLSearchParams({ name: "E2E Test Job", directory: jobDir });
    const res = await request.get(`/api/v1/jobs/history?${params}`, { headers: AUTH_HEADER });
    const body = await res.json();
    expect(res.ok(), `History failed: ${JSON.stringify(body)}`).toBeTruthy();

    expect(body.job).toBeTruthy();
    expect(body.job.name).toBe("E2E Test Job");
    expect(Array.isArray(body.runs)).toBe(true);
    expect(body.runs.length).toBeGreaterThan(0);
  });

  test("POST /api/v1/jobs/run validates required fields", async ({ request }) => {
    const res = await request.post("/api/v1/jobs/run", {
      headers: HEADERS,
      data: {},
    });
    expect(res.status()).toBe(400);
  });

  test("POST /api/v1/jobs/enable validates required fields", async ({ request }) => {
    const res = await request.post("/api/v1/jobs/enable", {
      headers: HEADERS,
      data: {},
    });
    expect(res.status()).toBe(400);
  });

  test("POST /api/v1/jobs/disable validates required fields", async ({ request }) => {
    const res = await request.post("/api/v1/jobs/disable", {
      headers: HEADERS,
      data: {},
    });
    expect(res.status()).toBe(400);
  });

  test("GET /api/v1/jobs/history returns 404 for unknown job", async ({ request }) => {
    const params = new URLSearchParams({ name: "nonexistent", directory: "/tmp/nope" });
    const res = await request.get(`/api/v1/jobs/history?${params}`, { headers: AUTH_HEADER });
    expect(res.status()).toBe(404);
  });

  test("POST /api/v1/jobs/run with nonexistent job returns error", async ({ request }) => {
    const res = await request.post("/api/v1/jobs/run", {
      headers: HEADERS,
      data: { name: "does-not-exist", directory: "/tmp/no-such-dir" },
    });
    expect(res.status()).toBe(500);
  });
});
