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
  test(`${provider} shows only current background work and removes finished reports`, async ({
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
        status: "supported",
        items: [{ name: "Watch build", state: "paused" }],
      });
    await loadApp(page);
    await page.goto(`/agents/${agent.id}`, { waitUntil: "domcontentloaded" });
    await page
      .getByRole("button", { name: "Background work 1", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "Background work" });
    await expect(dialog).toContainText("Watch build");
    await expect(dialog).toContainText("paused");
    await expect(
      dialog.getByRole("button", { name: /stop|cancel/i })
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Close background work" }).click();
    await expect(dialog).toBeHidden();
    await page
      .getByTestId("chat-composer-input")
      .fill("background-finish-fixture");
    await page.getByTestId("chat-composer-send").click();
    await expect
      .poll(async () =>
        (await request.get(url, { headers: authHeaders() })).json()
      )
      .toEqual({ status: "supported", items: [] });
    await page
      .getByRole("button", { name: "Background work", exact: true })
      .click();
    await expect(dialog).toContainText("No reported background work.");
    await page.getByRole("button", { name: "Close background work" }).click();
    await request.post(`/api/v1/agents/${agent.id}/stop`, {
      headers: authHeaders(),
      data: { force: true },
    });
    await expect
      .poll(async () =>
        (await request.get(url, { headers: authHeaders() })).json()
      )
      .toEqual({ status: "offline", items: [] });
  });
}
