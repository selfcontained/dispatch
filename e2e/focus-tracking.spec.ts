import { test, expect, type Page } from "@playwright/test";
import { createAgentViaAPI, loadApp } from "./helpers";

const authHeader = { Authorization: `Bearer ${process.env.AUTH_TOKEN ?? "dev-token"}` };

test.describe("Focus tracking API", () => {
  test("POST /api/v1/focus accepts a valid agentId", async ({ request }) => {
    const agent = await createAgentViaAPI(request);
    const res = await request.post("/api/v1/focus", {
      headers: authHeader,
      data: { agentId: agent.id },
    });
    expect(res.status()).toBe(204);
  });

  test("POST /api/v1/focus accepts null agentId", async ({ request }) => {
    const res = await request.post("/api/v1/focus", {
      headers: authHeader,
      data: { agentId: null },
    });
    expect(res.status()).toBe(204);
  });

  test("POST /api/v1/focus rejects empty string agentId", async ({ request }) => {
    const res = await request.post("/api/v1/focus", {
      headers: authHeader,
      data: { agentId: "" },
    });
    expect(res.status()).toBe(400);
  });

  test("POST /api/v1/focus accepts missing agentId (treated as null)", async ({ request }) => {
    const res = await request.post("/api/v1/focus", {
      headers: authHeader,
      data: {},
    });
    expect(res.status()).toBe(204);
  });
});

async function simulatePageActive(page: Page): Promise<void> {
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      writable: true,
      configurable: true,
    });
    Object.defineProperty(document, "hidden", {
      value: false,
      writable: true,
      configurable: true,
    });
    // Override hasFocus to return true (headless browsers return false)
    document.hasFocus = () => true;
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
  });
}

async function simulatePageHidden(page: Page): Promise<void> {
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      value: "hidden",
      writable: true,
      configurable: true,
    });
    Object.defineProperty(document, "hidden", {
      value: true,
      writable: true,
      configurable: true,
    });
    document.hasFocus = () => false;
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

test.describe("Focus tracking frontend", () => {
  test("sends focus heartbeat when agent is selected and page is active", async ({
    page,
    request,
  }) => {
    const agent = await createAgentViaAPI(request);

    // Set up route intercept BEFORE loading the app
    const focusRequests: Array<{ agentId: string | null }> = [];
    await page.route("**/api/v1/focus", async (route) => {
      const postData = route.request().postDataJSON() as { agentId: string | null };
      focusRequests.push(postData);
      await route.fulfill({ status: 204 });
    });

    await loadApp(page);

    // Override hasFocus before selecting agent (headless = false by default)
    await page.evaluate(() => {
      document.hasFocus = () => true;
    });

    // Select the agent — this triggers the useAgentFocus hook
    await page.getByText(agent.name).click();

    // The hook fires immediately on effect run when page is active
    await page.waitForTimeout(1500);

    expect(focusRequests.length).toBeGreaterThanOrEqual(1);
    const focusRequest = focusRequests.find((r) => r.agentId === agent.id);
    expect(focusRequest).toBeDefined();
  });

  test("sends null focus when page becomes hidden", async ({ page, request }) => {
    const agent = await createAgentViaAPI(request);

    const focusRequests: Array<{ agentId: string | null }> = [];
    await page.route("**/api/v1/focus", async (route) => {
      const postData = route.request().postDataJSON() as { agentId: string | null };
      focusRequests.push(postData);
      await route.fulfill({ status: 204 });
    });

    await loadApp(page);
    await page.evaluate(() => { document.hasFocus = () => true; });

    // Select the agent to start focus tracking
    await page.getByText(agent.name).click();
    await page.waitForTimeout(1000);

    // Verify we got an initial focus report
    expect(focusRequests.some((r) => r.agentId === agent.id)).toBe(true);

    // Clear to isolate the hidden event
    focusRequests.length = 0;

    // Simulate page going hidden
    await simulatePageHidden(page);
    await page.waitForTimeout(500);

    const nullRequest = focusRequests.find((r) => r.agentId === null);
    expect(nullRequest).toBeDefined();
  });

  test("resumes focus heartbeat when page becomes visible again", async ({
    page,
    request,
  }) => {
    const agent = await createAgentViaAPI(request);

    const focusRequests: Array<{ agentId: string | null }> = [];
    await page.route("**/api/v1/focus", async (route) => {
      const postData = route.request().postDataJSON() as { agentId: string | null };
      focusRequests.push(postData);
      await route.fulfill({ status: 204 });
    });

    await loadApp(page);
    await page.evaluate(() => { document.hasFocus = () => true; });
    await page.getByText(agent.name).click();
    await page.waitForTimeout(1000);

    // Go hidden
    await simulatePageHidden(page);
    await page.waitForTimeout(500);

    // Clear to isolate the visible event
    focusRequests.length = 0;

    // Come back
    await simulatePageActive(page);
    await page.waitForTimeout(500);

    const resumedRequest = focusRequests.find((r) => r.agentId === agent.id);
    expect(resumedRequest).toBeDefined();
  });
});
