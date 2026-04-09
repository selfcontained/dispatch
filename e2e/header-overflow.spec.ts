import { test, expect } from "@playwright/test";

import { cleanupE2EAgents, createAgentViaAPI, loadApp, setAgentLatestEventViaAPI } from "./helpers";

test.describe("Header overflow", () => {
  test.afterEach(async ({ request }) => {
    await cleanupE2EAgents(request);
  });

  test("long agent status messages do not appear inside the slim terminal header", async ({ page, request }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-agent-${Date.now()}`,
    });
    const longMessage =
      "This is a deliberately long agent description used to verify that status text no longer reserves a dedicated header row or pushes the terminal layout beyond the viewport width while a session is attached and actively reporting status updates.";

    await setAgentLatestEventViaAPI(request, agent.id, { type: "working", message: longMessage });
    await loadApp(page);

    const agentCard = page.getByTestId(`agent-card-${agent.id}`);
    await agentCard.waitFor({ state: "visible", timeout: 10_000 });
    await page.getByTestId(`agent-row-${agent.id}`).click();

    const dimensions = await page.evaluate(() => {
      const header = document.querySelector("[data-testid='app-header']");
      const statusText = document.querySelector("[data-testid='app-header-status']");
      const main = document.querySelector("main");
      return {
        viewportWidth: window.innerWidth,
        documentScrollWidth: document.documentElement.scrollWidth,
        headerWidth: header?.getBoundingClientRect().width ?? 0,
        mainWidth: main?.getBoundingClientRect().width ?? 0,
        statusNodeCount: statusText ? 1 : 0,
      };
    });

    await expect(page.getByTestId("app-header")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("app-header-status")).toHaveCount(0);

    expect(dimensions.documentScrollWidth).toBeLessThanOrEqual(dimensions.viewportWidth);
    expect(dimensions.headerWidth).toBeLessThanOrEqual(dimensions.mainWidth);
    expect(dimensions.statusNodeCount).toBe(0);
  });
});
