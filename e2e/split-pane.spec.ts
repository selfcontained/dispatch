import { expect, test } from "@playwright/test";
import { cleanupE2EAgents, createAgentViaAPI } from "./helpers";

async function waitForAppShell(
  page: import("@playwright/test").Page,
  agentName: string
): Promise<void> {
  await page.getByTestId("agent-sidebar").waitFor({ state: "visible" });
  await page.getByTestId("terminal-pane").waitFor({ state: "visible" });
  await page
    .getByTestId("agent-sidebar")
    .getByText(agentName)
    .first()
    .waitFor({ state: "visible" });
}

/** Seed split-pane state directly in localStorage — deterministic, avoids
 * flaky HTML5 drag simulation in headless CI. */
async function seedSplitState(
  page: import("@playwright/test").Page,
  agentId: string
): Promise<void> {
  await page.evaluate((id) => {
    window.localStorage.setItem(
      `dispatch:splitPane:${id}`,
      JSON.stringify({
        mode: "split",
        left: "terminal",
        right: "changes",
        sizes: [50, 50],
      })
    );
  }, agentId);
}

test.describe("Split pane", () => {
  test.afterEach(async ({ request }) => {
    await cleanupE2EAgents(request);
  });

  test("split state persists across page reload", async ({ page, request }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-split-persist-${Date.now()}`,
    });

    await page.goto(`/agents/${agent.id}`, { waitUntil: "domcontentloaded" });
    await waitForAppShell(page, agent.name);

    // Sanity check: starts in single-pane mode.
    await expect(page.getByTestId("unsplit-button")).not.toBeVisible();

    await seedSplitState(page, agent.id);
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForAppShell(page, agent.name);

    // Split mode should be restored from localStorage.
    await expect(page.getByTestId("unsplit-button")).toBeVisible({
      timeout: 5000,
    });
    await expect(page.getByTestId("terminal-pane")).toBeVisible();
  });

  test("unsplit button exits split mode", async ({ page, request }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-split-unsplit-${Date.now()}`,
    });

    await page.goto(`/agents/${agent.id}`, { waitUntil: "domcontentloaded" });
    await waitForAppShell(page, agent.name);

    await seedSplitState(page, agent.id);
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForAppShell(page, agent.name);

    const unsplitBtn = page.getByTestId("unsplit-button");
    await expect(unsplitBtn).toBeVisible({ timeout: 5000 });

    // While split, both tabs are rendered as panes — tab bar is empty.
    await expect(page.getByTestId("center-tab-terminal")).not.toBeVisible();
    await expect(page.getByTestId("center-tab-changes")).not.toBeVisible();

    await unsplitBtn.click();

    await expect(unsplitBtn).not.toBeVisible();
    await expect(page.getByTestId("center-tab-terminal")).toBeVisible();
    await expect(page.getByTestId("center-tab-changes")).toBeVisible();
  });

  test("tab bar hides tabs that are currently in split panes", async ({
    page,
    request,
  }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-split-tabbar-${Date.now()}`,
    });

    await page.goto(`/agents/${agent.id}`, { waitUntil: "domcontentloaded" });
    await waitForAppShell(page, agent.name);

    // Before splitting, both tabs are visible in the center bar.
    await expect(page.getByTestId("center-tab-terminal")).toBeVisible();
    await expect(page.getByTestId("center-tab-changes")).toBeVisible();

    await seedSplitState(page, agent.id);
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForAppShell(page, agent.name);
    await expect(page.getByTestId("unsplit-button")).toBeVisible({
      timeout: 5000,
    });

    // Terminal and Changes are both placed in split panes (left + right),
    // so neither appears as a tab in the center bar.
    await expect(page.getByTestId("center-tab-terminal")).not.toBeVisible();
    await expect(page.getByTestId("center-tab-changes")).not.toBeVisible();
  });

  test("tabs work normally after exiting split mode", async ({
    page,
    request,
  }) => {
    // With only two center tabs (terminal/changes), a split always places
    // both of them in panes, leaving the tab bar empty — so there is no
    // visible tab to click "while split" to exercise the exitSplit() path
    // through the tab bar's onClick handler. Instead, verify that once
    // split mode is exited, the tab bar is restored and switching between
    // tabs navigates as expected.
    const agent = await createAgentViaAPI(request, {
      name: `e2e-split-tabswitch-${Date.now()}`,
    });

    await page.goto(`/agents/${agent.id}`, { waitUntil: "domcontentloaded" });
    await waitForAppShell(page, agent.name);

    await seedSplitState(page, agent.id);
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForAppShell(page, agent.name);

    const unsplitBtn = page.getByTestId("unsplit-button");
    await expect(unsplitBtn).toBeVisible({ timeout: 5000 });
    await unsplitBtn.click();
    await expect(unsplitBtn).not.toBeVisible();

    const terminalTab = page.getByTestId("center-tab-terminal");
    const changesTab = page.getByTestId("center-tab-changes");
    await expect(terminalTab).toBeVisible();
    await expect(changesTab).toBeVisible();

    await changesTab.click();
    await expect(page).toHaveURL(new RegExp(`/agents/${agent.id}/changes$`));
    await expect(changesTab).toHaveAttribute("aria-selected", "true");

    await terminalTab.click();
    await expect(page).toHaveURL(new RegExp(`/agents/${agent.id}$`));
    await expect(terminalTab).toHaveAttribute("aria-selected", "true");
  });

  test("split mode is ignored on mobile viewport", async ({
    page,
    request,
  }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-split-mobile-${Date.now()}`,
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/agents/${agent.id}`, { waitUntil: "domcontentloaded" });
    await waitForAppShell(page, agent.name);

    // Seed split state in localStorage — on mobile this should be ignored.
    await seedSplitState(page, agent.id);
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForAppShell(page, agent.name);

    // The unsplit button should NOT appear — mobile forces single-pane mode.
    await expect(page.getByTestId("unsplit-button")).not.toBeVisible();
    // Terminal pane should still be visible in single-pane mode.
    await expect(page.getByTestId("terminal-pane")).toBeVisible();
  });

  test("drag tab to split and unsplit via button", async ({
    page,
    request,
  }) => {
    // Supplementary coverage for the drag-and-drop entry path. Playwright's
    // mouse-based locator.dragTo() simulates real OS-level mouse movement,
    // which is flaky for HTML5 drag-and-drop (dragstart/dragover/drop) in
    // headless Chromium — it depends on timing of intermediate mousemoves
    // producing dragover events. Dispatching native DragEvents directly is
    // deterministic and avoids that flakiness, so it's used here instead.
    // The localStorage-injection tests above remain the primary, reliable
    // coverage for split-mode entry/exit — this test only exercises the
    // drag interaction itself.
    const agent = await createAgentViaAPI(request, {
      name: `e2e-split-drag-${Date.now()}`,
    });

    await page.goto(`/agents/${agent.id}`, { waitUntil: "domcontentloaded" });
    await waitForAppShell(page, agent.name);

    const changesTab = page.getByTestId("center-tab-changes");
    await expect(changesTab).toBeVisible();

    // Step 1: dragstart on the "Changes" tab — populates a DataTransfer
    // with the drag MIME type, stashed on window for later steps.
    await page.evaluate(() => {
      const source = document.querySelector(
        '[data-testid="center-tab-changes"]'
      ) as HTMLElement;
      const rect = source.getBoundingClientRect();
      const dt = new DataTransfer();
      (window as unknown as { __e2eDragDt: DataTransfer }).__e2eDragDt = dt;
      const event = new DragEvent("dragstart", {
        bubbles: true,
        cancelable: true,
        clientX: rect.x + rect.width / 2,
        clientY: rect.y + rect.height / 2,
      });
      Object.defineProperty(event, "dataTransfer", { value: dt });
      source.dispatchEvent(event);
    });

    // Step 2: dragenter/dragover on the content area — flips isDraggingTab
    // to true, which mounts the split drop zone overlay.
    await page.evaluate(() => {
      const dt = (window as unknown as { __e2eDragDt: DataTransfer })
        .__e2eDragDt;
      // Content area: two levels up from terminal-pane — past the
      // tab-content wrapper to the container with the onDragOver handler.
      const contentArea = document.querySelector(
        '[data-testid="terminal-pane"]'
      )?.parentElement?.parentElement as HTMLElement;
      const rect = contentArea.getBoundingClientRect();
      for (const type of ["dragenter", "dragover"]) {
        const event = new DragEvent(type, {
          bubbles: true,
          cancelable: true,
          clientX: rect.x + rect.width * 0.75,
          clientY: rect.y + rect.height / 2,
        });
        Object.defineProperty(event, "dataTransfer", { value: dt });
        contentArea.dispatchEvent(event);
      }
    });

    const dropRight = page.getByTestId("split-drop-right");
    await expect(dropRight).toBeVisible({ timeout: 3000 });

    // Step 3: dragover + drop on the right drop zone.
    await page.evaluate(() => {
      const dt = (window as unknown as { __e2eDragDt: DataTransfer })
        .__e2eDragDt;
      const zone = document.querySelector(
        '[data-testid="split-drop-right"]'
      ) as HTMLElement;
      const rect = zone.getBoundingClientRect();
      const clientX = rect.x + rect.width / 2;
      const clientY = rect.y + rect.height / 2;
      for (const type of ["dragover", "drop"]) {
        const event = new DragEvent(type, {
          bubbles: true,
          cancelable: true,
          clientX,
          clientY,
        });
        Object.defineProperty(event, "dataTransfer", { value: dt });
        zone.dispatchEvent(event);
      }
    });

    const unsplitBtn = page.getByTestId("unsplit-button");
    await expect(unsplitBtn).toBeVisible({ timeout: 3000 });

    await unsplitBtn.click();
    await expect(unsplitBtn).not.toBeVisible();

    await expect(page.getByTestId("center-tab-terminal")).toBeVisible();
    await expect(page.getByTestId("center-tab-changes")).toBeVisible();
  });
});
