import { expect, test } from "@playwright/test";
import { authHeaders, cleanupE2EAgents, createAgentViaAPI } from "./helpers";

for (const mobile of [false, true]) {
  test(`permission choices, reload, disconnect and errors (${mobile ? "mobile" : "desktop"})`, async ({
    page,
    request,
  }) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    const agent = await createAgentViaAPI(request, { fullAccess: false });
    const permission = {
      id: "permission-1",
      toolCallId: "call-1",
      title: "Run workspace validation",
      details: "pnpm run check",
      createdAt: new Date().toISOString(),
      options: [
        { optionId: "once", name: "Allow once", kind: "allow_once" },
        {
          optionId: "always",
          name: "Yes, and don't ask again for commands that start with `npm install`",
          kind: "allow_always",
        },
        { optionId: "reject", name: "Deny", kind: "reject_once" },
      ],
    };
    let pending = true;
    let connected = true;
    let fail = true;
    const choices: string[] = [];
    await page.route(
      `**/api/v1/agents/${agent.id}/permissions**`,
      async (route) => {
        if (route.request().method() === "POST") {
          if (fail) {
            await route.fulfill({
              status: 409,
              json: { error: "The host is reconnecting. Try again." },
            });
            return;
          }
          choices.push(route.request().postDataJSON().optionId);
          pending = false;
        }
        await route.fulfill({
          json: { connected, requests: pending ? [permission] : [] },
        });
      }
    );
    await page.goto(`/agents/${agent.id}`, { waitUntil: "domcontentloaded" });
    const panel = page.getByTestId("permission-requests");
    await expect(panel).toContainText("pnpm run check");
    for (const button of await panel.getByRole("button").all()) {
      expect(
        await button.evaluate(
          (element) => element.scrollHeight <= element.clientHeight
        )
      ).toBe(true);
    }
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(panel).toContainText("Approval needed");
    connected = false;
    await expect(
      panel.getByRole("button", { name: "Allow once", exact: true })
    ).toBeDisabled();
    await expect(panel).toContainText("No permission has been granted.");
    connected = true;
    await expect(
      panel.getByRole("button", { name: "Allow once", exact: true })
    ).toBeEnabled();
    await panel
      .getByRole("button", { name: "Allow once", exact: true })
      .click();
    await expect(panel.getByRole("alert")).toContainText("Try again");
    fail = false;
    await panel
      .getByRole("button", { name: "Allow once", exact: true })
      .click();
    await expect(panel).toHaveCount(0);
    pending = true;
    permission.id = "permission-2";
    await expect(panel).toBeVisible();
    await panel.getByRole("button", { name: "Deny", exact: true }).click();
    await expect(panel).toHaveCount(0);
    expect(choices).toEqual(["once", "reject"]);
    const root = await request.post(`/api/v1/streams/${agent.id}/blocks`, {
      headers: authHeaders(),
      data: { text: "Discuss this change" },
    });
    const blockId = (await root.json()).block.id;
    pending = true;
    permission.id = "permission-thread";
    await page.goto(`/agents/${agent.id}?thread=${blockId}`, {
      waitUntil: "domcontentloaded",
    });
    const threadPanel = page
      .locator('[data-testid="drawer-page"][data-top="true"]:visible')
      .getByTestId("permission-requests");
    await expect(threadPanel).toBeVisible();
    await expect(
      page.getByTestId("chat-pane").getByTestId("permission-requests")
    ).toHaveCount(0);
    await threadPanel
      .getByRole("button", {
        name: "Yes, and don't ask again for commands that start with `npm install`",
        exact: true,
      })
      .click();
    await expect(threadPanel).toHaveCount(0);
    expect(choices).toEqual(["once", "reject", "always"]);
    await cleanupE2EAgents(request);
  });
}
