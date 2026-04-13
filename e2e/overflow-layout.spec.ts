import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";

import {
  cleanupE2EAgents,
  createAgentViaAPI,
  loadApp,
  setAgentLatestEventViaAPI,
  setAgentPinsViaDB,
  uploadMediaViaAPI,
} from "./helpers";

const AUTH_HEADERS = {
  Authorization: `Bearer ${process.env.AUTH_TOKEN ?? "dev-token"}`,
  "Content-Type": "application/json",
};

type ScrollMetrics = {
  clientHeight: number;
  scrollHeight: number;
  scrollTop: number;
};

async function createJobViaAPI(
  request: APIRequestContext,
  name: string,
  directory: string,
  schedule = "*/30 * * * *"
): Promise<void> {
  const res = await request.post("/api/v1/jobs", {
    headers: AUTH_HEADERS,
    data: {
      name,
      directory,
      prompt: `Overflow validation job ${name}.`,
      schedule,
      timeoutMs: 120000,
      needsInputTimeoutMs: 86400000,
    },
  });

  expect(res.ok(), `Failed to create job ${name}: ${await res.text()}`).toBeTruthy();
}

async function getScrollMetrics(locator: Locator): Promise<ScrollMetrics> {
  return locator.evaluate((el) => {
    const element = el as HTMLElement;
    return {
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      scrollTop: element.scrollTop,
    };
  });
}

async function expectOverflow(locator: Locator): Promise<void> {
  await expect.poll(async () => {
    const { clientHeight, scrollHeight } = await getScrollMetrics(locator);
    return scrollHeight - clientHeight;
  }).toBeGreaterThan(40);
}

async function scrollToBottom(locator: Locator): Promise<void> {
  await locator.evaluate((el) => {
    const element = el as HTMLElement;
    element.scrollTop = element.scrollHeight;
  });
}

async function getWindowScrollY(page: Page): Promise<number> {
  return page.evaluate(() => window.scrollY);
}

async function seedOverflowAgents(request: APIRequestContext, count: number): Promise<Array<{ id: string; name: string }>> {
  const created = await Promise.all(
    Array.from({ length: count }, async (_, index) => {
      const agent = await createAgentViaAPI(request, {
        name: `e2e-agent-overflow-${Date.now()}-${index}`,
        cwd: process.cwd(),
      });
      await setAgentLatestEventViaAPI(request, agent.id, {
        type: "working",
        message: `Overflow validation task ${index + 1}`,
      });
      return agent;
    })
  );

  return created;
}

test.describe("Overflow layout", () => {
  test.afterAll(async ({ request }) => {
    await cleanupE2EAgents(request);
  });

  test("agents workspace keeps sidebar, media, and terminal overflow isolated", async ({ page, request }) => {
    const agents = await seedOverflowAgents(request, 24);
    const focusAgent = agents[0]!;

    await setAgentPinsViaDB(
      focusAgent.id,
      Array.from({ length: 24 }, (_, index) => ({
        label: `Overflow pin ${index + 1}`,
        type: "string" as const,
        value: `Pinned value ${index + 1}\n${"detail ".repeat(18)}`,
      }))
    );

    await Promise.all(
      Array.from({ length: 14 }, (_, index) =>
        uploadMediaViaAPI(request, focusAgent.id, `Overflow media item ${index + 1}`, `overflow-media-${index + 1}.png`)
      )
    );

    await loadApp(page);
    await page.getByText(focusAgent.name, { exact: true }).click();
    await page.getByTestId("toggle-media-sidebar").click();

    const agentSidebarScroll = page.getByTestId("agent-sidebar-scroll");
    const pinsPanelScroll = page.getByTestId("pins-panel-scroll");
    const terminalPane = page.getByTestId("terminal-pane");

    await expect(agentSidebarScroll).toBeVisible();
    await expect(pinsPanelScroll).toBeVisible();
    await expect(terminalPane).toBeVisible();
    await expect(page.getByTestId("jobs-button")).toBeVisible();

    await expectOverflow(agentSidebarScroll);
    await expectOverflow(pinsPanelScroll);

    const terminalBoxBefore = await terminalPane.boundingBox();
    expect(terminalBoxBefore).not.toBeNull();
    expect(terminalBoxBefore!.height).toBeGreaterThan(280);

    await scrollToBottom(agentSidebarScroll);
    await scrollToBottom(pinsPanelScroll);

    await expect
      .poll(async () => (await getScrollMetrics(agentSidebarScroll)).scrollTop)
      .toBeGreaterThan(0);
    await expect
      .poll(async () => (await getScrollMetrics(pinsPanelScroll)).scrollTop)
      .toBeGreaterThan(0);
    await expect.poll(async () => getWindowScrollY(page)).toBe(0);

    const terminalBoxAfterSidebarScroll = await terminalPane.boundingBox();
    expect(terminalBoxAfterSidebarScroll).not.toBeNull();
    expect(Math.abs(terminalBoxAfterSidebarScroll!.height - terminalBoxBefore!.height)).toBeLessThan(2);

    const mediaSidebar = page.getByTestId("media-sidebar");
    await mediaSidebar.getByRole("button", { name: "Media" }).click();

    const mediaPanelScroll = page.getByTestId("media-panel-scroll");
    await expect(mediaPanelScroll).toBeVisible();
    await expectOverflow(mediaPanelScroll);

    await scrollToBottom(mediaPanelScroll);

    await expect
      .poll(async () => (await getScrollMetrics(mediaPanelScroll)).scrollTop)
      .toBeGreaterThan(0);
    await expect.poll(async () => getWindowScrollY(page)).toBe(0);

    const terminalBoxAfterMediaScroll = await terminalPane.boundingBox();
    expect(terminalBoxAfterMediaScroll).not.toBeNull();
    expect(Math.abs(terminalBoxAfterMediaScroll!.height - terminalBoxBefore!.height)).toBeLessThan(2);
  });

  test("jobs page keeps sidebar overflow isolated from the shell", async ({ page, request }) => {
    const stamp = Date.now();

    await Promise.all(
      Array.from({ length: 24 }, (_, index) =>
        createJobViaAPI(
          request,
          `Overflow job ${stamp}-${index + 1}`,
          `/tmp/dispatch-overflow-jobs/${stamp}/${index + 1}`
        )
      )
    );

    await loadApp(page);
    await page.getByTestId("jobs-button").click();

    const jobsSidebar = page.getByTestId("jobs-sidebar");
    const jobsSidebarScroll = page.getByTestId("jobs-sidebar-scroll");

    await expect(jobsSidebar).toBeVisible();
    await expect(jobsSidebarScroll).toBeVisible();
    await expect(page.getByRole("heading", { name: "Jobs" })).toBeVisible();
    await expect(page.getByTestId("agents-button")).toBeVisible();
    await expect(page.getByTestId("settings-button")).toBeVisible();

    await expectOverflow(jobsSidebarScroll);
    await scrollToBottom(jobsSidebarScroll);

    await expect
      .poll(async () => (await getScrollMetrics(jobsSidebarScroll)).scrollTop)
      .toBeGreaterThan(0);
    await expect.poll(async () => getWindowScrollY(page)).toBe(0);
  });
});
