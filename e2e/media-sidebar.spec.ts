import { expect, test } from "@playwright/test";

import { cleanupE2EAgents, createAgentViaAPI, loadApp, uploadMediaViaAPI } from "./helpers";

test.describe("Media sidebar", () => {
  test.afterAll(async ({ request }) => {
    await cleanupE2EAgents(request);
  });

  test("refreshes cached media when switching back to an agent", async ({ page, request }) => {
    const firstAgent = await createAgentViaAPI(request, { name: `e2e-agent-media-a-${Date.now()}` });
    const secondAgent = await createAgentViaAPI(request, { name: `e2e-agent-media-b-${Date.now()}` });

    await uploadMediaViaAPI(request, firstAgent.id, "First image", "first-image.png");

    await loadApp(page);

    await page.getByText(firstAgent.name, { exact: true }).click();
    await page.getByTestId("toggle-media-sidebar").click();

    const mediaSidebar = page.getByTestId("media-sidebar");
    await expect(mediaSidebar).toBeVisible();
    await expect(mediaSidebar).toContainText(firstAgent.name);
    await expect(mediaSidebar).toContainText("1 items");
    await expect(mediaSidebar.getByText("First image")).toBeVisible();

    await page.getByText(secondAgent.name, { exact: true }).click();
    await expect(mediaSidebar).toContainText(secondAgent.name);
    await uploadMediaViaAPI(request, firstAgent.id, "Second image", "second-image.png");
    await page.getByText(firstAgent.name, { exact: true }).click();
    await expect(mediaSidebar).toContainText(firstAgent.name);

    await expect(mediaSidebar).toContainText("2 items", { timeout: 10_000 });
    await expect(mediaSidebar.getByText("Second image")).toBeVisible();
  });

  test("navigates between fullscreen media items", async ({ page, request }) => {
    const agent = await createAgentViaAPI(request, { name: `e2e-agent-lightbox-${Date.now()}` });

    await uploadMediaViaAPI(request, agent.id, "First image", "first-image.png");
    await uploadMediaViaAPI(request, agent.id, "Second image", "second-image.png");

    await loadApp(page);

    await page.getByText(agent.name, { exact: true }).click();
    await page.getByTestId("toggle-media-sidebar").click();

    const mediaSidebar = page.getByTestId("media-sidebar");
    await expect(mediaSidebar).toContainText("2 items");

    await mediaSidebar.getByRole("button", { name: "Second image" }).click();

    const lightbox = page.getByTestId("media-lightbox");
    await expect(lightbox).toBeVisible();
    await expect(lightbox).toContainText("1 / 2");
    await expect(lightbox).toContainText("Second image");

    await page.getByTestId("media-lightbox-next").click();
    await expect(lightbox).toContainText("2 / 2");
    await expect(lightbox).toContainText("First image");

    await page.getByTestId("media-lightbox-prev").click();
    await expect(lightbox).toContainText("1 / 2");
    await expect(lightbox).toContainText("Second image");

    await page.keyboard.press("ArrowRight");
    await expect(lightbox).toContainText("2 / 2");

    await lightbox.getByRole("button", { name: "Close" }).click();
    await expect(lightbox).toBeHidden();
  });

  test("marks visible media as seen and persists to server", async ({ page, request }) => {
    const agent = await createAgentViaAPI(request, { name: `e2e-agent-seen-${Date.now()}` });

    await uploadMediaViaAPI(request, agent.id, "Seen test image", "seen-test.png");

    await loadApp(page);
    await page.getByText(agent.name, { exact: true }).click();
    await page.getByTestId("toggle-media-sidebar").click();

    const mediaSidebar = page.getByTestId("media-sidebar");
    await expect(mediaSidebar).toContainText("1 items");

    // The item should flip to "seen" once visible (IntersectionObserver fires).
    const thumb = mediaSidebar.locator(".media-thumb-seen");
    await expect(thumb).toBeVisible({ timeout: 5_000 });

    // Verify it persisted to the server.
    const res = await request.get(`/api/v1/agents/${agent.id}/media`, {
      headers: { Authorization: `Bearer ${process.env.AUTH_TOKEN ?? "dev-token"}` },
    });
    const body = (await res.json()) as { files: Array<{ seen?: boolean }> };
    expect(body.files[0].seen).toBe(true);
  });
});
