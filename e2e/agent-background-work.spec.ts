import { Pool } from "pg";
import { test, expect } from "@playwright/test";
import {
  createAgentViaAPI,
  cleanupE2EAgents,
  loadApp,
  authHeaders,
  seedBlockViaDB,
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
    // Put the actual recorded origin under a discussion to exercise stored
    // conversation navigation, not just the presence of an origin link.
    await expect
      .poll(
        async () =>
          (await (await request.get(url, { headers: authHeaders() })).json())
            .items[0]?.originBlockId
      )
      .toBeTruthy();
    const origin = (
      await (await request.get(url, { headers: authHeaders() })).json()
    ).items[0].originBlockId;
    const thread = await seedBlockViaDB({
      streamId: agent.id,
      authorKind: "user",
      toAgentId: null,
      text: "Background origin discussion",
    });
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    try {
      await pool.query(
        "UPDATE blocks SET thread_id = $2, reply_to = $2 WHERE id = $1 AND author_agent_id = $3",
        [origin, thread, agent.id]
      );
    } finally {
      await pool.end();
    }
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
    await page
      .getByRole("link", { name: "View originating turn and tool" })
      .click();
    await expect(page).toHaveURL(new RegExp(`thread=${thread}`));
    await expect(page.getByTestId("chat-thread-panel")).toBeVisible();
    await expect(page.getByTestId("chat-thread-panel")).toContainText(
      "You said:"
    );
    await page.goBack({ waitUntil: "domcontentloaded" });
    await page
      .getByRole("button", { name: "Background work 1", exact: true })
      .click();
    await page.getByRole("button", { name: /Watch build/ }).click();
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

test("detail failure uses newer list state and offers retry", async ({
  page,
  request,
}) => {
  const agent = await createAgentViaAPI(request, {
    name: "Background detail error",
    initialPrompt: "background-fixture",
  });
  const url = `/api/v1/agents/${agent.id}/background-work`;
  await expect
    .poll(
      async () =>
        (await (await request.get(url, { headers: authHeaders() })).json())
          .items.length
    )
    .toBe(1);
  await loadApp(page);
  await page.goto(`/agents/${agent.id}`, { waitUntil: "domcontentloaded" });
  await page
    .getByRole("button", { name: "Background work 1", exact: true })
    .click();
  await page.getByRole("button", { name: /Watch build/ }).click();
  await expect(
    page.getByRole("dialog", { name: "Background work" })
  ).toContainText("paused");
  const completed = await (
    await request.get(url, { headers: authHeaders() })
  ).json();
  completed.items[0].state = "completed";
  completed.items[0].sequence += 1;
  await page.route(`**${url}`, (route) => route.fulfill({ json: completed }));
  await page.route(`**${url}?detail=*`, (route) =>
    route.fulfill({ status: 503, json: { error: "Inert detail failure" } })
  );
  const dialog = page.getByRole("dialog", { name: "Background work" });
  await expect(dialog).toContainText("completed");
  await expect(dialog.getByRole("alert")).toContainText(
    "Details could not be refreshed",
    { timeout: 15000 }
  );
  await expect(
    dialog.getByRole("button", { name: "Retry details" })
  ).toBeVisible();
});
