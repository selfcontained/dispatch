import { test, expect } from "@playwright/test";
import {
  createAgentViaAPI,
  cleanupE2EAgents,
  loadApp,
  callMcpToolViaAPI,
} from "./helpers";

test.afterEach(async ({ request }) => {
  await cleanupE2EAgents(request);
});
test("sidebar shows multiple PRs and opens their status list without selecting the agent", async ({
  page,
  request,
}) => {
  const agent = await createAgentViaAPI(request, {
    name: `e2e-agent-prs-${Date.now()}`,
  });
  await page.route(`**/api/v1/agents/${agent.id}/pull-requests`, (route) =>
    route.fulfill({
      json: {
        pullRequests: [
          {
            url: "https://github.com/example/project/pull/42",
            title: "First change",
            status: "Open",
          },
          {
            url: "https://github.com/example/project/pull/43",
            title: "Second change",
            status: "Merged",
          },
          {
            url: "https://github.com/example/project/pull/44",
            title: "Next change",
            status: "Draft",
          },
        ],
      },
    })
  );
  await loadApp(page);
  const before = page.url();
  await page.getByTestId(`agent-expand-toggle-${agent.id}`).click();
  await expect(
    page
      .getByTestId(`agent-row-${agent.id}`)
      .getByRole("button", { name: /Pull requests:/ })
  ).toHaveCount(0);
  await page
    .getByTestId(`agent-card-${agent.id}`)
    .getByRole("button", {
      name: "Details for pull request #42: Open",
    })
    .click();
  await expect(
    page.getByRole("heading", { name: "Pull request #42", exact: true })
  ).toBeVisible();
  await expect(
    page.getByRole("dialog").getByRole("link", { name: "Open on GitHub" })
  ).toHaveAttribute("href", "https://github.com/example/project/pull/42");
  await expect(
    page.getByTestId(`agent-pr-row-${agent.id}`).getByTestId("agent-pr-line")
  ).toHaveCount(3);
  expect(page.url()).toBe(before);
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("heading", { name: "Pull request #42", exact: true })
  ).toBeHidden();
});

test("explicit PR posts reach the sidebar over SSE without client refetches", async ({
  page,
  request,
}) => {
  const agent = await createAgentViaAPI(request, {
    name: `e2e-agent-pr-sse-${Date.now()}`,
  });
  let reads = 0;
  await page.route(`**/api/v1/agents/${agent.id}/pull-requests`, (route) => {
    reads++;
    return route.continue();
  });
  await loadApp(page);
  await page.getByTestId(`agent-expand-toggle-${agent.id}`).click();
  await expect.poll(() => reads).toBeGreaterThan(0);
  await callMcpToolViaAPI(request, agent.id, "post", {
    attachments: [
      {
        type: "link",
        url: "https://gitlab.com/example/project/merge_requests/1",
        title: "Ordinary link",
      },
    ],
  });
  const card = page.getByTestId(`agent-card-${agent.id}`);
  await expect(
    card.getByRole("button", { name: /Pull requests:/ })
  ).toHaveCount(0);
  const before = reads;
  // Unsupported host deliberately exercises the server queue without contacting GitHub.
  await callMcpToolViaAPI(request, agent.id, "post", {
    attachments: [
      {
        type: "pr",
        url: "https://gitlab.com/example/project/merge_requests/2",
        title: "Explicit PR",
      },
    ],
  });
  await expect(
    card.getByRole("link", {
      name: "Pull request #2: Unavailable — Explicit PR",
    })
  ).toBeVisible();
  expect(reads).toBe(before);

  await expect(page.getByRole("link", { name: /Explicit PR/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /Ordinary link/ })).toHaveCount(
    0
  );
  await page.keyboard.press("Escape");
});

test("a single PR shows its number and status in session details as a direct link", async ({
  page,
  request,
}) => {
  const agent = await createAgentViaAPI(request, {
    name: `e2e-agent-single-pr-${Date.now()}`,
  });
  await page.route(`**/api/v1/agents/${agent.id}/pull-requests`, (route) =>
    route.fulfill({
      json: {
        pullRequests: [
          {
            url: "https://github.com/example/project/pull/42",
            title: "One focused change",
            status: "Open",
          },
        ],
      },
    })
  );
  await loadApp(page);
  const card = page.getByTestId(`agent-card-${agent.id}`);
  await expect(
    card.getByRole("link", { name: /Pull request #42/ })
  ).toHaveCount(0);
  await page.getByTestId(`agent-expand-toggle-${agent.id}`).click();
  const link = card.getByRole("link", {
    name: "Pull request #42: Open — One focused change",
  });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute(
    "href",
    "https://github.com/example/project/pull/42"
  );
  await expect(link).toContainText("Open");
  await expect(link).toContainText("#42");
  await expect(
    card.getByRole("button", { name: /pull requests:/ })
  ).toHaveCount(0);
  await page.getByTestId(`agent-expand-toggle-${agent.id}`).click();
  await expect(link).toBeHidden();
});

test("PR metadata keeps its geometry across every status and single/multiple PRs", async ({
  page,
  request,
}) => {
  const agent = await createAgentViaAPI(request, {
    name: `e2e-agent-pr-layout-${Date.now()}`,
  });
  let statuses = ["Open"];
  await page.route(`**/api/v1/agents/${agent.id}/pull-requests`, (route) =>
    route.fulfill({
      json: {
        pullRequests: statuses.map((status, i) => ({
          url: `https://github.com/example/project/pull/${42 + i}`,
          title: `Detailed PR title ${i}`,
          status,
        })),
      },
    })
  );
  let size: { width: number; height: number } | undefined;
  for (const next of [
    ["Pending"],
    ["Open"],
    ["Draft"],
    ["Merged"],
    ["Closed"],
    ["Unavailable"],
    ["Merged", "Merged"],
    ["Open", "Draft", "Merged", "Closed", "Pending", "Unavailable"],
  ]) {
    statuses = next;
    await loadApp(page);
    const toggle = page.getByTestId(`agent-expand-toggle-${agent.id}`);
    if ((await toggle.getAttribute("aria-expanded")) !== "true")
      await toggle.click();
    const row = page.getByTestId(`agent-pr-row-${agent.id}`);
    await expect(row).toBeVisible();
    const box = await row.getByTestId("agent-pr-line").first().boundingBox();
    expect(box).not.toBeNull();
    const dimensions = { width: box!.width, height: box!.height };
    if (size) expect(dimensions).toEqual(size);
    else size = dimensions;
    await expect(row).not.toContainText("Detailed PR title");
    await expect(row.getByRole("link")).toHaveCount(next.length);
    await expect(
      row.getByRole("button", { name: /Details for pull request/ }).first()
    ).toBeVisible();
    const info = row.getByRole("button").first();
    const infoBox = await info.boundingBox();
    const firstLink = await row.getByRole("link").first().boundingBox();
    expect(infoBox!.width).toBe(infoBox!.height);
    expect(infoBox!.x + infoBox!.width).toBeLessThanOrEqual(firstLink!.x);
    const engine = page
      .getByTestId(`agent-card-${agent.id}`)
      .locator('[title="Engine"]');
    const engineBox = await engine.boundingBox();
    const infoIcon = await info.locator("svg").boundingBox();
    expect(infoIcon!.x).toBe(engineBox!.x);
    const engineValue = await engine
      .locator("..")
      .locator("div")
      .first()
      .boundingBox();
    const prNumber = await row
      .getByRole("link")
      .first()
      .locator("span")
      .first()
      .boundingBox();
    expect(firstLink!.x).toBe(engineValue!.x);
    // Read both boxes in one animation frame: other sessions can reorder while expanding.
    const centerOffset = await row
      .getByTestId("agent-pr-line")
      .first()
      .evaluate((el) => {
        const icon = el.querySelector("button svg")!.getBoundingClientRect();
        const number = el.querySelector("a span")!.getBoundingClientRect();
        return icon.top + icon.height / 2 - (number.top + number.height / 2);
      });
    expect(centerOffset).toBe(0);
    await expect(row.getByRole("link").first().locator("svg")).toHaveCount(1);

    expect(await info.evaluate((el) => getComputedStyle(el).padding)).toBe(
      "0px"
    );
    await info.click();
    const details = page.getByRole("dialog");
    await expect(
      details.getByText("Detailed PR title 0", { exact: true })
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(details).toBeHidden();
  }
});

test("CI preview separates PR state from check results and opens individual check details", async ({
  page,
  request,
}) => {
  const agent = await createAgentViaAPI(request, {
    name: `e2e-agent-ci-${Date.now()}`,
  });
  await page.route(`**/api/v1/agents/${agent.id}/pull-requests`, (route) =>
    route.fulfill({
      json: {
        pullRequests: [
          {
            url: "https://github.com/example/project/pull/42",
            title: "CI example",
            status: "Open",
            ci: {
              checkedAt: "2026-11-05T19:00:00Z",
              headSha: "abcdef012345",
              availability: "available",
              summary: {
                status: "failing",
                total: 3,
                passed: 1,
                failed: 1,
                pending: 1,
                skipped: 0,
              },
              checks: [
                {
                  name: "Unit tests",
                  status: "COMPLETED",
                  conclusion: "FAILURE",
                  detailsUrl:
                    "https://github.com/example/project/actions/runs/1",
                },
              ],
            },
          },
          {
            url: "https://github.com/example/project/pull/43",
            title: "No checks example",
            status: "Draft",
            ci: {
              checkedAt: "2026-11-05T19:00:00Z",
              headSha: "abcdef012345",
              availability: "available",
              summary: {
                status: "none",
                total: 0,
                passed: 0,
                failed: 0,
                pending: 0,
                skipped: 0,
              },
              checks: [],
            },
          },
          {
            url: "https://github.com/example/project/pull/44",
            title: "Unavailable example",
            status: "Open",
            ci: {
              checkedAt: "2026-11-05T19:00:00Z",
              headSha: "abcdef012345",
              availability: "unavailable",
              summary: {
                status: "none",
                total: 0,
                passed: 0,
                failed: 0,
                pending: 0,
                skipped: 0,
              },
              checks: [],
            },
          },
        ],
      },
    })
  );
  await loadApp(page);
  await page.getByTestId(`agent-expand-toggle-${agent.id}`).click();
  const rows = page.getByTestId(`agent-pr-row-${agent.id}`);
  await expect(
    rows.getByRole("img", { name: "Checks: 1 passed, 1 failed, 1 pending" })
  ).toBeVisible();
  await expect(
    rows.getByRole("img", { name: "No checks", exact: true })
  ).toBeVisible();
  await expect(
    rows.getByRole("img", { name: "Checks unavailable", exact: true })
  ).toBeVisible();
  await rows
    .getByRole("button", { name: "Details for pull request #42: Open" })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("link", { name: "Unit tests" })
  ).toHaveAttribute(
    "href",
    "https://github.com/example/project/actions/runs/1"
  );
  await expect(dialog).toContainText("Failed");
  await expect(dialog).toContainText("abcdef0");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});
