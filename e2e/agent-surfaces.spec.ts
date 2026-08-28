import { expect, test, type APIRequestContext } from "@playwright/test";
import { Pool } from "pg";

import {
  authHeaders,
  cleanupE2EAgents,
  clickAgentRow,
  createAgentViaAPI,
  loadApp,
} from "./helpers";

const API = "/api/v1";

async function seedSurfaces(agentId: string): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString)
    throw new Error("DATABASE_URL is required to seed surfaces.");

  const documents = [
    {
      id: `${agentId}-decision`,
      title: "Release choice",
      icon: "flag",
      blocks: [
        {
          id: "status",
          type: "status",
          status: "Ready for decision",
          tone: "info",
          detail: "Both paths passed CI.",
        },
        {
          id: "actions",
          type: "actions",
          actions: [
            {
              id: "canary",
              label: "Use canary",
              intent: "choose_canary",
              style: "primary",
            },
          ],
        },
      ],
    },
    {
      id: `${agentId}-feedback`,
      title: "Review feedback",
      icon: "form",
      blocks: [
        {
          id: "feedback",
          type: "form",
          title: "What should change?",
          fields: [
            {
              id: "decision",
              type: "radio",
              label: "Overall direction",
              required: true,
              options: [
                {
                  value: "approve",
                  label: "Keep this direction",
                  description: "Proceed with the current approach.",
                },
                { value: "revise", label: "Revise it" },
              ],
            },
            {
              id: "notes",
              type: "textarea",
              label: "Specific notes",
              required: true,
              minLength: 5,
            },
          ],
          submit: {
            id: "submit",
            label: "Send feedback",
            intent: "submit_feedback",
            style: "primary",
          },
          submitMode: "repeatable",
        },
      ],
    },
    {
      id: `${agentId}-work`,
      title: "Release work",
      icon: "checklist",
      blocks: [
        {
          // No `tone` — exercises the default-tone-renders-success behavior.
          id: "progress",
          type: "progress",
          value: 5,
          max: 8,
          label: "5 of 8 complete",
        },
        {
          id: "status-table",
          type: "table",
          columns: [
            { id: "name", label: "Item" },
            {
              id: "state",
              label: "State",
              format: "badge",
              badgeVariants: { done: "success", blocked: "danger" },
            },
            {
              id: "risk",
              label: "Risk",
              format: "badge",
              priority: "secondary",
              badgeVariants: { low: "success", high: "danger" },
            },
          ],
          rows: [
            { id: "r1", cells: { name: "Build", state: "done", risk: "low" } },
            {
              id: "r2",
              cells: { name: "Deploy", state: "blocked", risk: "high" },
            },
          ],
        },
      ],
    },
    // Two more lightweight tabs so the strip has more than a handful of
    // custom tabs — enough to require horizontal scrolling rather than
    // fitting uncapped in a narrow sidebar.
    {
      id: `${agentId}-extra-1`,
      title: "Extra tab one",
      icon: "sparkles",
      blocks: [{ id: "status", type: "status", status: "Nominal" }],
    },
    {
      id: `${agentId}-extra-2`,
      title: "Extra tab two",
      icon: "sparkles",
      blocks: [{ id: "status", type: "status", status: "Nominal" }],
    },
  ];

  const pool = new Pool({ connectionString, max: 1 });
  try {
    for (const [sortOrder, document] of documents.entries()) {
      await pool.query(
        `INSERT INTO agent_surfaces (id, agent_id, title, icon, sort_order, blocks)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [
          document.id,
          agentId,
          document.title,
          document.icon,
          sortOrder,
          JSON.stringify(document.blocks),
        ]
      );
    }
  } finally {
    await pool.end();
  }
}

async function unresolvedCount(
  request: APIRequestContext,
  agentId: string,
  title: string
): Promise<number> {
  const response = await request.get(`${API}/agents/${agentId}/surfaces`, {
    headers: authHeaders(),
  });
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as {
    surfaces: Array<{ title: string; unresolvedInteractionCount: number }>;
  };
  return (
    body.surfaces.find((surface) => surface.title === title)
      ?.unresolvedInteractionCount ?? 0
  );
}

test.describe("Agent-authored sidebar surfaces", () => {
  test.afterAll(async ({ request }) => {
    await cleanupE2EAgents(request);
  });

  test("renders, submits durable interactions, and persists user tab order", async ({
    page,
    request,
  }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-agent-surfaces-${Date.now()}`,
      cwd: process.cwd(),
    });
    await seedSurfaces(agent.id);
    await loadApp(page);
    await clickAgentRow(page, agent.id);
    await page.getByTestId("toggle-media-sidebar").click();

    const sidebar = page.getByTestId("media-sidebar");
    const tabRow = sidebar.getByTestId("surface-tab-row");

    // All 5 custom tabs render directly — no 3-tab cap collapsing the rest
    // into the overflow menu; the strip scrolls horizontally instead.
    await expect(tabRow.getByTestId("surface-tab-button")).toHaveCount(5);

    await tabRow.getByRole("button", { name: "Release choice" }).click();
    await expect(sidebar.getByText("Ready for decision")).toBeVisible();

    // Status block reads as a non-interactive readout, not a button/input:
    // a tone dot plus text, no bordered/boxed container.
    const statusRoot = sidebar.locator('[data-block-type="status"] > div');
    await expect(statusRoot.locator(".rounded-full").first()).toBeVisible();
    await expect(async () => {
      const borderWidth = await statusRoot.evaluate(
        (el) => getComputedStyle(el).borderTopWidth
      );
      expect(borderWidth).toBe("0px");
    }).toPass();

    const canaryButton = sidebar.getByRole("button", { name: "Use canary" });
    await canaryButton.click();
    // The caption is driven by the durable interaction record, so assert on
    // its kind rather than one exact status word — the server may already
    // have moved queued -> notified -> claimed by the time this runs.
    const canaryCaption = sidebar
      .locator(
        '[data-block-type="actions"] [data-testid="interaction-status-caption"]'
      )
      .first();
    await expect(canaryCaption).toBeVisible();
    await expect(canaryCaption).toHaveAttribute("data-caption-kind", "pending");
    await expect(canaryCaption).toHaveText(
      /Queued|Sent to the agent|In progress/
    );
    // Still unresolved server-side, so the action must stay disabled — this
    // is what stops a second click from queueing a duplicate.
    await expect(canaryButton).toBeDisabled();
    await expect
      .poll(() => unresolvedCount(request, agent.id, "Release choice"))
      .toBe(1);

    await tabRow.getByRole("button", { name: "Review feedback" }).click();
    await sidebar.getByRole("radio", { name: "Keep this direction" }).check();
    const selectedRadioRow = sidebar
      .getByRole("radio", { name: "Keep this direction" })
      .locator("xpath=ancestor::*[@data-choice-option][1]");
    const radioCenterDelta = await selectedRadioRow.evaluate((row) => {
      const input = row.querySelector("input")!.getBoundingClientRect();
      const label = row.querySelector("label > span")!.getBoundingClientRect();
      return Math.abs(
        input.y + input.height / 2 - (label.y + label.height / 2)
      );
    });
    expect(radioCenterDelta).toBeLessThanOrEqual(1);
    await sidebar
      .getByRole("textbox", { name: /Specific notes/ })
      .fill("Keep the compact vertical-sidebar hierarchy.");
    await sidebar.getByRole("button", { name: "Send feedback" }).click();
    await expect
      .poll(() => unresolvedCount(request, agent.id, "Review feedback"))
      .toBe(1);

    await tabRow.getByRole("button", { name: "Release work" }).click();
    await expect(sidebar.getByText("5 of 8 complete")).toBeVisible();

    // Progress block with no explicit tone renders success (green), not
    // neutral gray.
    const progressBar = sidebar.locator(
      '[data-block-type="progress"] [role="progressbar"] > div'
    );
    await expect(progressBar).toHaveClass(/bg-status-working/);

    // Table column badgeVariants apply per-value tones to badge cells.
    const table = sidebar.locator('[data-block-type="table"]');
    await expect(table.getByText("done")).toHaveClass(/text-status-working/);
    await expect(table.getByText("blocked")).toHaveClass(/text-status-blocked/);

    // Primary and disclosure rows use symmetric cell padding and center their
    // contents, including mixed text/badge detail lines.
    const primaryCell = table.locator("tbody tr").first().locator("td").nth(1);
    await expect(primaryCell).toHaveCSS("vertical-align", "middle");
    await expect(primaryCell).toHaveCSS("padding", "8px");
    await table.getByRole("button", { name: "Show details" }).first().click();
    const detailCell = table.locator("tbody tr").nth(1).locator("td");
    await expect(detailCell).toHaveCSS("vertical-align", "middle");
    await expect(detailCell).toHaveCSS("padding", "8px");
    await expect(detailCell.locator("dl > div")).toHaveCSS(
      "align-items",
      "center"
    );

    await tabRow.getByTestId("surface-tabs-more").click();
    const releaseRow = page
      .getByTestId("manage-tab-row")
      .filter({ hasText: "Release choice" });
    await releaseRow.getByRole("button", { name: "Move tab later" }).click();
    await expect(tabRow.getByTestId("surface-tab-button").nth(0)).toContainText(
      "Review feedback"
    );

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(tabRow.getByTestId("surface-tab-button").nth(0)).toContainText(
      "Review feedback"
    );

    await tabRow.getByRole("button", { name: "Review feedback" }).click();
    await tabRow.getByTestId("surface-tabs-more").click();
    const activeReviewRow = page
      .getByTestId("manage-tab-row")
      .filter({ hasText: "Review feedback" });
    await activeReviewRow.getByRole("button", { name: "Hide tab" }).click();
    await page.keyboard.press("Escape");
    await expect(
      tabRow.getByRole("button", { name: /Release choice/ })
    ).toHaveAttribute("aria-current", "true");
    await expect(sidebar.getByText("Ready for decision")).toBeVisible();
    await expect(
      tabRow.getByRole("button", { name: "Review feedback" })
    ).toHaveCount(0);

    // Selecting a hidden tab from the manage menu unhides it (so content
    // is never active with nothing shown as selected in the strip) and
    // closes the menu.
    await tabRow.getByTestId("surface-tabs-more").click();
    const menuContent = page.getByTestId("manage-tab-row").first();
    await expect(menuContent).toBeVisible();
    await page
      .getByTestId("manage-tab-row")
      .filter({ hasText: "Review feedback" })
      .getByText("Review feedback")
      .click();
    await expect(menuContent).toBeHidden();
    await expect(
      tabRow.getByRole("button", { name: "Review feedback" })
    ).toHaveAttribute("aria-current", "true");
    await expect(
      sidebar.getByRole("radio", { name: "Keep this direction" })
    ).toBeVisible();

    // Selecting a visible tab from the manage menu also closes it.
    await tabRow.getByTestId("surface-tabs-more").click();
    await expect(menuContent).toBeVisible();
    await page
      .getByTestId("manage-tab-row")
      .filter({ hasText: "Release work" })
      .getByText("Release work")
      .click();
    await expect(menuContent).toBeHidden();
    await expect(sidebar.getByText("5 of 8 complete")).toBeVisible();

    // Start with the right-most active tab in the desktop-width strip. A
    // mobile resize/open must re-scroll it into the narrower visible strip.
    await tabRow.getByRole("button", { name: "Extra tab two" }).click();
    await expect(
      tabRow.getByRole("button", { name: "Extra tab two" })
    ).toHaveAttribute("aria-current", "true");

    // Reload so this exercises a persisted active tab, not only a selection
    // made during the same component lifetime.
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(
      page
        .getByTestId("media-sidebar")
        .getByRole("button", { name: "Extra tab two" })
    ).toHaveAttribute("aria-current", "true");

    await page.setViewportSize({ width: 390, height: 844 });
    const mobileSidebar = page.getByRole("dialog", { name: "Media sidebar" });
    const sidebarInViewport = () =>
      mobileSidebar.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return rect.left < window.innerWidth && rect.right > 0;
      });
    if (!(await sidebarInViewport())) {
      await page.getByTestId("toggle-media-sidebar").click();
    }
    await expect.poll(sidebarInViewport).toBe(true);
    const visibleTabRow = mobileSidebar.getByTestId("surface-tab-row");
    // The management overflow control stays reachable at narrow widths...
    await expect(visibleTabRow.getByTestId("surface-tabs-more")).toBeVisible();
    // ...the outer row never grows past the viewport (no page-level
    // horizontal overflow)...
    await expect
      .poll(() =>
        visibleTabRow.evaluate(
          (element) => element.scrollWidth <= element.clientWidth
        )
      )
      .toBe(true);
    // ...while the inner tab strip scrolls horizontally to reach tabs that
    // don't fit, instead of hiding them behind a 3-tab cap.
    const scrollStrip = visibleTabRow.getByTestId("surface-tab-scroll");
    await expect
      .poll(() =>
        scrollStrip.evaluate(
          (element) => element.scrollWidth > element.clientWidth
        )
      )
      .toBe(true);
    await expect
      .poll(() =>
        scrollStrip.evaluate(
          (element) => getComputedStyle(element).scrollbarWidth
        )
      )
      .toBe("none");
    await expect(scrollStrip.getByTestId("surface-tab-button")).toHaveCount(5);
    const activeTab = scrollStrip.getByRole("button", {
      name: "Extra tab two",
    });
    await expect(activeTab).toHaveAttribute("aria-current", "true");
    await expect
      .poll(() =>
        activeTab.evaluate((button) => {
          const strip = button.parentElement;
          if (!strip) return false;
          const buttonBounds = button.getBoundingClientRect();
          const stripBounds = strip.getBoundingClientRect();
          return (
            buttonBounds.left >= stripBounds.left - 1 &&
            buttonBounds.right <= stripBounds.right + 1
          );
        })
      )
      .toBe(true);

    // The tab strip stays compact on desktop but gives touch users 44px
    // targets, including the overflow and menu action controls.
    await expect
      .poll(() =>
        activeTab.evaluate((button) => button.getBoundingClientRect().height)
      )
      .toBeGreaterThanOrEqual(44);
    const moreTabsButton = visibleTabRow.getByTestId("surface-tabs-more");
    await expect
      .poll(() =>
        moreTabsButton.evaluate(
          (button) => button.getBoundingClientRect().height
        )
      )
      .toBeGreaterThanOrEqual(44);
    await moreTabsButton.click();
    const firstManageRow = page.getByTestId("manage-tab-row").first();
    await expect
      .poll(() =>
        firstManageRow
          .getByRole("button", { name: "Move tab later" })
          .evaluate((button) => {
            const bounds = button.getBoundingClientRect();
            return Math.min(bounds.width, bounds.height);
          })
      )
      .toBeGreaterThanOrEqual(44);
    await page.keyboard.press("Escape");

    // The active tab was selected before the desktop-to-mobile resize; it
    // should still be selected and readable without a second click.
    await expect(mobileSidebar.getByText("Nominal")).toBeVisible();
  });

  test("manage-tabs menu supports keyboard navigation between row controls", async ({
    page,
    request,
  }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-agent-surfaces-kbd-${Date.now()}`,
      cwd: process.cwd(),
    });
    await seedSurfaces(agent.id);
    await loadApp(page);
    await clickAgentRow(page, agent.id);
    await page.getByTestId("toggle-media-sidebar").click();

    const sidebar = page.getByTestId("media-sidebar");
    const tabRow = sidebar.getByTestId("surface-tab-row");
    await expect(tabRow.getByTestId("surface-tab-button")).toHaveCount(5);

    const trigger = tabRow.getByTestId("surface-tabs-more");
    // Simulate a keyboard user already tabbed to the trigger, then opening
    // it with the keyboard (not a click).
    await trigger.focus();
    await page.keyboard.press("Enter");

    const firstRow = page
      .getByTestId("manage-tab-row")
      .filter({ hasText: "Release choice" });
    await expect(firstRow).toBeVisible();

    // Opening moves focus into the popover, onto its first focusable
    // control — the row's own "select tab" button (Radix DropdownMenu's
    // menuitem-only roving focus previously left plain per-row buttons like
    // this keyboard-unreachable).
    await expect(firstRow.getByText("Release choice")).toBeFocused();

    // "Move tab earlier" is disabled on the first row, so plain browser Tab
    // order skips it and lands on "Move tab later" — proving Tab moves
    // between the row's several independent controls, not just menu items.
    await page.keyboard.press("Tab");
    await expect(
      firstRow.getByRole("button", { name: "Move tab later" })
    ).toBeFocused();

    await page.keyboard.press("Tab");
    const hideButton = firstRow.getByRole("button", { name: "Hide tab" });
    await expect(hideButton).toBeFocused();

    // The focused control is keyboard-activatable, not just clickable.
    await page.keyboard.press("Enter");
    await expect(
      firstRow.getByRole("button", { name: "Show tab" })
    ).toBeFocused();

    // Escape closes the popover and returns focus to the trigger.
    await page.keyboard.press("Escape");
    await expect(firstRow).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test("keeps tab controls touch-sized at coarse-pointer desktop widths", async ({
    browser,
    request,
  }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-agent-surfaces-touch-${Date.now()}`,
      cwd: process.cwd(),
    });
    await seedSurfaces(agent.id);

    const protocol = process.env.TLS_CERT ? "https" : "http";
    const baseURL = `${protocol}://127.0.0.1:${process.env.E2E_PORT ?? "8788"}`;
    const context = await browser.newContext({
      baseURL,
      hasTouch: true,
      ignoreHTTPSErrors: true,
      viewport: { width: 900, height: 844 },
    });
    const touchPage = await context.newPage();
    try {
      await loadApp(touchPage);
      await clickAgentRow(touchPage, agent.id);
      await touchPage.getByTestId("toggle-media-sidebar").click();

      expect(
        await touchPage.evaluate(() => matchMedia("(pointer: coarse)").matches)
      ).toBe(true);
      const tabRow = touchPage.getByTestId("surface-tab-row");
      const tab = tabRow.getByTestId("surface-tab-button").first();
      const more = tabRow.getByTestId("surface-tabs-more");
      await expect
        .poll(() => tab.evaluate((node) => node.getBoundingClientRect().height))
        .toBeGreaterThanOrEqual(44);
      await expect
        .poll(() =>
          more.evaluate((node) => node.getBoundingClientRect().height)
        )
        .toBeGreaterThanOrEqual(44);

      await more.click();
      const moveLater = touchPage
        .getByTestId("manage-tab-row")
        .first()
        .getByRole("button", { name: "Move tab later" });
      await expect
        .poll(() =>
          moveLater.evaluate((node) => {
            const bounds = node.getBoundingClientRect();
            return Math.min(bounds.width, bounds.height);
          })
        )
        .toBeGreaterThanOrEqual(44);
    } finally {
      await context.close();
    }
  });
});
