import { expect, test } from "@playwright/test";

import {
  cleanupE2EAgents,
  createAgentViaAPI,
  seedReviewAgentFixtureViaDB,
} from "./helpers";

async function waitForAppShell(
  page: import("@playwright/test").Page
): Promise<void> {
  await page.getByTestId("agent-sidebar").waitFor({ state: "visible" });
  await page.getByTestId("terminal-pane").waitFor({ state: "visible" });
}

test.describe("Review agent UI", () => {
  test.afterEach(async ({ request }) => cleanupE2EAgents(request));

  test("shows lightweight review agents and opens their submitted review", async ({
    page,
    request,
  }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-agent-${Date.now()}`,
      cwd: process.cwd(),
      useWorktree: false,
    });
    const fixture = await seedReviewAgentFixtureViaDB(agent.id);

    await page.goto(`/agents/${agent.id}`, { waitUntil: "domcontentloaded" });
    await waitForAppShell(page);

    for (const reviewerId of [
      fixture.activeAgentId,
      fixture.openReviewAgentId,
      fixture.approvedAgentId,
    ]) {
      await expect(
        page.getByTestId(`agent-card-${reviewerId}`)
      ).not.toBeVisible();
      await expect(
        page.getByTestId(`child-agent-row-${reviewerId}`)
      ).toBeVisible();
    }
    await expect(
      page.getByTestId(`agent-card-${fixture.standardChildAgentId}`)
    ).toBeVisible();
    await expect(page.getByText("Sub Agents", { exact: true })).toBeVisible();
    await expect(
      page.locator('[data-agent-role="review"]').getByText("Review", {
        exact: true,
      })
    ).toHaveCount(3);
    await expect(
      page.getByTestId(`child-agent-row-${fixture.activeAgentId}`)
    ).toHaveAttribute("data-review-active", "true");
    await expect(
      page.getByTestId(`child-agent-row-${fixture.openReviewAgentId}`)
    ).toHaveAttribute("data-review-active", "false");

    await page
      .getByTestId(`child-agent-open-review-${fixture.openReviewAgentId}`)
      .click();
    await expect(page).toHaveURL(
      new RegExp(`expandReview=${fixture.openReviewId}`)
    );
    await expect(
      page.getByText("Found one actionable loading-state issue.")
    ).toBeVisible();
  });

  test("launcher uses the unified single-pass review flow", async ({
    page,
    request,
  }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-agent-${Date.now()}`,
      cwd: process.cwd(),
      useWorktree: false,
    });

    await page.goto(`/agents/${agent.id}`, { waitUntil: "domcontentloaded" });
    await waitForAppShell(page);
    await page.getByTestId("launch-reviewer-button").click();
    await expect(
      page.getByRole("heading", { name: "Launch Review" })
    ).toBeVisible();
    await expect(
      page.getByText(
        "The reviewer will submit one tracked review, with follow-up discussion kept in its feedback item threads."
      )
    ).toBeVisible();
    await expect(
      page.getByText(/follow-up verification pass/i)
    ).not.toBeVisible();
    await expect(
      page.getByTestId("launch-reviewer-allow-recheck")
    ).not.toBeVisible();
  });

  test("launcher keeps the dialog open when review launch fails", async ({
    page,
    request,
  }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-agent-${Date.now()}`,
      cwd: process.cwd(),
      useWorktree: false,
    });
    await page.route(
      `**/api/v1/agents/${agent.id}/launch-review`,
      async (route) => {
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({
            error: "Launch review failed on the server.",
          }),
        });
      }
    );

    await page.goto(`/agents/${agent.id}`, { waitUntil: "domcontentloaded" });
    await waitForAppShell(page);
    await page.getByTestId("launch-reviewer-button").click();
    await page
      .getByTestId("launch-reviewer-persona-architecture-review")
      .click();
    await page.getByTestId("launch-reviewer-submit").click();

    await expect(page.getByTestId("launch-reviewer-error")).toHaveText(
      "Launch review failed on the server."
    );
    await expect(
      page.getByRole("heading", { name: "Launch Review" })
    ).toBeVisible();
  });
});
