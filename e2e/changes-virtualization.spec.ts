import { expect, test } from "@playwright/test";
import {
  callMcpToolViaAPI,
  cleanupE2EAgents,
  createAgentViaAPI,
} from "./helpers";
import { largeDiffFixture } from "./fixtures/large-diff";

test.describe("Changes viewport rendering", () => {
  test.afterEach(async ({ request }) => cleanupE2EAgents(request));

  test("bounds aggregate DOM after traversal and preserves distant navigation and tab returns", async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    const agent = await createAgentViaAPI(request, {
      name: `e2e-large-diff-${Date.now()}`,
    });
    await page.route("**/api/v1/agents/*/diff?*", (route) =>
      route.fulfill({ json: largeDiffFixture() })
    );
    await page.goto(`/agents/${agent.id}/changes`, {
      waitUntil: "domcontentloaded",
    });
    const pane = page.getByTestId("changes-diff-pane");
    const tables = pane.locator("table.diff");
    await expect(tables.first()).toBeVisible();
    await expect.poll(() => tables.count()).toBeLessThanOrEqual(3);
    let maximum = 0;
    for (let index = 0; index < 145; index++) {
      const path = `src/large/file-${String(index).padStart(3, "0")}.ts`;
      const section = page.getByTestId(`changes-file-section:${path}`);
      await section.evaluate((el) => el.scrollIntoView({ block: "start" }));
      await expect(section.locator("table.diff")).toBeVisible();
      await expect.poll(() => tables.count()).toBeLessThanOrEqual(3);
      maximum = Math.max(maximum, await tables.count());
    }
    console.log(
      `87k fixture: maximum ${maximum} mounted tables after visiting every file`
    );
    expect(await pane.locator("table.diff tr").count()).toBeLessThan(2000);

    // Use the actual file tree to jump to a distant, currently unmounted file.
    const path = "src/large/file-100.ts";
    await page.getByTitle(path, { exact: true }).click();
    const target = page.getByTestId(`changes-file-section:${path}`);
    await expect(target.locator("table.diff")).toBeVisible();
    await target.locator("button").first().click();
    await expect(target.locator("table.diff")).toHaveCount(0);
    await target.locator("button").first().click();
    await expect(target.locator("table.diff")).toBeVisible();

    await pane.evaluate((el) => {
      el.scrollTop += 200;
    });
    await expect
      .poll(() => pane.evaluate((el) => el.scrollTop))
      .toBeGreaterThan(1000);
    const before = await pane.evaluate((el) => el.scrollTop);
    await page.getByTitle("Open drawer", { exact: true }).click();
    await page.getByTestId("sidebar-tab-terminal").click();
    await expect(target.locator("table.diff")).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath("terminal-with-changes.png"),
    });
    await page
      .getByTestId("drawer")
      .getByTitle("Close sidebar", { exact: true })
      .click();
    await page.getByTestId("center-tab-changes").click();
    await expect.poll(() => pane.evaluate((el) => el.scrollTop)).toBe(before);
    const times = [];
    for (let index = 0; index < 3; index++) {
      await page.getByTestId("center-tab-agent").click();
      await expect(tables).toHaveCount(0);
      const start = Date.now();
      await page.getByTestId("center-tab-changes").click();
      await expect(target.locator("table.diff")).toBeVisible();
      times.push(Date.now() - start);
      await expect.poll(() => pane.evaluate((el) => el.scrollTop)).toBe(before);
    }
    console.log(`87k fixture cached tab returns (ms): ${times.join(", ")}`);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(target.locator("table.diff")).toBeVisible();
    // Measurements are estimates after a cold reload; the same file should be visible.
    await expect(target.locator("button").first()).toBeInViewport();

    await page.goto(
      `/agents/${agent.id}/changes?file=${encodeURIComponent(path)}&line=1050`,
      { waitUntil: "domcontentloaded" }
    );
    const line = target.locator('[data-change-key="I1050"]').first();
    await expect(line).toBeInViewport();
    await expect(tables).toHaveCount(1);
    await expect(target.locator(".diff-hunk-separator-label")).toHaveCount(2);
    await expect(
      target.locator(".diff-hunk-separator-label").last()
    ).toContainText("998");
    // A later hunk remains navigable after the file's table is unmounted.
    await page.getByTitle("src/large/file-000.ts", { exact: true }).click();
    await expect(target.locator("table.diff")).toHaveCount(0);
    await page.getByTitle(path, { exact: true }).click();
    await expect(
      target.locator('[data-change-key="I1050"]').first()
    ).toBeAttached();
    await page.getByTestId("changes-settings-button").click();
    await page.getByRole("button", { name: "Split", exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(target.locator("table.diff-split")).toBeVisible();
    await page.goto(
      `/agents/${agent.id}/changes?file=${encodeURIComponent(path)}&line=1050`,
      { waitUntil: "domcontentloaded" }
    );
    await expect(
      target.locator('[data-change-key="I1050"]').first()
    ).toBeInViewport();
    await expect(target.locator(".diff-hunk-separator-label")).toHaveCount(2);
    await page.getByTestId("changes-settings-button").click();
    await page.getByRole("button", { name: "Unified", exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(target.locator("table.diff-unified")).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath("large-diff-navigation.png"),
    });
  });
  test("finds an offscreen review, edits a draft and keeps resized split contents navigable", async ({
    page,
    request,
  }) => {
    test.setTimeout(60_000);
    const agent = await createAgentViaAPI(request, {
      name: `e2e-diff-review-${Date.now()}`,
    });
    const other = await createAgentViaAPI(request, {
      name: `e2e-other-diff-${Date.now()}`,
    });
    const path = "src/large/file-100.ts";
    await page.route("**/api/v1/agents/*/diff?*", (route) =>
      route.fulfill({ json: largeDiffFixture() })
    );
    const result = await callMcpToolViaAPI(request, agent.id, "post", {
      review: {
        summary: "Fixture review",
        findings: [
          {
            severity: "nit",
            title: "Later hunk finding",
            body: "Check the changed count",
            path,
            line: 1050,
          },
        ],
      },
    });
    const receipt = JSON.parse(
      (result as { result: { content: { text: string }[] } }).result.content[0]!
        .text
    ) as { id: string; findings: { id: string }[] };
    const findingId = receipt.findings[0]!.id;
    await page.goto(
      `/agents/${agent.id}/changes?file=${encodeURIComponent(path)}&thread=${receipt.id}&finding=${findingId}`,
      { waitUntil: "domcontentloaded" }
    );
    const target = page.getByTestId(`changes-file-section:${path}`);
    const finding = target.getByTestId("diff-finding");
    await expect(finding).toHaveAttribute("data-expanded", "true");
    await expect(finding).toBeInViewport();
    await page.screenshot({
      path: test.info().outputPath("offscreen-finding.png"),
    });
    await page.getByTestId("thread-drawer").getByTestId("drawer-close").click();
    await expect(page.getByTestId("thread-drawer")).not.toBeVisible();
    await page.getByTestId("changes-start-review").click();
    await target
      .locator('.diff-gutter[data-change-key="I1050"]')
      .first()
      .click();
    await target.locator(".changes-diff-view > button").click();
    await page.getByPlaceholder("Leave a comment…").fill("Fixture draft");
    await page.getByTitle("src/large/file-000.ts", { exact: true }).click();
    await expect(target.locator("table.diff")).toHaveCount(0);
    await page.getByTitle(path, { exact: true }).click();
    await expect(target.locator("textarea")).toHaveValue("Fixture draft");
    await page
      .getByRole("button", { name: "Add comment", exact: true })
      .click();
    await expect(
      target.getByText("Fixture draft", { exact: true })
    ).toBeVisible();
    await target.locator("button").last().click();
    await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
    await target.locator("textarea").fill("Edited fixture draft");
    await page.getByTitle("src/large/file-000.ts", { exact: true }).click();
    await expect(target.locator("table.diff")).toHaveCount(0);
    await page.getByTitle(path, { exact: true }).click();
    await expect(target.locator("textarea")).toHaveValue(
      "Edited fixture draft"
    );
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByTitle("src/large/file-000.ts", { exact: true }).click();
    await expect(target.locator("table.diff")).toHaveCount(0);
    await page.getByTitle(path, { exact: true }).click();
    await expect(
      target.getByText("Edited fixture draft", { exact: true })
    ).toBeAttached();
    await page.getByTestId("changes-settings-button").click();
    await page.getByRole("button", { name: "Split", exact: true }).click();
    await page.keyboard.press("Escape");
    for (const width of [1000, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.getByTitle("src/large/file-000.ts", { exact: true }).click();
      await page.getByTitle(path, { exact: true }).click();
      await expect(target.locator("table.diff-split")).toBeVisible();
      await page.goto(
        `/agents/${agent.id}/changes?file=${encodeURIComponent(path)}&line=1050`,
        { waitUntil: "domcontentloaded" }
      );
      await expect(
        target.locator('[data-change-key="I1050"]').first()
      ).toBeInViewport();
    }
    await page.screenshot({
      path: test.info().outputPath("resized-split-review.png"),
    });
    await page
      .getByTestId(`agent-row-${other.id}`)
      .click({ position: { x: 4, y: 8 } });
    await page.getByTestId("center-tab-changes").click();
    await expect(
      page.getByTestId("changes-diff-pane").locator("table.diff").first()
    ).toBeVisible();
    await expect(
      page.getByText("Edited fixture draft", { exact: true })
    ).toHaveCount(0);
    await expect(page.getByTestId("changes-start-review")).toBeVisible();
    await expect
      .poll(() =>
        page.getByTestId("changes-diff-pane").evaluate((el) => el.scrollTop)
      )
      .toBe(0);
  });
  test("discarded and removed draft edits cannot leak into a restarted review", async ({
    page,
    request,
  }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-draft-lifecycle-${Date.now()}`,
    });
    const path = "src/large/file-100.ts";
    await page.route("**/api/v1/agents/*/diff?*", (route) =>
      route.fulfill({ json: largeDiffFixture() })
    );
    await page.goto(
      `/agents/${agent.id}/changes?file=${encodeURIComponent(path)}&line=1050`,
      { waitUntil: "domcontentloaded" }
    );
    const target = page.getByTestId(`changes-file-section:${path}`);
    const add = async (text: string, line = 1050) => {
      await page.getByTestId("changes-start-review").click();
      await target
        .locator(`.diff-gutter[data-change-key="I${line}"]`)
        .first()
        .click();
      await target.locator(".changes-diff-view > button").click();
      await page.getByPlaceholder("Leave a comment…").fill(text);
      await page
        .getByRole("button", { name: "Add comment", exact: true })
        .click();
    };
    const edit = async (text: string) => {
      await target.locator("button").last().click();
      await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
      await target.locator("textarea").fill(text);
    };
    await add("First review comment");
    await edit("Discarded unsaved edit");
    await page.getByTitle("src/large/file-000.ts", { exact: true }).click();
    await expect(target.locator("table.diff")).toHaveCount(0);
    await page
      .getByRole("button", { name: "Cancel review", exact: true })
      .click();
    await page.getByRole("button", { name: "Discard", exact: true }).click();
    await page.getByTitle(path, { exact: true }).click();
    await add("Fresh review comment", 1051);
    await expect(target.locator("textarea")).toHaveCount(0);
    await expect(
      target.getByText("Fresh review comment", { exact: true })
    ).toBeVisible();
    await edit("Fresh edited review comment");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(
      target.getByText("Fresh edited review comment", { exact: true })
    ).toBeVisible();
    await edit("Removed unsaved edit");
    await page.getByTitle("src/large/file-000.ts", { exact: true }).click();
    await expect(target.locator("table.diff")).toHaveCount(0);
    await page.getByTestId("review-mode-submit").click();
    await page
      .getByRole("button", { name: "Remove comment", exact: true })
      .click();
    await page.keyboard.press("Escape");
    await expect(target.locator("textarea")).toHaveCount(0);
    await page.getByTitle(path, { exact: true }).click();
    await add("After removal", 1052);
    await expect(
      target.getByText("After removal", { exact: true })
    ).toBeVisible();
    await expect(target.locator("textarea")).toHaveCount(0);
    await page.screenshot({
      path: test.info().outputPath("draft-lifecycle.png"),
    });
  });
});
