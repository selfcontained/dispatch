import { test, expect } from "@playwright/test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const AUTH_HEADER = { Authorization: `Bearer ${process.env.AUTH_TOKEN ?? "dev-token"}` };
const HEADERS = { ...AUTH_HEADER, "Content-Type": "application/json" };

// Create a temporary job directory with a test job file
const jobDir = join(tmpdir(), `dispatch-e2e-jobs-${Date.now()}`);
const jobFilePath = join(jobDir, ".dispatch", "jobs", "e2e-test.md");

test.beforeAll(() => {
  mkdirSync(join(jobDir, ".dispatch", "jobs"), { recursive: true });
  writeFileSync(
    jobFilePath,
    `---
name: E2E Test Job
schedule: "0 * * * *"
timeout: 2m
notify:
  on_complete:
    - slack
  on_error:
    - slack
---

This is an E2E test job. Call job_complete immediately with status "completed", summary "E2E passed", and one task "check" with status "success" and summary "ok".
`
  );
});

test.afterAll(() => {
  rmSync(jobDir, { recursive: true, force: true });
});

test.describe("Jobs API", () => {
  test("GET /api/v1/jobs returns empty array initially", async ({ request }) => {
    const res = await request.get("/api/v1/jobs", { headers: AUTH_HEADER });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test("POST /api/v1/jobs/run creates and runs a job", async ({ request }) => {
    const res = await request.post("/api/v1/jobs/run", {
      headers: HEADERS,
      data: { name: "e2e-test", directory: jobDir, wait: false },
    });
    expect(res.ok()).toBeTruthy();

    const body = await res.json();
    expect(body.jobId).toBeTruthy();
    expect(body.runId).toBeTruthy();
    expect(body.agentId).toBeTruthy();
    expect(body.status).toBe("running");

    const params = new URLSearchParams({ name: "e2e-test", directory: jobDir });
    const historyRes = await request.get(`/api/v1/jobs/history?${params}`, { headers: AUTH_HEADER });
    expect(historyRes.ok()).toBeTruthy();
    const history = await historyRes.json();
    const run = history.runs.find((entry: { id: string }) => entry.id === body.runId);
    expect(run.config.triggerSource).toBe("manual");
  });

  test("GET /api/v1/jobs lists job after run", async ({ request }) => {
    // Ensure job exists by running it first
    await request.post("/api/v1/jobs/run", {
      headers: HEADERS,
      data: { name: "e2e-test", directory: jobDir, wait: false },
    });

    const res = await request.get("/api/v1/jobs", { headers: AUTH_HEADER });
    expect(res.ok()).toBeTruthy();

    const body = await res.json();
    const job = body.find((j: { name: string }) => j.name === "E2E Test Job");
    expect(job).toBeTruthy();
    expect(job.directory).toBe(jobDir);
    expect(job.schedule).toBe("0 * * * *");
  });

  test("GET /api/v1/jobs/available scans a manual directory", async ({ request }) => {
    const params = new URLSearchParams({ directory: jobDir });
    const res = await request.get(`/api/v1/jobs/available?${params}`, { headers: AUTH_HEADER });
    expect(res.ok()).toBeTruthy();

    const body = await res.json();
    expect(Array.isArray(body.directories)).toBe(true);
    const directory = body.directories.find((entry: { directory: string }) => entry.directory === jobDir);
    expect(directory).toBeTruthy();
    expect(directory.source).toBe("manual");
    const job = directory.jobs.find((entry: { name: string }) => entry.name === "E2E Test Job");
    expect(job).toBeTruthy();
    expect(job.filePath).toBe(jobFilePath);
    expect(job.schedule).toBe("0 * * * *");
  });

  test("POST /api/v1/jobs adds a job without enabling it", async ({ request }) => {
    const addDir = join(tmpdir(), `dispatch-e2e-add-job-${Date.now()}`);
    mkdirSync(join(addDir, ".dispatch", "jobs"), { recursive: true });
    writeFileSync(
      join(addDir, ".dispatch", "jobs", "add-only.md"),
      `---
name: Add Only Job
schedule: "*/15 * * * *"
---

This job is added by the UI before it is enabled.
`
    );

    const res = await request.post("/api/v1/jobs", {
      headers: HEADERS,
      data: { name: "add-only", directory: addDir },
    });
    expect(res.ok()).toBeTruthy();

    const body = await res.json();
    expect(body.name).toBe("Add Only Job");
    expect(body.directory).toBe(addDir);
    expect(body.enabled).toBe(false);

    rmSync(addDir, { recursive: true, force: true });
  });

  test("POST /api/v1/jobs accepts setup overrides", async ({ request }) => {
    const addDir = join(tmpdir(), `dispatch-e2e-add-job-config-${Date.now()}`);
    mkdirSync(join(addDir, ".dispatch", "jobs"), { recursive: true });
    writeFileSync(
      join(addDir, ".dispatch", "jobs", "configurable.md"),
      `---
name: Configurable Job
schedule: "*/15 * * * *"
timeout: 20m
---

This job is configured by the add job form.
`
    );

    const res = await request.post("/api/v1/jobs", {
      headers: HEADERS,
      data: {
        name: "configurable",
        directory: addDir,
        displayName: "Configured Job",
        schedule: "*/30 * * * *",
        timeoutMs: 600000,
        needsInputTimeoutMs: 3600000,
        agentType: "claude",
        useWorktree: true,
        branchName: "jobs/configurable",
        fullAccess: true,
        additionalInstructions: "Keep the summary short.",
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
    expect(body.additionalInstructions).toBe("Keep the summary short.");
    expect(body.enabled).toBe(true);

    rmSync(addDir, { recursive: true, force: true });
  });

  test("PATCH /api/v1/jobs updates saved job settings", async ({ request }) => {
    const updateDir = join(tmpdir(), `dispatch-e2e-update-job-${Date.now()}`);
    mkdirSync(join(updateDir, ".dispatch", "jobs"), { recursive: true });
    writeFileSync(
      join(updateDir, ".dispatch", "jobs", "editable.md"),
      `---
name: Editable Job
schedule: "*/15 * * * *"
---

This job is edited after it is added.
`
    );

    const addRes = await request.post("/api/v1/jobs", {
      headers: HEADERS,
      data: { name: "editable", directory: updateDir },
    });
    expect(addRes.ok()).toBeTruthy();

    const updateRes = await request.patch("/api/v1/jobs", {
      headers: HEADERS,
      data: {
        name: "editable",
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

    rmSync(updateDir, { recursive: true, force: true });
  });

  test("POST /api/v1/jobs/enable validates schedule exists", async ({ request }) => {
    // Create a job file without a schedule
    const noScheduleDir = join(tmpdir(), `dispatch-e2e-nosched-${Date.now()}`);
    mkdirSync(join(noScheduleDir, ".dispatch", "jobs"), { recursive: true });
    writeFileSync(
      join(noScheduleDir, ".dispatch", "jobs", "no-sched.md"),
      `---\nname: No Schedule\n---\nDo nothing.\n`
    );

    const res = await request.post("/api/v1/jobs/enable", {
      headers: HEADERS,
      data: { name: "no-sched", directory: noScheduleDir },
    });
    expect(res.status()).toBe(500);
    const body = await res.json();
    expect(body.error).toContain("no schedule");

    rmSync(noScheduleDir, { recursive: true, force: true });
  });

  test("POST /api/v1/jobs/enable + disable toggles enabled", async ({ request }) => {
    // Enable
    const enableRes = await request.post("/api/v1/jobs/enable", {
      headers: HEADERS,
      data: { name: "e2e-test", directory: jobDir },
    });
    expect(enableRes.ok()).toBeTruthy();
    const enabled = await enableRes.json();
    expect(enabled.enabled).toBe(true);

    // Verify in list
    const listRes = await request.get("/api/v1/jobs", { headers: AUTH_HEADER });
    const jobs = await listRes.json();
    const job = jobs.find((j: { id: string }) => j.id === enabled.id);
    expect(job.enabled).toBe(true);
    expect(job.nextRun).toBeTruthy(); // should have a next run when enabled

    // Disable
    const disableRes = await request.post("/api/v1/jobs/disable", {
      headers: HEADERS,
      data: { name: "e2e-test", directory: jobDir },
    });
    expect(disableRes.ok()).toBeTruthy();
    const disabled = await disableRes.json();
    expect(disabled.enabled).toBe(false);

    // Verify in list
    const listRes2 = await request.get("/api/v1/jobs", { headers: AUTH_HEADER });
    const jobs2 = await listRes2.json();
    const job2 = jobs2.find((j: { id: string }) => j.id === enabled.id);
    expect(job2.enabled).toBe(false);
    expect(job2.nextRun).toBeNull();
  });

  test("GET /api/v1/jobs/history returns runs for a job", async ({ request }) => {
    // Ensure job exists by running it (may fail if already active — that's ok)
    await request.post("/api/v1/jobs/run", {
      headers: HEADERS,
      data: { name: "e2e-test", directory: jobDir, wait: false },
    });

    // Query history — should have at least one run from this or prior tests
    const params = new URLSearchParams({ name: "e2e-test", directory: jobDir });
    const res = await request.get(`/api/v1/jobs/history?${params}`, { headers: AUTH_HEADER });
    expect(res.ok()).toBeTruthy();

    const body = await res.json();
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

  test("POST /api/v1/jobs/run with nonexistent job file returns error", async ({ request }) => {
    const res = await request.post("/api/v1/jobs/run", {
      headers: HEADERS,
      data: { name: "does-not-exist", directory: "/tmp/no-such-dir" },
    });
    expect(res.status()).toBe(500);
  });
});
