import { expect, test } from "@playwright/test";
import {
  callMcpToolViaAPI,
  cleanupE2EAgents,
  createAgentViaAPI,
} from "./helpers";
test.use({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
test.afterEach(async ({ request }) => cleanupE2EAgents(request));
test("agents post and update six-series charts and retain exact values in history and threads", async ({
  page,
  request,
}, testInfo) => {
  const agent = await createAgentViaAPI(request);
  const other = await createAgentViaAPI(request);
  const colors = ["cyan", "pink", "lime", "orange", "purple", "yellow"];
  const chart = {
    version: 1,
    title: "Six-series output",
    unit: "items",
    dataKind: "synthetic",
    type: "bar",
    xLabel: "Day",
    series: colors.map((color, i) => ({
      id: `series${i}`,
      label: `Series ${i}`,
      color,
    })),
    points: [
      { label: "Monday", values: [1, 2, 3, 4, 5, 6] },
      { label: "Tuesday", values: [2, null, 4, 5, 6, 7] },
    ],
  };
  async function call(
    who: string,
    name: string,
    args: Record<string, unknown>
  ) {
    const response = await callMcpToolViaAPI(request, who, name, args);
    return JSON.parse(
      (response.result as { content: Array<{ text: string }> }).content[0].text
    );
  }
  const posted = await call(agent.id, "post", { chart });
  await page.goto(`/agents/${agent.id}?block=${posted.id}`, {
    waitUntil: "domcontentloaded",
  });
  let card = page
    .locator('[data-kind="chart-card"]')
    .filter({ hasText: "Six-series output" });
  await expect(
    card.getByRole("heading", { name: "Six-series output", exact: true })
  ).toBeVisible();
  await expect(card.getByRole("listitem")).toHaveCount(6);
  await card.getByText("View exact data", { exact: true }).click();
  await expect(card.getByRole("table")).toContainText("Missing");
  await card.getByText("View exact data", { exact: true }).click();
  await call(agent.id, "update", {
    id: posted.id,
    data: { ...chart, title: "Updated output" },
  });
  await expect(
    page.getByRole("heading", { name: "Updated output", exact: true })
  ).toBeVisible();
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(
    page.getByRole("heading", { name: "Updated output", exact: true })
  ).toBeVisible();
  await expect(
    call(other.id, "update", { id: posted.id, data: chart })
  ).rejects.toThrow();
  const reply = await call(agent.id, "post", {
    replyTo: posted.id,
    metric: {
      version: 1,
      title: "Thread metric",
      unit: "items",
      dataKind: "measured",
      value: 123456.125,
    },
  });
  expect(reply.threadId).toBe(posted.id);
  await page.goto(`/agents/${agent.id}?thread=${posted.id}`, {
    waitUntil: "domcontentloaded",
  });
  await expect(
    page.getByRole("heading", { name: "Thread metric", exact: true })
  ).toBeVisible();
  await testInfo.attach("real chart and metric thread", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/agents/${agent.id}?block=${posted.id}`, {
    waitUntil: "domcontentloaded",
  });
  card = page
    .locator('[data-kind="chart-card"]')
    .filter({ hasText: "Updated output" });
  await card.getByText("View exact data", { exact: true }).click();
  await expect(card.getByRole("table")).toContainText("Tuesday");
  await testInfo.attach("mobile exact data", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
});

test("related metric groups adapt to stream width without agent layout options", async ({
  page,
  request,
}, testInfo) => {
  const agent = await createAgentViaAPI(request);
  const group = {
    version: 1,
    title: "Related results",
    items: ["Delivered", "Queued", "Reviewed", "Remaining"].map((title, i) => ({
      kind: "metric",
      data: {
        version: 1,
        title,
        unit: "items",
        dataKind: "synthetic",
        value: 10 + i,
      },
    })),
  };
  const response = await callMcpToolViaAPI(request, agent.id, "post", {
    visualizationGroup: group,
  });
  const posted = JSON.parse(
    (response.result as { content: Array<{ text: string }> }).content[0].text
  );
  await page.goto(`/agents/${agent.id}?block=${posted.id}`, {
    waitUntil: "domcontentloaded",
  });
  const section = page.getByRole("region", {
    name: "Related results",
    exact: true,
  });
  const cards = section.locator('[data-kind="metric-card"]');
  await expect(cards).toHaveCount(4);
  await expect(cards.last()).toBeVisible();
  const first = await cards.first().boundingBox();
  const last = await cards.last().boundingBox();
  expect(Math.abs(first!.y - last!.y)).toBeLessThan(2);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(cards.last()).toBeVisible();
  const mobileFirst = await cards.first().boundingBox();
  const mobileLast = await cards.last().boundingBox();
  expect(mobileLast!.y).toBeGreaterThan(mobileFirst!.y);
  await testInfo.attach("responsive metric group", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
});
