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

    await expect(
      page.getByTestId(`child-agent-row-${fixture.openReviewAgentId}`)
    ).toHaveAttribute("data-review-ready", "true");
    await expect(
      page.getByTestId(`child-agent-row-${fixture.activeAgentId}`)
    ).toHaveAttribute("data-review-ready", "false");

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
        "Each reviewer will submit one tracked review, with follow-up discussion kept in its feedback item threads."
      )
    ).toBeVisible();
    await expect(
      page.getByText(/follow-up verification pass/i)
    ).not.toBeVisible();
    await expect(
      page.getByTestId("launch-reviewer-allow-recheck")
    ).not.toBeVisible();
  });

  test("launcher submits every selected persona in one request", async ({
    page,
    request,
  }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-agent-${Date.now()}`,
      cwd: process.cwd(),
      useWorktree: false,
    });

    let launchBody: { personas?: string[]; model?: string | null } | null =
      null;
    await page.route(
      `**/api/v1/agents/${agent.id}/launch-review`,
      async (route) => {
        launchBody = route.request().postDataJSON();
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true }),
        });
      }
    );

    await page.goto(`/agents/${agent.id}`, { waitUntil: "domcontentloaded" });
    await waitForAppShell(page);
    await page.getByTestId("launch-reviewer-button").click();

    await page
      .getByTestId("launch-reviewer-persona-architecture-review")
      .click();
    await expect(page.getByTestId("launch-reviewer-submit")).toHaveText(
      "Launch Review"
    );
    await page
      .getByTestId("launch-reviewer-persona-backend-security-review")
      .click();
    await expect(page.getByTestId("launch-reviewer-selected-count")).toHaveText(
      "2 selected"
    );
    await expect(page.getByTestId("launch-reviewer-submit")).toHaveText(
      "Launch 2 Reviews"
    );

    // Deselecting is possible too: toggle one off and back on.
    await page
      .getByTestId("launch-reviewer-persona-architecture-review")
      .click();
    await expect(page.getByTestId("launch-reviewer-selected-count")).toHaveText(
      "1 selected"
    );
    await page
      .getByTestId("launch-reviewer-persona-architecture-review")
      .click();

    // The model select sits on the same row as the agent type select and
    // defaults to the CLI setting until one is picked.
    const modelSelect = page.getByTestId("launch-reviewer-model");
    await expect(modelSelect).toContainText("Default");
    await modelSelect.click();
    await page.getByRole("option", { name: "GPT-5.5", exact: true }).click();
    await expect(modelSelect).toContainText("GPT-5.5");

    await page.getByTestId("launch-reviewer-submit").click();
    await expect(
      page.getByRole("heading", { name: "Launch Review" })
    ).not.toBeVisible();

    expect(launchBody?.personas).toEqual([
      "backend-security-review",
      "architecture-review",
    ]);
    expect(launchBody?.model).toBe("gpt-5.5");
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
