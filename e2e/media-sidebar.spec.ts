import { expect, test, type Page } from "@playwright/test";

import { cleanupE2EAgents, createAgentViaAPI, loadApp, setAgentPinsViaDB, uploadMediaViaAPI } from "./helpers";

async function openMediaSidebarForAgent(page: Page, agent: { id: string; name: string }) {
  await page.getByText(agent.name, { exact: true }).click();
  await expect(page.getByTestId(`agent-card-${agent.id}`)).toHaveClass(/bg-muted\/60/);
  const toggle = page.getByTestId("toggle-media-sidebar");
  await expect(toggle).toBeVisible();
  await toggle.evaluate((el) => (el as HTMLButtonElement).click());
}

test.describe("Media sidebar", () => {
  test.afterAll(async ({ request }) => {
    await cleanupE2EAgents(request);
  });

  test("refreshes cached media when switching back to an agent", async ({ page, request }) => {
    const firstAgent = await createAgentViaAPI(request, { name: `e2e-agent-media-a-${Date.now()}` });
    const secondAgent = await createAgentViaAPI(request, { name: `e2e-agent-media-b-${Date.now()}` });

    await uploadMediaViaAPI(request, firstAgent.id, "First image", "first-image.png");

    await loadApp(page);

    await openMediaSidebarForAgent(page, firstAgent);

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

    await openMediaSidebarForAgent(page, agent);

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
    await openMediaSidebarForAgent(page, agent);

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
    const workspaceRoot = process.cwd();
    const agent = await createAgentViaAPI(request, { name: `e2e-agent-pins-${Date.now()}`, cwd: workspaceRoot });
    await setAgentPinsViaDB(agent.id, [
      { label: "Notes", type: "string", value: "line 1\n\n  line 2" },
      {
        label: "Summary",
        type: "markdown",
        value: "**Status**\n- Ready for review\n- URL: https://example.com/visible\n- Branch: `feat/log-rotation`\n- Owner: **Dispatch**\n- Marker: 🚀\n- Step: validate in sidebar\n- Step: keep lines wrapped\n\n```sh\npnpm run check\npnpm run test\npnpm run finalize:web\npnpm run test:e2e\nnpm run lint || true\n```",
      },
      { label: "Files", type: "filename", value: "one.ts,\ntwo.ts\nthree.ts" },
      { label: "Workspace root", type: "filename", value: workspaceRoot },
      { label: "Long file", type: "filename", value: `${workspaceRoot}/apps/web/src/components/app/pins-panel.tsx` },
      { label: "Ports", type: "port", value: "3000 4000,\n5000" },
      { label: "API", type: "url", value: "http://127.0.0.1:8788/api/v1/agents?view=full&tab=pins" },
      { label: "PR", type: "pr", value: "https://github.com/selfcontained/dispatch/pull/123" },
      { label: "Review", type: "pr", value: "Review queue" },
      { label: "Agent ID", type: "code", value: "DISPATCH_AGENT_ID=agt_123" },
    ]);

    await loadApp(page);

    await openMediaSidebarForAgent(page, agent);

    const mediaSidebar = page.getByTestId("media-sidebar");
    await expect(mediaSidebar).toBeVisible();

    const notesPre = mediaSidebar.locator("[data-pin-label='Notes'] pre");
    await expect(notesPre).toHaveText("line 1\n\n  line 2");

    const markdownPin = mediaSidebar.locator("[data-pin-label='Summary'] [data-testid='markdown-pin-body']");
    await expect(markdownPin.getByText("Status", { exact: true })).toBeVisible();
    await expect(markdownPin.locator("strong").first()).toHaveText("Status");
    await expect(markdownPin.getByText("Ready for review", { exact: true })).toBeVisible();
    await expect(markdownPin).toContainText("https://example.com/visible");
    await expect(markdownPin.getByText("feat/log-rotation", { exact: true })).toBeVisible();
    await expect(markdownPin).toContainText("pnpm run check");
    await expect(markdownPin).toContainText("pnpm run test");
    await expect(markdownPin.getByRole("link")).toHaveCount(0);

    const scrollMetrics = await mediaSidebar.locator("[data-pin-label='Summary'] [data-testid='markdown-pin-scroll']").evaluate((el) => {
      const container = el as HTMLElement;
      return { clientHeight: container.clientHeight, scrollHeight: container.scrollHeight };
    });
    expect(scrollMetrics).not.toBeNull();
    expect(scrollMetrics!.scrollHeight).toBeGreaterThan(scrollMetrics!.clientHeight);

    await expect(mediaSidebar.getByText("one.ts", { exact: true })).toBeVisible();
    await expect(mediaSidebar.getByText("two.ts", { exact: true })).toBeVisible();
    await expect(mediaSidebar.getByText("three.ts", { exact: true })).toBeVisible();
    const workspaceRootPin = mediaSidebar.locator("[data-pin-label='Workspace root']");
    await expect(workspaceRootPin).toContainText("./");
    await workspaceRootPin.locator("div").nth(1).hover();
    await expect(page.getByRole("tooltip")).toContainText(workspaceRoot);
    const longFilePin = mediaSidebar.locator("[data-pin-label='Long file']");
    await expect(longFilePin).toContainText("pins-panel.tsx");
    await expect(longFilePin).toContainText("apps/web/src/components/app/pins-panel.tsx");
    await expect(longFilePin).not.toContainText(workspaceRoot);
    await expect(longFilePin).not.toContainText("pins-panel.tsx/");
    await expect(mediaSidebar.getByText("3000", { exact: true })).toBeVisible();
    await expect(mediaSidebar.getByText("4000", { exact: true })).toBeVisible();
    await expect(mediaSidebar.getByText("5000", { exact: true })).toBeVisible();
    await expect(mediaSidebar.getByRole("link", { name: "http://127.0.0.1:8788/api/v1/agents?view=full&tab=pins" })).toBeVisible();
    await expect(mediaSidebar.getByRole("link", { name: "selfcontained/dispatch#123" })).toBeVisible();
    await expect(mediaSidebar.getByText("Review queue", { exact: true })).toBeVisible();
    await expect(mediaSidebar.getByText("DISPATCH_AGENT_ID=agt_123", { exact: true })).toBeVisible();
  });
});
