import { expect, test } from "@playwright/test";
import { authHeaders, cleanupE2EAgents, createAgentViaAPI } from "./helpers";

test.use({ deviceScaleFactor: 2 });
test.afterEach(async ({ request }) => cleanupE2EAgents(request));

for (const width of [1280, 390]) {
  test(`sidebar schedules update parent and child fallbacks (${width})`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const parent = await createAgentViaAPI(request, {
      name: `Sidebar schedules ${Date.now()}`,
    });
    const child = await createAgentViaAPI(request, {
      name: "Scheduled child",
      parentAgentId: parent.id,
    });
    let summaryReads = 0;
    page.on("request", (request) => {
      if (request.url().endsWith("/api/v1/scheduled-messages/upcoming"))
        summaryReads++;
    });
    await page.goto(`/agents/${parent.id}`, { waitUntil: "domcontentloaded" });
    if (width < 640) await page.getByTitle("Open sidebar").click();
    const toggle = page.getByTestId(`agent-expand-toggle-${parent.id}`);
    await expect(page.getByTestId("chat-composer-input")).toBeVisible();
    if (
      !(await toggle.locator("svg").getAttribute("class"))?.includes(
        "rotate-180"
      )
    )
      await toggle.click();
    await expect(page.getByTestId(`child-agent-row-${child.id}`)).toBeVisible();
    const parentLine = page.getByTestId(
      `agent-scheduled-activity-${parent.id}`
    );
    const childLine = page.getByTestId(`agent-scheduled-activity-${child.id}`);
    await expect(parentLine).toHaveCount(0);
    await expect(childLine).toHaveCount(0);
    const waitForExpandedCard = async () => {
      await expect
        .poll(() =>
          page.getByTestId(`child-agent-row-${child.id}`).evaluate((row) => {
            const card = row.closest('[data-testid^="agent-card-"]')!;
            return (
              row.getBoundingClientRect().bottom <=
              card.getBoundingClientRect().bottom
            );
          })
        )
        .toBe(true);
    };
    await waitForExpandedCard();
    await page.screenshot({
      animations: "disabled",
      path: `/tmp/sidebar-schedules-empty-${width}.png`,
    });
    const create = async (agentId: string, minutes: number) => {
      const response = await request.post(
        `/api/v1/agents/${agentId}/scheduled-messages`,
        {
          headers: authHeaders(),
          data: {
            title: `Reminder ${minutes}`,
            message: "Check progress",
            deliver_at: new Date(Date.now() + minutes * 60000).toISOString(),
          },
        }
      );
      expect(response.ok()).toBeTruthy();
      return response.json();
    };
    const later = await create(parent.id, 30);
    await expect(parentLine.locator("time")).toHaveAttribute(
      "datetime",
      later.nextDueAt
    );
    const earlier = await create(parent.id, 20);
    const childSchedule = await create(child.id, 25);
    await expect(parentLine.locator("time")).toHaveAttribute(
      "datetime",
      earlier.nextDueAt
    );
    await expect(childLine.locator("time")).toHaveAttribute(
      "datetime",
      childSchedule.nextDueAt
    );
    await expect(parentLine).toHaveClass(/text-heading-accent-1/);
    await expect(childLine).toHaveClass(/text-heading-accent-1/);
    const change = async (id: string, action: string) => {
      const response = await request.post(
        `/api/v1/agents/${parent.id}/scheduled-messages/${id}`,
        { headers: authHeaders(), data: { action } }
      );
      expect(response.ok()).toBeTruthy();
    };
    await change(earlier.id, "pause");
    await expect(parentLine.locator("time")).toHaveAttribute(
      "datetime",
      later.nextDueAt
    );
    await change(earlier.id, "resume");
    await expect(parentLine.locator("time")).toHaveAttribute(
      "datetime",
      earlier.nextDueAt
    );
    await page.getByTestId(`agent-expand-toggle-${parent.id}`).click();
    await expect(childLine).toHaveCount(0);
    const readsBeforeExpand = summaryReads;
    await page.getByTestId(`agent-expand-toggle-${parent.id}`).click();
    await expect(childLine).toBeVisible();
    expect(summaryReads).toBe(readsBeforeExpand);
    await waitForExpandedCard();
    await page.screenshot({
      animations: "disabled",
      path: `/tmp/sidebar-schedules-active-${width}.png`,
    });
    await change(earlier.id, "cancel");
    await change(later.id, "cancel");
    await expect(parentLine).toHaveCount(0);
    await expect(childLine).toBeVisible();
  });
}
