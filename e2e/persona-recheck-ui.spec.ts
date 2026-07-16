import { expect, test } from "@playwright/test";

import {
  cleanupE2EAgents,
  createAgentViaAPI,
  seedPersonaRecheckFixtureViaDB,
} from "./helpers";

const AUTH_HEADER = {
  Authorization: `Bearer ${process.env.AUTH_TOKEN ?? "dev-token"}`,
};

async function waitForAppShell(
  page: import("@playwright/test").Page
): Promise<void> {
  await page.getByTestId("agent-sidebar").waitFor({ state: "visible" });
  await page.getByTestId("terminal-pane").waitFor({ state: "visible" });
}

test.describe("Persona recheck UI", () => {
  test.afterEach(async ({ request }) => {
    await cleanupE2EAgents(request);
  });

  test("shows lightweight review children without the retired lifecycle", async ({
    page,
    request,
  }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-agent-${Date.now()}`,
      cwd: process.cwd(),
      useWorktree: false,
    });
    const fixture = await seedPersonaRecheckFixtureViaDB(agent.id);

    await page.goto(`/agents/${agent.id}`, { waitUntil: "domcontentloaded" });
    await waitForAppShell(page);

    await expect(
      page.getByTestId(`agent-card-${fixture.round1AgentId}`)
    ).not.toBeVisible();
    await expect(
      page.getByTestId(`agent-card-${fixture.awaitingRecheckAgentId}`)
    ).not.toBeVisible();
    await expect(
      page.getByTestId(`agent-card-${fixture.round2AgentId}`)
    ).not.toBeVisible();
    await expect(
      page.getByTestId(`child-agent-row-${fixture.round1AgentId}`)
    ).toBeVisible();
    await expect(
      page.getByTestId(`child-agent-row-${fixture.awaitingRecheckAgentId}`)
    ).toBeVisible();
    await expect(
      page.getByTestId(`child-agent-row-${fixture.round2AgentId}`)
    ).toBeVisible();
    await expect(page.getByText("Sub Agents", { exact: true })).toBeVisible();
    await expect(
      page.locator('[data-agent-role="review"]').getByText("Review", {
        exact: true,
      })
    ).toHaveCount(3);
    await expect(page.getByText("R1", { exact: true })).not.toBeVisible();
    await expect(
      page.getByText("R2 pending", { exact: true })
    ).not.toBeVisible();
    await expect(page.getByText("Round 2 findings")).not.toBeVisible();

    await page.goto(
      `/agents/${agent.id}/review/${fixture.awaitingRecheckAgentId}`,
      { waitUntil: "domcontentloaded" }
    );
    await waitForAppShell(page);
    await expect(page).toHaveURL(new RegExp(`/agents/${agent.id}$`));
    await expect(page.getByText("Review Summary")).not.toBeVisible();
    await expect(page.getByTestId("cancel-recheck-button")).not.toBeVisible();
  });

  test("launcher does not show allowRecheck toggle (recheck is always on)", async ({
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
      page.getByTestId("launch-reviewer-allow-recheck")
    ).not.toBeVisible();
  });

  test("launcher shows an error when review launch fails", async ({
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
