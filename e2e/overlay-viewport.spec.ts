import { expect, test, type Locator } from "@playwright/test";
import { createAgentViaAPI, deleteAgentViaAPI, loadApp } from "./helpers";

async function expectInsideViewport(
  overlay: Locator,
  height: number,
  top = 0,
  bottom = 0
) {
  await expect(overlay).toBeVisible();
  await expect
    .poll(async () => {
      const box = await overlay.boundingBox();
      return (
        !!box && box.y >= top - 1 && box.y + box.height <= height - bottom + 1
      );
    })
    .toBe(true);
}

for (const viewport of [
  { width: 390, height: 500 },
  { width: 1440, height: 900 },
]) {
  test(`long project and model pickers stay reachable at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.route("**/api/v1/projects", (route) =>
      route.fulfill({
        json: Array.from({ length: 40 }, (_, i) => ({
          id: `project-${i}`,
          name: `Project ${i}`,
          repoRoot: `/tmp/project-${i}`,
          color: "#7c6ee6",
        })),
      })
    );
    await page.route("**/api/v1/agent-models", (route) =>
      route.fulfill({
        json: {
          models: {
            claude: Array.from({ length: 40 }, (_, i) => ({
              id: `model-${i}`,
              label: `Model ${i}`,
            })),
          },
        },
      })
    );
    await loadApp(page);
    await page.getByRole("button", { name: "Filter by project" }).click();
    await expectInsideViewport(page.getByRole("menu"), viewport.height);
    await page
      .getByRole("menuitem", { name: "Manage projects" })
      .scrollIntoViewIfNeeded();
    await expectInsideViewport(
      page.getByRole("menuitem", { name: "Manage projects" }),
      viewport.height
    );
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await page.getByTestId("create-agent-button").click();
    await page.getByTestId("create-agent-model").click();
    await expectInsideViewport(page.getByRole("listbox"), viewport.height);
    await page.getByRole("option", { name: "Model 39", exact: true }).click();
    await expect(page.getByTestId("create-agent-model")).toHaveText("Model 39");
    await page.getByTestId("create-agent-model").click();
    await expectInsideViewport(page.getByRole("listbox"), viewport.height);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
  });
}

// Chromium's env() override exercises real CSS measurement and Radix geometry.
// It does not establish how native Safari or installed iOS exposes these insets.
test("phone overlays respect nonzero safe areas, including an upward PR popover", async ({
  page,
  request,
}) => {
  const height = 600;
  const top = 59;
  const bottom = 34;
  await page.setViewportSize({ width: 390, height });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setSafeAreaInsetsOverride", {
    insets: { top, bottom, left: 0, right: 0 },
  });
  const agent = await createAgentViaAPI(request, {
    name: `e2e-safe-area-${Date.now()}`,
  });
  try {
    await page.route("**/api/v1/projects", (route) =>
      route.fulfill({
        json: Array.from({ length: 40 }, (_, i) => ({
          id: `p-${i}`,
          name: `Project ${i}`,
          repoRoot: `/tmp/p-${i}`,
          color: "#7c6ee6",
        })),
      })
    );
    await page.route("**/api/v1/agent-models", (route) =>
      route.fulfill({
        json: {
          models: {
            claude: Array.from({ length: 40 }, (_, i) => ({
              id: `m-${i}`,
              label: `Model ${i}`,
            })),
          },
        },
      })
    );
    await page.route(`**/api/v1/agents/${agent.id}/pull-requests`, (route) =>
      route.fulfill({
        json: {
          pullRequests: [
            {
              url: "https://github.com/example/project/pull/42",
              title: "Safe-area regression",
              status: "Draft",
              ci: {
                checkedAt: "2026-11-06T02:00:00Z",
                headSha: "abcdef123456",
                availability: "available",
                summary: {
                  status: "passing",
                  total: 30,
                  passed: 30,
                  failed: 0,
                  pending: 0,
                  skipped: 0,
                },
                checks: Array.from({ length: 30 }, (_, i) => ({
                  name: `Check ${i}`,
                  status: "COMPLETED",
                  conclusion: "SUCCESS",
                  detailsUrl: `https://github.com/example/project/actions/runs/${i}`,
                })),
              },
            },
          ],
        },
      })
    );
    await loadApp(page);
    await expect(page.locator('meta[name="viewport"]')).toHaveAttribute(
      "content",
      /viewport-fit=cover/
    );
    const measured = await page.evaluate(() => {
      const probe = document.createElement("div");
      probe.style.cssText =
        "padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)";
      document.body.append(probe);
      const style = getComputedStyle(probe);
      const result = [
        parseFloat(style.paddingTop),
        parseFloat(style.paddingBottom),
      ];
      probe.remove();
      return result;
    });
    expect(measured).toEqual([top, bottom]);
    await page.getByRole("button", { name: "Filter by project" }).click();
    await expectInsideViewport(page.getByRole("menu"), height, top, bottom);
    await page
      .getByRole("menuitem", { name: "Manage projects" })
      .scrollIntoViewIfNeeded();
    await expectInsideViewport(
      page.getByRole("menuitem", { name: "Manage projects" }),
      height,
      top,
      bottom
    );
    await page.keyboard.press("Escape");
    await page.getByTestId("create-agent-button").click();
    await page.getByTestId("create-agent-model").click();
    await expectInsideViewport(page.getByRole("listbox"), height, top, bottom);
    await page.getByRole("option", { name: "Model 39", exact: true }).click();
    await expect(page.getByTestId("create-agent-model")).toHaveText("Model 39");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByTestId(`agent-expand-toggle-${agent.id}`).click();
    const trigger = page.getByRole("button", {
      name: "Details for pull request #42: Draft",
      exact: true,
    });
    await trigger.click();
    const popover = page.getByRole("dialog").filter({
      has: page.getByRole("heading", {
        name: "Pull request #42",
        exact: true,
      }),
    });
    await expect(popover).toHaveAttribute("data-side", "top");
    await expectInsideViewport(popover, height, top + 12, bottom + 12);
    await page
      .getByRole("link", { name: "Check 29", exact: true })
      .scrollIntoViewIfNeeded();
    await expectInsideViewport(
      page.getByRole("link", { name: "Check 29", exact: true }),
      height,
      top + 12,
      bottom + 12
    );
    await page.keyboard.press("Escape");
    await expect(popover).toHaveCount(0);
    await expect(trigger).toBeFocused();
  } finally {
    await cdp.detach();
    await deleteAgentViaAPI(request, agent.id);
  }
});
