import { test, expect } from "@playwright/test";
import { mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const AUTH_HEADER = {
  Authorization: `Bearer ${process.env.AUTH_TOKEN ?? "dev-token"}`,
};
const HEADERS = { ...AUTH_HEADER, "Content-Type": "application/json" };

test.describe.configure({ mode: "serial" });

test.describe("Jobs webhook UI", () => {
  const jobDir = join(tmpdir(), `dispatch-e2e-webhook-ui-${Date.now()}`);
  mkdirSync(jobDir, { recursive: true });
  let jobId: string;

  test("webhook toggle off hides URL section", async ({ page, request }) => {
    const res = await request.post("/api/v1/jobs", {
      headers: HEADERS,
      data: {
        name: "Webhook UI Test",
        directory: jobDir,
        prompt: "Test prompt.",
        timeoutMs: 120000,
        needsInputTimeoutMs: 86400000,
      },
    });
    expect(res.ok()).toBeTruthy();
    const job = await res.json();
    jobId = job.id;
    expect(job.webhookEnabled).toBe(false);
    expect(job.webhookSecret).toBeNull();

    await page.goto(`/automations/jobs/${jobId}`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("switch", { name: "Webhook trigger" }).waitFor();

    await expect(
      page.getByRole("switch", { name: "Webhook trigger" })
    ).not.toBeChecked();
    await expect(
      page.getByText("Webhook URL", { exact: true })
    ).not.toBeVisible();
    await expect(
      page.getByText("Save to generate a webhook URL.")
    ).not.toBeVisible();
  });

  test("toggling webhook on shows save prompt when no secret exists", async ({
    page,
  }) => {
    await page.goto(`/automations/jobs/${jobId}`, {
      waitUntil: "domcontentloaded",
    });
    const toggle = page.getByRole("switch", { name: "Webhook trigger" });
    await toggle.waitFor();
    await toggle.click();

    await expect(toggle).toBeChecked();
    await expect(
      page.getByText("Save to generate a webhook URL.")
    ).toBeVisible();
    await expect(
      page.getByText("Webhook URL", { exact: true })
    ).not.toBeVisible();
  });

  test("saving with webhook on generates and displays URL", async ({
    page,
    request,
  }) => {
    // Enable webhook via API so we don't rely on UI toggle + save race
    const updateRes = await request.patch("/api/v1/jobs", {
      headers: HEADERS,
      data: {
        name: "Webhook UI Test",
        directory: jobDir,
        webhookEnabled: true,
      },
    });
    expect(updateRes.ok()).toBeTruthy();
    const updated = await updateRes.json();
    expect(updated.webhookEnabled).toBe(true);
    expect(updated.webhookSecret).toBeTruthy();

    await page.goto(`/automations/jobs/${jobId}`, {
      waitUntil: "domcontentloaded",
    });
    const toggle = page.getByRole("switch", { name: "Webhook trigger" });
    await toggle.waitFor();
    await expect(toggle).toBeChecked();

    await expect(page.getByText("Webhook URL", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Copy webhook URL" })
    ).toBeVisible();
    await expect(page.getByText("/api/v1/jobs/webhook/")).toBeVisible();
  });

  test("toggling webhook off hides URL immediately", async ({ page }) => {
    await page.goto(`/automations/jobs/${jobId}`, {
      waitUntil: "domcontentloaded",
    });
    const toggle = page.getByRole("switch", { name: "Webhook trigger" });
    await toggle.waitFor();
    await expect(page.getByText("Webhook URL", { exact: true })).toBeVisible();

    await toggle.click();
    await expect(toggle).not.toBeChecked();

    await expect(
      page.getByText("Webhook URL", { exact: true })
    ).not.toBeVisible();
    await expect(
      page.getByText("Save to generate a webhook URL.")
    ).not.toBeVisible();
  });

  test("saving with webhook off clears the secret", async ({
    page,
    request,
  }) => {
    // Disable webhook via API
    const updateRes = await request.patch("/api/v1/jobs", {
      headers: HEADERS,
      data: {
        name: "Webhook UI Test",
        directory: jobDir,
        webhookEnabled: false,
      },
    });
    expect(updateRes.ok()).toBeTruthy();
    const updated = await updateRes.json();
    expect(updated.webhookEnabled).toBe(false);
    expect(updated.webhookSecret).toBeNull();

    // Verify UI reflects the disabled state
    await page.goto(`/automations/jobs/${jobId}`, {
      waitUntil: "domcontentloaded",
    });
    const toggle = page.getByRole("switch", { name: "Webhook trigger" });
    await toggle.waitFor();
    await expect(toggle).not.toBeChecked();
    await expect(
      page.getByText("Webhook URL", { exact: true })
    ).not.toBeVisible();
  });
});
