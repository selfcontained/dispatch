import { test, expect } from "@playwright/test";

import { cleanupE2EAgents, createAgentViaAPI, loadApp, setAgentLatestEventViaAPI } from "./helpers";

test.describe("Header overflow", () => {
  test.afterEach(async ({ request }) => {
    await cleanupE2EAgents(request);
  });

  test("long agent status messages stay constrained inside the header", async ({ page, request }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-agent-${Date.now()}`,
    });
    const longMessage =
      "This is a deliberately long agent description used to verify the header keeps its width constrained and truncates the message instead of letting the layout grow past the viewport width while a session is attached and actively reporting status updates.";

    await setAgentLatestEventViaAPI(request, agent.id, { type: "working", message: longMessage });
    await loadApp(page);

    const agentCard = page.getByTestId(`agent-card-${agent.id}`);
    await agentCard.waitFor({ state: "visible", timeout: 10_000 });
    await page.getByTestId(`agent-row-${agent.id}`).click();

    const status = page.getByTestId("app-header-status");
    await expect(status).toBeVisible({ timeout: 10_000 });
    await expect(status).toHaveAttribute("title", longMessage);
    await expect(status).toContainText("This is a deliberately long agent description");

    const dimensions = await page.evaluate(() => {
      const header = document.querySelector("[data-testid='app-header']");
      const statusText = document.querySelector("[data-testid='app-header-status']");
      const main = document.querySelector("main");
      const statusRect = statusText?.getBoundingClientRect();
      return {
        viewportWidth: window.innerWidth,
        documentScrollWidth: document.documentElement.scrollWidth,
        headerWidth: header?.getBoundingClientRect().width ?? 0,
        headerScrollWidth: header?.scrollWidth ?? 0,
        mainWidth: main?.getBoundingClientRect().width ?? 0,
        statusClientWidth: statusText?.clientWidth ?? 0,
        statusScrollWidth: statusText?.scrollWidth ?? 0,
        statusClientHeight: statusText?.clientHeight ?? 0,
        statusScrollHeight: statusText?.scrollHeight ?? 0,
        statusHeight: statusRect?.height ?? 0,
        lineClamp: statusText ? window.getComputedStyle(statusText).webkitLineClamp : null
      };
    });

    expect(dimensions.documentScrollWidth).toBeLessThanOrEqual(dimensions.viewportWidth);
    expect(dimensions.headerWidth).toBeLessThanOrEqual(dimensions.mainWidth);
    expect(dimensions.headerScrollWidth).toBeLessThanOrEqual(dimensions.headerWidth);
    expect(dimensions.lineClamp).toBe("2");
    expect(dimensions.statusHeight).toBeGreaterThan(20);
    expect(
      dimensions.statusScrollWidth > dimensions.statusClientWidth ||
      dimensions.statusScrollHeight > dimensions.statusClientHeight
    ).toBeTruthy();
  });
});
