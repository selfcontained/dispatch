import { expect, test } from "@playwright/test";

import { cleanupE2EAgents, createAgentViaAPI, loadApp, setAgentPinsViaDB, uploadMediaViaAPI } from "./helpers";

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

    // Switch to Media tab (sidebar defaults to Pins tab)
    await mediaSidebar.getByRole("button", { name: "Media" }).click();
    await expect(mediaSidebar.getByText("First image")).toBeVisible();

    await page.getByText(secondAgent.name, { exact: true }).click();
    // Agent switch resets to Pins tab — switch back to Media
    await mediaSidebar.getByRole("button", { name: "Media" }).click();
    await uploadMediaViaAPI(request, firstAgent.id, "Second image", "second-image.png");
    await page.getByText(firstAgent.name, { exact: true }).click();
    // Agent switch resets to Pins tab again
    await mediaSidebar.getByRole("button", { name: "Media" }).click();

    await expect(mediaSidebar.getByText("Second image")).toBeVisible({ timeout: 10_000 });
  });

  test("navigates between fullscreen media items", async ({ page, request }) => {
    const agent = await createAgentViaAPI(request, { name: `e2e-agent-lightbox-${Date.now()}` });

    await uploadMediaViaAPI(request, agent.id, "First image", "first-image.png");
    await uploadMediaViaAPI(request, agent.id, "Second image", "second-image.png");

    await loadApp(page);

    await page.getByText(agent.name, { exact: true }).click();
    await page.getByTestId("toggle-media-sidebar").click();

    const mediaSidebar = page.getByTestId("media-sidebar");
    await mediaSidebar.getByRole("button", { name: "Media" }).click();

    await mediaSidebar.getByRole("button", { name: "Second image" }).click();

    const lightbox = page.getByTestId("media-lightbox");
    await expect(lightbox).toBeVisible();
    await expect(lightbox).toContainText("1/2");
    await expect(lightbox).toContainText("Second image");

    await page.getByTestId("media-lightbox-next").click();
    await expect(lightbox).toContainText("2/2");
    await expect(lightbox).toContainText("First image");

    await page.getByTestId("media-lightbox-prev").click();
    await expect(lightbox).toContainText("1/2");
    await expect(lightbox).toContainText("Second image");

    await page.keyboard.press("ArrowRight");
    await expect(lightbox).toContainText("2/2");

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
    await mediaSidebar.getByRole("button", { name: "Media" }).click();

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

  test("preserves string pin whitespace and splits filename pins", async ({ page, request }) => {
    const agent = await createAgentViaAPI(request, { name: `e2e-agent-pins-${Date.now()}` });
    await setAgentPinsViaDB(agent.id, [
      { label: "Notes", type: "string", value: "line 1\n\n  line 2" },
      { label: "Files", type: "filename", value: "one.ts,\ntwo.ts\nthree.ts" },
      { label: "Ports", type: "port", value: "3000 4000,\n5000" },
      { label: "API", type: "url", value: "http://127.0.0.1:8788/api/v1/agents?view=full&tab=pins" },
      { label: "PR", type: "pr", value: "https://github.com/selfcontained/dispatch/pull/123" },
      { label: "Review", type: "pr", value: "Review queue" },
      { label: "Agent ID", type: "code", value: "DISPATCH_AGENT_ID=agt_123" },
    ]);

    await loadApp(page);

    await page.getByText(agent.name, { exact: true }).click();
    await page.getByTestId("toggle-media-sidebar").click();

    const mediaSidebar = page.getByTestId("media-sidebar");
    await expect(mediaSidebar).toBeVisible();

    const notesText = await mediaSidebar.locator("pre").textContent();
    expect(notesText).toBe("line 1\n\n  line 2");

    await expect(mediaSidebar.getByText("one.ts", { exact: true })).toBeVisible();
    await expect(mediaSidebar.getByText("two.ts", { exact: true })).toBeVisible();
    await expect(mediaSidebar.getByText("three.ts", { exact: true })).toBeVisible();
    await expect(mediaSidebar.getByText("3000", { exact: true })).toBeVisible();
    await expect(mediaSidebar.getByText("4000", { exact: true })).toBeVisible();
    await expect(mediaSidebar.getByText("5000", { exact: true })).toBeVisible();
    await expect(mediaSidebar.getByRole("link", { name: "http://127.0.0.1:8788/api/v1/agents?view=full&tab=pins" })).toBeVisible();
    await expect(mediaSidebar.getByRole("link", { name: "selfcontained/dispatch#123" })).toBeVisible();
    await expect(mediaSidebar.getByText("Review queue", { exact: true })).toBeVisible();
    await expect(mediaSidebar.getByText("DISPATCH_AGENT_ID=agt_123", { exact: true })).toBeVisible();
  });
});
