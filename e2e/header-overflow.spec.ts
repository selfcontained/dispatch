import { test, expect } from "@playwright/test";

import {
  cleanupE2EAgents,
  clickAgentRow,
  createAgentViaAPI,
  loadApp,
} from "./helpers";

test.describe("Chrome overflow", () => {
  test.afterEach(async ({ request }) => {
    await cleanupE2EAgents(request);
  });

  test("agent selection does not recreate a dedicated header row", async ({
    page,
    request,
  }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-agent-${Date.now()}`,
    });
    await loadApp(page);

    const agentCard = page.getByTestId(`agent-card-${agent.id}`);
    await agentCard.waitFor({ state: "visible", timeout: 10_000 });
    await clickAgentRow(page, agent.id);

    const dimensions = await page.evaluate(() => {
      const main = document.querySelector("main");
      return {
        viewportWidth: window.innerWidth,
        documentScrollWidth: document.documentElement.scrollWidth,
        mainWidth: main?.getBoundingClientRect().width ?? 0,
        topPadding: Number.parseFloat(
          window.getComputedStyle(main ?? document.body).paddingTop || "0"
        ),
        headerNodeCount: document.querySelectorAll("[data-testid='app-header']")
          .length,
      };
    });

    await expect(page.getByTestId("app-header")).toHaveCount(0);

    expect(dimensions.documentScrollWidth).toBeLessThanOrEqual(
      dimensions.viewportWidth
    );
    expect(dimensions.mainWidth).toBeGreaterThan(0);
    expect(dimensions.topPadding).toBe(0);
    expect(dimensions.headerNodeCount).toBe(0);
  });
});
