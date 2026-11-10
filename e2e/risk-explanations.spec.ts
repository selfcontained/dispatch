import { test, expect } from "@playwright/test";
import { createAgentViaAPI, cleanupE2EAgents, loadApp } from "./helpers";

test.afterEach(async ({ request }) => {
  await cleanupE2EAgents(request);
});
for (const mobile of [false, true]) {
  test(`explicit assessment explanation loading, failure, retry and cached reopen (${mobile ? "mobile" : "desktop"})`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize(
      mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 }
    );
    const agent = await createAgentViaAPI(request, {
      name: `e2e-explanation-${Date.now()}`,
    });
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(`**/api/v1/agents/${agent.id}/pull-requests`, (route) =>
      route.fulfill({
        json: {
          pullRequests: [
            {
              url: "https://github.com/example/project/pull/42",
              title: "Session settings",
              status: "Open",
              ci: {
                headSha: "abc",
                availability: "available",
                summary: {
                  status: "failing",
                  total: 1,
                  passed: 0,
                  failed: 1,
                  pending: 0,
                  skipped: 0,
                },
                checks: [],
              },
              mergeRisk: {
                assessmentId: "42",
                status: "ok",
                headSha: "abc",
                verdict: "human_review",
                changeRiskLabel: "high",
                reviewAdequate: 0.94,
                descriptionMatches: 0.9,
                newSurface: 0.8,
                confidence: 0.9,
                assessedAt: "2026-11-10T18:00:00Z",
              },
            },
          ],
        },
      })
    );
    await page.route(
      `**/api/v1/agents/${agent.id}/pull-requests/explain`,
      async (route) => {
        calls++;
        if (calls === 1) {
          await gate;
          await route.fulfill({ json: { state: "failed" } });
        } else if (calls === 2)
          await route.fulfill({ json: { state: "unavailable" } });
        else if (calls === 4)
          await route.fulfill({
            status: 500,
            json: { error: "Synthetic revalidation failure" },
          });
        else
          await route.fulfill({
            json: {
              state: "ready",
              text: "The auth/session.ts change affects session handling. Resolved reviews mitigate correctness risk, while the new settings surface needs product judgment. This is not merge approval.",
            },
          });
      }
    );
    await loadApp(page);
    if (mobile) {
      const sidebar = page.getByRole("button", {
        name: "Open sidebar",
        exact: true,
      });
      if (await sidebar.isVisible()) await sidebar.click();
    }
    await page.getByTestId(`agent-expand-toggle-${agent.id}`).click();
    const trigger = page.getByRole("button", {
      name: "Details for pull request #42: Open",
      exact: true,
    });
    await trigger.click();
    const explain = page.getByRole("button", {
      name: "Explain assessment",
      exact: true,
    });
    await expect(explain).toBeVisible();
    expect(calls).toBe(0);
    await explain.click();
    await expect(
      page.getByRole("button", { name: "Explaining…", exact: true })
    ).toBeDisabled();
    await page.screenshot({
      path: `/tmp/risk-${mobile ? "mobile" : "desktop"}-loading.png`,
    });
    release();
    await expect(
      page.getByText("Could not explain this assessment. You can retry.")
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Retry explanation", exact: true })
      .click();
    await expect(
      page.getByText(/Explanation unavailable for this assessment/)
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Retry explanation", exact: true })
    ).toBeEnabled();
    await page
      .getByRole("button", { name: "Retry explanation", exact: true })
      .click();
    await expect(page.getByText(/The auth\/session.ts change/)).toBeVisible();
    await expect(page.getByText(/Evidence-based follow-up/)).toBeVisible();
    await page.screenshot({
      path: `/tmp/risk-${mobile ? "mobile" : "desktop"}-result.png`,
    });
    await page.keyboard.press("Escape");
    await trigger.click();
    await expect(page.getByText(/The auth\/session.ts change/)).toBeHidden();
    await page
      .getByRole("button", { name: "Explain assessment", exact: true })
      .click();
    await expect(
      page.getByText("Could not explain this assessment. You can retry.")
    ).toBeVisible();
    await expect(page.getByText(/The auth\/session.ts change/)).toBeHidden();
    await page
      .getByRole("button", { name: "Retry explanation", exact: true })
      .click();
    await expect(page.getByText(/The auth\/session.ts change/)).toBeVisible();
    expect(calls).toBe(5);
  });
}
