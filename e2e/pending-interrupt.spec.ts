import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { block, blockEntry } from "../apps/web/src/test-utils/blocks";
import { cleanupE2EAgents, createAgentViaAPI, loadApp } from "./helpers";

test("pending delivery can stop runtime work without a persisted turn", async ({
  page,
  request,
}) => {
  const agent = await createAgentViaAPI(request);
  const root = block({
    id: randomUUID(),
    streamId: agent.id,
    authorKind: "user",
    text: "Please change direction.",
    delivery: [{ agentId: agent.id, state: "pending" }],
  });
  let active = true;
  let cancels = 0;
  let failStop = false;
  let becomeHeld = false;
  const interrupts: unknown[] = [];
  try {
    // Keep the real idle runtime's SSE snapshot from replacing the active fixture.
    await page.route("**/api/v1/events", (route) =>
      route.fulfill({
        contentType: "text/event-stream",
        body: "retry: 60000\n\n",
      })
    );
    await page.route("**/api/v1/agents", async (route) => {
      const response = await route.fetch();
      const json = await response.json();
      json.agents = json.agents.map((item: { id: string }) =>
        item.id === agent.id
          ? {
              ...item,
              status: "running",
              currentTurn: null,
              inputState: {
                active,
                steeringSupported: true,
                interruptSupported: true,
                conversation: { streamId: agent.id, threadId: null },
              },
            }
          : item
      );
      await route.fulfill({ response, json });
    });
    await page.route(`**/api/v1/streams/${agent.id}/blocks?*`, (route) =>
      route.fulfill({
        json: {
          entries: [blockEntry(root)],
          hasMore: false,
          nextCursor: null,
          unreadCount: 0,
          openInputs: [],
          threadLinks: [],
          agentNames: {},
        },
      })
    );
    await page.route(
      `**/api/v1/agents/${agent.id}/runtime/cancel`,
      async (route) => {
        cancels++;
        await route.fulfill(
          failStop
            ? { status: 500, json: { error: "Temporary stop failure" } }
            : { json: { ok: true } }
        );
      }
    );
    await page.route(
      `**/api/v1/streams/${agent.id}/blocks/${root.id}/send-now`,
      async (route) => {
        interrupts.push(route.request().postDataJSON());
        if (becomeHeld) root.delivery = [{ agentId: agent.id, state: "held" }];
        await route.fulfill({ json: { ok: true } });
      }
    );
    await page.route(
      `**/api/v1/streams/${agent.id}/blocks/${root.id}/thread`,
      (route) =>
        route.fulfill({
          json: {
            root: {
              ...root,
              delivered: true,
              delivery: [{ agentId: agent.id, state: "delivered" }],
            },
            replies: [],
            recipients: [agent.id],
          },
        })
    );
    await loadApp(page);
    for (const width of [1440, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/agents/${agent.id}`, { waitUntil: "domcontentloaded" });
      const composerStop = page
        .getByTestId("chat-composer")
        .getByTestId("chat-stop-turn");
      await expect(composerStop).toBeVisible();
      await expect(composerStop).toBeEnabled();
      await expect(page.getByTestId("chat-stop-turn")).toHaveCount(1);
      const indicator = page.getByTestId("chat-delivery-pending");
      await expect(indicator).toBeVisible();
      expect(
        await indicator.evaluate((el) => getComputedStyle(el).animationName)
      ).toBe("none");
      const sendNow = page.getByRole("button", {
        name: "Send now",
        exact: true,
      });
      await expect(sendNow).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Delete", exact: true })
      ).toHaveCount(0);
      await sendNow.click();
      await expect(
        page.getByRole("button", { name: "Interrupt requested" })
      ).toBeDisabled();
      await expect.poll(() => interrupts.length).toBe(width === 1440 ? 1 : 2);
      expect(interrupts.at(-1)).toEqual({
        interrupt: true,
        keepDelivery: true,
      });
      await composerStop.click();
      await expect(composerStop).toBeDisabled();
      await expect.poll(() => cancels).toBe(width === 1440 ? 1 : 3);
      await page.goto(`/agents/${agent.id}?thread=${root.id}`, {
        waitUntil: "domcontentloaded",
      });
      const threadStop = page
        .locator('[data-testid="chat-thread-panel"]:visible')
        .getByTestId("chat-composer")
        .getByTestId("chat-stop-turn");
      await expect(threadStop).toBeVisible();
      await expect(threadStop).toBeEnabled();
      await threadStop.click();
      await expect(threadStop).toBeDisabled();
      await expect.poll(() => cancels).toBe(width === 1440 ? 2 : 4);
    }
    becomeHeld = true;
    await page.goto(`/agents/${agent.id}`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Send now", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Delete", exact: true })
    ).toBeEnabled();
    await expect(
      page.getByRole("button", { name: "Send now", exact: true })
    ).toBeEnabled();
    await page.screenshot({
      path: "/tmp/dispatch-review-held.png",
      fullPage: true,
    });

    await page.goto(`/agents/${agent.id}?thread=${root.id}`, {
      waitUntil: "domcontentloaded",
    });
    const stop = page
      .locator('[data-testid="chat-thread-panel"]:visible')
      .getByTestId("chat-stop-turn");
    await expect(stop).toBeEnabled();
    failStop = true;
    await stop.click();
    const stopError = page.getByTestId("chat-thread-action-error");
    await expect(stopError).toContainText("Temporary stop failure");
    await page.screenshot({
      path: "/tmp/dispatch-review-stop-error.png",
      fullPage: true,
    });
    await expect(stop).toBeEnabled();
    failStop = false;
    await stop.click();
    await expect(stopError).toHaveCount(0);
    await page.screenshot({
      path: "/tmp/dispatch-review-stop-retry.png",
      fullPage: true,
    });
    active = false;
    const agentsLoaded = page.waitForResponse("**/api/v1/agents");
    await page.goto(`/agents/${agent.id}`, { waitUntil: "domcontentloaded" });
    await agentsLoaded;
    await expect(page.getByTestId(`agent-row-${agent.id}`)).toHaveCount(1);
    await expect(
      page.getByRole("button", { name: "Send now", exact: true })
    ).toBeVisible();
    await expect(page.getByTestId("chat-stop-turn")).toBeDisabled();
    await expect(page.getByTestId("chat-stop-turn")).not.toHaveAttribute(
      "data-active",
      "true"
    );
  } finally {
    await cleanupE2EAgents(request);
  }
});
