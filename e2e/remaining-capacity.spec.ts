import { expect, test, type Locator } from "@playwright/test";
import { cleanupE2EAgents, createAgentViaAPI } from "./helpers";

async function expectCapacity(scope: Locator, name: string, left: number) {
  const bar = scope.getByRole("progressbar", { name: `${name} capacity left` });
  await expect(bar).toHaveAttribute("aria-valuenow", String(left));
  await expect(bar).toHaveAttribute("aria-valuetext", `${left}% left`);
  await expect(bar.locator(":scope > div")).toHaveAttribute(
    "style",
    `width: ${left}%;`
  );
  const track = (await bar.boundingBox())!;
  const fill = (await bar.locator(":scope > div").boundingBox())!;
  expect(Math.abs(fill.width - (track.width * left) / 100)).toBeLessThan(1);
}

test.use({ deviceScaleFactor: 2 });

test.afterEach(async ({ request }) => {
  await cleanupE2EAgents(request);
});

for (const width of [1280, 390]) {
  test(`remaining capacity popover and reset confirmation at ${width}px`, async ({
    page,
    request,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    // The suite runs an inert runtime; no prompt or provider session is started.
    const agent = await createAgentViaAPI(request);
    let consumed = 0;
    const windows = [
      { id: "weekly", label: "Weekly", usedPercent: 60, resetsAt: null },
      { id: "full", label: "Full", usedPercent: 0, resetsAt: null },
      { id: "empty", label: "Empty", usedPercent: 100, resetsAt: null },
    ];
    // Guard every usage endpoint, including a mistakenly triggered reset POST.
    await page.route("**/api/v1/usage/**", async (route) => {
      if (route.request().method() !== "GET") {
        consumed++;
        await route.abort();
        return;
      }
      await route.fulfill({
        json: {
          checkedAt: new Date().toISOString(),
          providers: (["codex", "claude"] as const).map((engine) => ({
            engine,
            plan: "Fixture",
            observedAt: new Date().toISOString(),
            windows,
            ...(engine === "codex"
              ? { limitResets: { available: 1, applicable: 1 } }
              : {}),
          })),
        },
      });
    });
    await page.route(`**/api/v1/agents/${agent.id}/config`, (route) =>
      route.fulfill({ json: { running: false, options: [] } })
    );
    await page.route(`**/api/v1/agents/${agent.id}/usage`, (route) =>
      route.fulfill({
        json: {
          context: { used: 120_000, size: 200_000 },
          sessionCost: null,
          byModel: [],
          session: {
            input: 100,
            output: 20,
            cacheRead: 0,
            cacheWrite: 0,
            total: 120,
          },
        },
      })
    );
    await page.goto(`/agents/${agent.id}`, { waitUntil: "domcontentloaded" });
    const chip = page.getByTestId("composer-usage-chip");
    await expect(chip).toHaveAccessibleName("Context: 40% left");
    await expect(chip).toHaveAttribute("title", "Context: 40% left");
    await expect(
      chip.locator(
        "span.composer-usage-full:visible, span.composer-usage-short:visible"
      )
    ).toContainText("left");
    await chip.click();
    const panel = page.getByTestId("composer-usage-panel");
    await expect(panel).toBeVisible();
    await expect(page.getByTestId("usage-context")).toHaveText(
      "120.0K / 200.0K (40% left)"
    );
    await expectCapacity(panel, "Context", 40);
    for (const engine of ["codex", "claude"]) {
      const card = panel.getByTestId(`usage-plan-${engine}`);
      await expect(card.getByText("40% left", { exact: true })).toBeVisible();
      await expectCapacity(card, "Weekly", 40);
      await expectCapacity(card, "Full", 100);
      await expectCapacity(card, "Empty", 0);
    }
    const bounds = (await panel.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    const popoverImage = `/tmp/remaining-capacity-popover-${width}.png`;
    await page.screenshot({ path: popoverImage });
    await testInfo.attach("usage popover", {
      path: popoverImage,
      contentType: "image/png",
    });
    await page.getByTestId("usage-codex-reset").click();
    const dialog = page.getByRole("dialog", {
      name: "Use a Codex limit reset?",
    });
    await expect(dialog).toBeVisible();
    await expectCapacity(dialog, "Weekly", 40);
    await expectCapacity(dialog, "Full", 100);
    await expectCapacity(dialog, "Empty", 0);
    const resetImage = `/tmp/remaining-capacity-reset-${width}.png`;
    await page.screenshot({ path: resetImage });
    await testInfo.attach("reset confirmation (never consumed)", {
      path: resetImage,
      contentType: "image/png",
    });
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    expect(consumed).toBe(0);
    // Playwright's page/context fixtures close the browser surfaces after each flow.
  });
}
