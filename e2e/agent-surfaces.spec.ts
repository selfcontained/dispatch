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
      ],
      footer: {
        actions: [
          {
            id: "canary",
            label: "Use canary",
            intent: "choose_canary",
            style: "primary",
          },
        ],
      },
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
          id: "release-details",
          type: "section",
          title: "Release details",
          collapse: { initiallyCollapsed: true },
          blocks: [
            {
              id: "release-items",
              type: "list",
              title: "Release work",
              style: "check",
              showItemCount: true,
              collapse: { after: 2, label: "Show all release work" },
              items: [
                {
                  id: "schema",
                  text: "Finalize schema",
                  status: "Complete",
                  tone: "success",
                  checked: true,
                  group: "Completed",
                },
                {
                  id: "migration",
                  text: "Apply migration",
                  status: "Needs approval",
                  tone: "warning",
                  group: "Next steps",
                  url: "https://example.com/runbooks/migration",
                  actions: [
                    {
                      id: "queue-migration",
                      label: "Queue migration",
                      intent: "queue_release_migration",
                    },
                  ],
                },
                {
                  id: "a11y",
                  text: "Accessibility review",
                  status: "Blocked by prototype",
                  tone: "danger",
                  group: "Next steps",
                },
                {
                  id: "notes",
                  text: "Publish release notes",
                  status: "Not started",
                  tone: "neutral",
                  group: "Next steps",
                },
              ],
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
                {
                  id: "r1",
                  cells: { name: "Build", state: "done", risk: "low" },
                },
                {
                  id: "r2",
                  cells: { name: "Deploy", state: "blocked", risk: "high" },
                  actions: [
                    {
                      id: "retry-deploy",
                      label: "Retry deploy",
                      intent: "retry_release_deploy",
                    },
                  ],
                },
              ],
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
      const withSlots = document as { footer?: unknown; header?: unknown };
      await pool.query(
        `INSERT INTO agent_surfaces (id, agent_id, title, icon, sort_order, schema_version, header, blocks, footer)
         VALUES ($1, $2, $3, $4, $5, 2, $6::jsonb, $7::jsonb, $8::jsonb)`,
        [
          document.id,
          agentId,
          document.title,
          document.icon,
          sortOrder,
          withSlots.header ? JSON.stringify(withSlots.header) : null,
          JSON.stringify(document.blocks),
          withSlots.footer ? JSON.stringify(withSlots.footer) : null,
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

async function resolveItemInteraction(
  agentId: string,
  surfaceId: string,
  itemId: string,
  outcomeMessage: string
): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString)
    throw new Error(
      "DATABASE_URL is required to resolve surface interactions."
    );

  const pool = new Pool({ connectionString, max: 1 });
  try {
    const result = await pool.query(
      `UPDATE agent_surface_interactions
       SET status = 'completed', outcome_message = $4, resolved_at = NOW()
       WHERE agent_id = $1 AND surface_id = $2 AND payload->>'itemId' = $3`,
      [agentId, surfaceId, itemId, outcomeMessage]
    );
    expect(result.rowCount).toBe(1);
  } finally {
    await pool.end();
  }
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
        '[data-slot-actions="footer"] [data-testid="interaction-status-caption"]'
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

    // Progress block with no explicit tone renders a neutral fill — color
    // is reserved for explicitly authored states, and the saturated hues
    // would read as interactive.
    const progressBar = sidebar.locator(
      '[data-block-type="progress"] [role="progressbar"] > div'
    );
    await expect(progressBar).toHaveClass(/bg-foreground\/40/);

    const releaseDetails = sidebar.getByRole("button", {
      name: "Release details",
    });
    await expect(releaseDetails).toHaveAttribute("aria-expanded", "false");
    await releaseDetails.click();
    await expect(releaseDetails).toHaveAttribute("aria-expanded", "true");

    // Table column badgeVariants apply per-value tones to badge cells.
    const table = sidebar.locator('[data-block-type="table"]');
    await expect(table.getByText("done")).toHaveClass(/text-status-working/);
    await expect(table.getByText("blocked")).toHaveClass(/text-status-blocked/);

    // Rows align on the vertical middle and the disclosure reveals the
    // secondary columns without breaking the left alignment spine.
    const primaryCell = table.locator("tbody tr").first().locator("td").nth(1);
    await expect(primaryCell).toHaveCSS("vertical-align", "middle");
    await table.getByRole("button", { name: "Show details" }).first().click();
    const detailCell = table.locator("tbody tr").nth(1).locator("td");
    await expect(detailCell.locator("dl > div").first()).toBeVisible();

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

  test("submits and resolves item actions across expanded v2 list and table fixtures", async ({
    page,
    request,
  }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-agent-surfaces-v2-${Date.now()}`,
      cwd: process.cwd(),
    });
    await seedSurfaces(agent.id);
    await loadApp(page);
    await clickAgentRow(page, agent.id);
    await page.getByTestId("toggle-media-sidebar").click();

    const sidebar = page.getByTestId("media-sidebar");
    await sidebar
      .getByTestId("surface-tab-row")
      .getByRole("button", { name: "Release work" })
      .click();

    const releaseDetails = sidebar.getByRole("button", {
      name: "Release details",
    });
    await expect(releaseDetails).toHaveAttribute("aria-expanded", "false");
    await releaseDetails.click();
    await expect(releaseDetails).toHaveAttribute("aria-expanded", "true");

    const list = sidebar.locator('[data-block-id="release-items"]');
    // The list's header includes its authored total, while only its first two
    // rows render initially. This prevents a long status list from taking over
    // the sidebar without hiding the amount of outstanding work.
    await expect(list.getByText("Release work", { exact: true })).toBeVisible();
    await expect(list.getByText("(4)", { exact: true })).toBeVisible();
    await expect(list.locator("[data-item-id]")).toHaveCount(2);
    await expect(list.getByText("Completed", { exact: true })).toBeVisible();
    await expect(list.getByText("Next steps", { exact: true })).toBeVisible();
    await expect(list.locator('[data-check-state="checked"]')).toHaveCount(1);
    await expect(list.locator('[data-check-state="unchecked"]')).toHaveCount(1);
    const approvalBadge = list.getByText("Needs approval", { exact: true });
    await expect(approvalBadge).toHaveClass(/text-status-waiting/);
    const migrationLink = list.getByRole("link", {
      name: /Apply migration/,
    });
    await expect(migrationLink).toHaveAttribute(
      "href",
      "https://example.com/runbooks/migration"
    );

    const expandList = list.getByRole("button", {
      name: "Show all release work",
    });
    await expect(expandList).toHaveAttribute("aria-expanded", "false");
    await expandList.click();
    await expect(
      list.getByRole("button", { name: "Show less" })
    ).toHaveAttribute("aria-expanded", "true");
    await expect(list.locator("[data-item-id]")).toHaveCount(4);
    await expect(list.getByText("Blocked by prototype")).toBeVisible();
    await list.getByRole("button", { name: "Show less" }).click();
    await expect(list.locator("[data-item-id]")).toHaveCount(2);

    const queueMigration = list.getByRole("button", {
      name: "Queue migration",
    });
    await queueMigration.click();
    await expect(queueMigration).toBeDisabled();
    const listCaption = list
      .getByTestId("interaction-status-caption")
      .filter({ hasText: /Queued|Sent to the agent|In progress/ });
    await expect(listCaption).toHaveAttribute("data-caption-kind", "pending");
    await expect
      .poll(() => unresolvedCount(request, agent.id, "Release work"))
      .toBe(1);

    // Resolve out-of-band as the owning agent would, then reload to prove the
    // settled treatment hydrates from the durable record rather than local UI
    // mutation state.
    await resolveItemInteraction(
      agent.id,
      `${agent.id}-work`,
      "migration",
      "Migration has been scheduled."
    );
    await page.reload({ waitUntil: "domcontentloaded" });
    const reloadedSidebar = page.getByTestId("media-sidebar");
    await reloadedSidebar
      .getByTestId("surface-tab-row")
      .getByRole("button", { name: "Release work" })
      .click();
    await reloadedSidebar
      .getByRole("button", { name: "Release details" })
      .click();
    const resolvedList = reloadedSidebar.locator(
      '[data-block-id="release-items"]'
    );
    await resolvedList
      .getByRole("button", { name: "Show all release work" })
      .click();
    await expect(
      resolvedList.getByText("Migration has been scheduled.")
    ).toBeVisible();
    await expect(
      resolvedList.getByTestId("interaction-status-caption")
    ).toHaveAttribute("data-caption-kind", "outcome");

    const table = reloadedSidebar.locator('[data-block-id="status-table"]');
    await table.getByRole("button", { name: "Retry deploy" }).click();
    await expect(
      table.getByRole("button", { name: "Retry deploy" })
    ).toBeDisabled();
    await expect
      .poll(() => unresolvedCount(request, agent.id, "Release work"))
      .toBe(1);
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
