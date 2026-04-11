import { test, expect } from "@playwright/test";

import { cleanupE2EAgents, createAgentViaAPI, loadApp, setAgentLatestEventViaAPI } from "./helpers";

test.describe("Chrome overflow", () => {
  test.afterEach(async ({ request }) => {
    await cleanupE2EAgents(request);
  });

  test("long agent status messages do not recreate a dedicated header row", async ({ page, request }) => {
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
      const main = document.querySelector("main");
      return {
        viewportWidth: window.innerWidth,
        documentScrollWidth: document.documentElement.scrollWidth,
        mainWidth: main?.getBoundingClientRect().width ?? 0,
        topPadding: Number.parseFloat(window.getComputedStyle(main ?? document.body).paddingTop || "0"),
        headerNodeCount: document.querySelectorAll("[data-testid='app-header']").length,
      };
    });

    await expect(page.getByTestId("app-header")).toHaveCount(0);

    expect(dimensions.documentScrollWidth).toBeLessThanOrEqual(dimensions.viewportWidth);
    expect(dimensions.mainWidth).toBeGreaterThan(0);
    expect(dimensions.topPadding).toBe(0);
    expect(dimensions.headerNodeCount).toBe(0);
  });
});
