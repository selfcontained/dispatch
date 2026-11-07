import { test, expect } from "@playwright/test";
import {
  createAgentViaAPI,
  cleanupE2EAgents,
  loadApp,
  authHeaders,
} from "./helpers";

test.afterEach(async ({ request }) => {
  await cleanupE2EAgents(request);
});
for (const provider of ["claude", "codex"] as const) {
  test(`${provider} inert wire work reaches journal, API, idle UI and history`, async ({
    page,
    request,
  }) => {
    const agent = await createAgentViaAPI(request, {
      name: `Background ${provider}`,
      type: provider,
      initialPrompt: "background-fixture",
    });
    const url = `/api/v1/agents/${agent.id}/background-work`;
    await expect
      .poll(async () =>
        (await request.get(url, { headers: authHeaders() })).json()
      )
      .toMatchObject({
        capability: "supported",
        items: [{ name: "Watch build", state: "paused" }],
      });
    await loadApp(page);
    await page.goto(`/agents/${agent.id}`, { waitUntil: "domcontentloaded" });
    await page
      .getByRole("button", { name: "Background work 1", exact: true })
      .click();
    await page.getByRole("button", { name: /Watch build/ }).click();
    await expect(
      page.getByRole("dialog", { name: "Background work" })
    ).toContainText("paused");
    await expect(
      page
        .getByRole("dialog", { name: "Background work" })
        .getByRole("button", { name: /stop|cancel/i })
    ).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: "View originating turn and tool" })
    ).toBeVisible();
    await page.getByRole("button", { name: "Back to reported work" }).click();
    await page.getByRole("button", { name: "Close background work" }).click();
    await page.reload({ waitUntil: "domcontentloaded" });
    await page
      .getByRole("button", { name: "Background work 1", exact: true })
      .click();
    await expect(
      page.getByRole("dialog", { name: "Background work" })
    ).toContainText("Watch build");
    await request.post(`/api/v1/agents/${agent.id}/stop`, {
      headers: authHeaders(),
      data: { force: true },
    });
    await expect
      .poll(async () =>
        (await request.get(url, { headers: authHeaders() })).json()
      )
      .toMatchObject({ stale: true });
    await page.goto(`/activity/history/${agent.id}`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("button", { name: /Background work/ }).click();
    await expect(
      page.getByRole("dialog", { name: "Background work" })
    ).toContainText("Last reported paused · stale");
  });
}
test("supported empty does not claim no processes", async ({
  page,
  request,
}) => {
  const agent = await createAgentViaAPI(request, { name: "Background empty" });
  await expect
    .poll(async () =>
      (
        await request.get(`/api/v1/agents/${agent.id}/background-work`, {
          headers: authHeaders(),
        })
      ).json()
    )
    .toMatchObject({ capability: "supported", items: [] });
  await loadApp(page);
  await page.goto(`/agents/${agent.id}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: /Background work/ }).click();
  await expect(
    page.getByRole("dialog", { name: "Background work" })
  ).toContainText("No reported background work");
  await expect(
    page.getByRole("dialog", { name: "Background work" })
  ).not.toContainText("No processes running");
});
