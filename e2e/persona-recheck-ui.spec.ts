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

  test("renders round badges, round 2 grouping, and cancel recheck", async ({
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
      page
        .getByTestId(`agent-card-${fixture.round1AgentId}`)
        .getByText("R1", { exact: true })
    ).toBeVisible();
    await expect(
      page
        .getByTestId(`agent-card-${fixture.awaitingRecheckAgentId}`)
        .getByText("R2 pending", { exact: true })
    ).toBeVisible();
    await expect(
      page
        .getByTestId(`agent-card-${fixture.awaitingRecheckAgentId}`)
        .getByText("Rechecking")
    ).toBeVisible();
    await expect(
      page
        .getByTestId(`agent-card-${fixture.round2AgentId}`)
        .getByText("R2", { exact: true })
    ).toBeVisible();

    await expect(page.getByText("Round 2 findings")).toBeVisible();

    const original = page.getByRole("button", {
      name: /The retry loop bypasses the circuit breaker on the cache-miss path/i,
    });
    const followup = page.getByRole("button", {
      name: /Round 2: fallback retries still skip the breaker/i,
    });
    await expect(original).toBeVisible();
    await expect(followup).toBeVisible();

    const [originalBox, followupBox] = await Promise.all([
      original.boundingBox(),
      followup.boundingBox(),
    ]);
    expect(originalBox).not.toBeNull();
    expect(followupBox).not.toBeNull();
    expect(followupBox!.x).toBeGreaterThan(originalBox!.x);

    await page.goto(
      `/agents/${agent.id}/review/${fixture.awaitingRecheckAgentId}`,
      { waitUntil: "domcontentloaded" }
    );
    await waitForAppShell(page);
    await expect(page.getByText("Review Summary")).toBeVisible();
    const cancelButton = page.getByTestId("cancel-recheck-button");
    await expect(cancelButton).toBeVisible();

    page.once("dialog", (dialog) => dialog.accept());
    await cancelButton.click();
    await expect(cancelButton).not.toBeVisible();
  });

  test("launcher opt-in sends allowRecheck through the launch route", async ({
    page,
    request,
  }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-agent-${Date.now()}`,
      cwd: process.cwd(),
      useWorktree: false,
    });
    let launchRouteCalls = 0;
    let lastLaunchPayload: unknown = null;
    page.on("request", (req) => {
      if (
        req.method() === "POST" &&
        req.url().includes(`/api/v1/agents/${agent.id}/launch-review`)
      ) {
        launchRouteCalls += 1;
        try {
          lastLaunchPayload = req.postDataJSON();
        } catch {
          lastLaunchPayload = null;
        }
      }
    });

    await page.goto(`/agents/${agent.id}`, { waitUntil: "domcontentloaded" });
    await waitForAppShell(page);

    await page.getByTestId("launch-reviewer-button").click();
    await expect(
      page.getByRole("heading", { name: "Launch Review" })
    ).toBeVisible();
    const recheckToggle = page.getByTestId("launch-reviewer-allow-recheck");
    await recheckToggle.click();
    await expect(recheckToggle).toHaveAttribute("data-state", "checked");
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(
      page.getByRole("heading", { name: "Launch Review" })
    ).not.toBeVisible();

    await page.getByTestId("launch-reviewer-button").click();
    await expect(
      page.getByRole("heading", { name: "Launch Review" })
    ).toBeVisible();
    await expect(recheckToggle).toHaveAttribute("data-state", "checked");
    await page
      .getByTestId("launch-reviewer-persona-architecture-review")
      .click();
    await page.getByTestId("launch-reviewer-submit").click();

    await expect.poll(() => launchRouteCalls).toBeGreaterThanOrEqual(1);
    expect(lastLaunchPayload).toMatchObject({
      persona: "architecture-review",
      allowRecheck: true,
    });
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
