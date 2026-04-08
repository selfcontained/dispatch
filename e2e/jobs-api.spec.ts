import { test, expect } from "@playwright/test";

const AUTH_HEADER = { Authorization: `Bearer ${process.env.AUTH_TOKEN ?? "dev-token"}` };
const HEADERS = { ...AUTH_HEADER, "Content-Type": "application/json" };

const TEST_DIRECTORY = "/tmp/dispatch-e2e-jobs";

test.describe("Jobs API", () => {
  test("GET /api/v1/jobs returns empty array initially", async ({ request }) => {
    const res = await request.get("/api/v1/jobs", { headers: AUTH_HEADER });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test("POST /api/v1/jobs creates a job", async ({ request }) => {
    const res = await request.post("/api/v1/jobs", {
      headers: HEADERS,
      data: {
        name: "E2E Test Job",
        directory: TEST_DIRECTORY,
        prompt: "This is an E2E test job. Call job_complete immediately with status completed, summary E2E passed, and one task check with status success and summary ok.",
        schedule: "0 * * * *",
        timeoutMs: 120000,
      },
    });
    expect(res.ok()).toBeTruthy();

    const body = await res.json();
    expect(body.id).toBeTruthy();
    expect(body.name).toBe("E2E Test Job");
    expect(body.directory).toBe(TEST_DIRECTORY);
    expect(body.prompt).toContain("E2E test job");
    expect(body.schedule).toBe("0 * * * *");
    expect(body.enabled).toBe(false);
  });

  test("POST /api/v1/jobs validates required fields", async ({ request }) => {
    const res = await request.post("/api/v1/jobs", {
      headers: HEADERS,
      data: {},
    });
    expect(res.status()).toBe(400);
  });

  test("POST /api/v1/jobs creates with full config", async ({ request }) => {
    const res = await request.post("/api/v1/jobs", {
      headers: HEADERS,
      data: {
        name: "Configured Job",
        directory: TEST_DIRECTORY,
        prompt: "This job is configured by the create form.",
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
  });

  test("PATCH /api/v1/jobs updates job settings", async ({ request }) => {
    // Create a job first
    const createRes = await request.post("/api/v1/jobs", {
      headers: HEADERS,
      data: {
        name: "Editable Job",
        directory: TEST_DIRECTORY,
        prompt: "This job is edited after it is created.",
        schedule: "*/15 * * * *",
      },
    });
    expect(createRes.ok()).toBeTruthy();
    const created = await createRes.json();

    // Update it
    const updateRes = await request.patch("/api/v1/jobs", {
      headers: HEADERS,
      data: {
        id: created.id,
        name: "Edited Job",
        prompt: "Updated prompt content.",
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
    expect(body.prompt).toBe("Updated prompt content.");
    expect(body.schedule).toBe("*/45 * * * *");
    expect(body.timeoutMs).toBe(900000);
    expect(body.needsInputTimeoutMs).toBe(1800000);
    expect(body.agentType).toBe("codex");
    expect(body.fullAccess).toBe(true);
    expect(body.enabled).toBe(true);
  });

  test("POST /api/v1/jobs/enable validates schedule exists", async ({ request }) => {
    // Create a job without a schedule
    const createRes = await request.post("/api/v1/jobs", {
      headers: HEADERS,
      data: {
        name: "No Schedule Job",
        directory: TEST_DIRECTORY,
        prompt: "Do nothing.",
      },
    });
    expect(createRes.ok()).toBeTruthy();
    const created = await createRes.json();

    const res = await request.post("/api/v1/jobs/enable", {
      headers: HEADERS,
      data: { id: created.id },
    });
    expect(res.status()).toBe(500);
    const body = await res.json();
    expect(body.error).toContain("no schedule");
  });

  test("POST /api/v1/jobs/enable + disable toggles enabled", async ({ request }) => {
    // Create a job with a schedule
    const createRes = await request.post("/api/v1/jobs", {
      headers: HEADERS,
      data: {
        name: "Toggleable Job",
        directory: TEST_DIRECTORY,
        prompt: "A toggleable job.",
        schedule: "0 * * * *",
      },
    });
    expect(createRes.ok()).toBeTruthy();
    const created = await createRes.json();

    // Enable
    const enableRes = await request.post("/api/v1/jobs/enable", {
      headers: HEADERS,
      data: { id: created.id },
    });
    expect(enableRes.ok()).toBeTruthy();
    const enabled = await enableRes.json();
    expect(enabled.enabled).toBe(true);

    // Verify in list
    const listRes = await request.get("/api/v1/jobs", { headers: AUTH_HEADER });
    const jobs = await listRes.json();
    const job = jobs.find((j: { id: string }) => j.id === enabled.id);
    expect(job.enabled).toBe(true);
    expect(job.nextRun).toBeTruthy();

    // Disable
    const disableRes = await request.post("/api/v1/jobs/disable", {
      headers: HEADERS,
      data: { id: created.id },
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
    // Create a job
    const createRes = await request.post("/api/v1/jobs", {
      headers: HEADERS,
      data: {
        name: "History Job",
        directory: TEST_DIRECTORY,
        prompt: "A job for history testing.",
        schedule: "0 * * * *",
      },
    });
    expect(createRes.ok()).toBeTruthy();
    const created = await createRes.json();

    const params = new URLSearchParams({ id: created.id });
    const res = await request.get(`/api/v1/jobs/history?${params}`, { headers: AUTH_HEADER });
    expect(res.ok()).toBeTruthy();

    const body = await res.json();
    expect(body.job).toBeTruthy();
    expect(body.job.name).toBe("History Job");
    expect(Array.isArray(body.runs)).toBe(true);
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
    const params = new URLSearchParams({ id: "00000000-0000-0000-0000-000000000000" });
    const res = await request.get(`/api/v1/jobs/history?${params}`, { headers: AUTH_HEADER });
    expect(res.status()).toBe(404);
  });

  test("POST /api/v1/jobs/run with nonexistent job returns error", async ({ request }) => {
    const res = await request.post("/api/v1/jobs/run", {
      headers: HEADERS,
      data: { id: "nonexistent-id" },
    });
    expect(res.status()).toBe(500);
  });

  test("DELETE /api/v1/jobs removes a job", async ({ request }) => {
    const createRes = await request.post("/api/v1/jobs", {
      headers: HEADERS,
      data: {
        name: "Deletable Job",
        directory: TEST_DIRECTORY,
        prompt: "A job that will be deleted.",
      },
    });
    expect(createRes.ok()).toBeTruthy();
    const created = await createRes.json();

    const deleteRes = await request.delete("/api/v1/jobs", {
      headers: HEADERS,
      data: { id: created.id },
    });
    expect(deleteRes.ok()).toBeTruthy();

    // Verify it's gone
    const listRes = await request.get("/api/v1/jobs", { headers: AUTH_HEADER });
    const jobs = await listRes.json();
    expect(jobs.find((j: { id: string }) => j.id === created.id)).toBeUndefined();
  });
});
