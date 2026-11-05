import { expect, test } from "@playwright/test";
import { authHeaders } from "./helpers";

// One persistence journey. Field states and payload validation belong in
// jobs-settings-tab.test.tsx and jobs-webhook-route.test.ts, respectively.
test("save webhook settings and reload the persisted URL", async ({
  page,
  request,
}, testInfo) => {
  const created = await request.post("/api/v1/jobs", {
    headers: authHeaders(),
    data: {
      name: `webhook-${testInfo.testId}`,
      directory: "/tmp",
      prompt: "Webhook journey",
    },
  });
  expect(created.ok()).toBeTruthy();
  const job = await created.json();
  try {
    await page.goto(`/automations/jobs/${job.id}`, {
      waitUntil: "domcontentloaded",
    });
    const toggle = page.getByRole("switch", { name: "Webhook trigger" });
    await expect(toggle).not.toBeChecked();
    await toggle.click();
    await expect(
      page.getByText("Save to generate a webhook URL.")
    ).toBeVisible();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Copy webhook URL" })
    ).toBeVisible();
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(toggle).toBeChecked();
    await expect(
      page.getByRole("button", { name: "Copy webhook URL" })
    ).toBeVisible();
    await testInfo.attach("persisted webhook settings", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
    await toggle.click();
    await expect(
      page.getByText("Webhook URL", { exact: true })
    ).not.toBeVisible();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    // Observe the persisted response before navigating away from the mutation.
    await expect
      .poll(async () => {
        const response = await request.get("/api/v1/jobs", {
          headers: authHeaders(),
        });
        expect(response.ok()).toBeTruthy();
        return (await response.json()).find(
          (item: { id: string }) => item.id === job.id
        )?.webhookSecret;
      })
      .toBeNull();
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(toggle).not.toBeChecked();
    await expect(
      page.getByText("Webhook URL", { exact: true })
    ).not.toBeVisible();
  } finally {
    const removed = await request.delete("/api/v1/jobs", {
      headers: authHeaders(),
      data: { jobId: job.id },
    });
    expect(removed.ok()).toBeTruthy();
  }
});
