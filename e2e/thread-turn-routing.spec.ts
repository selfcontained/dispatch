import { expect, test } from "@playwright/test";
import {
  authHeaders,
  callMcpToolViaAPI,
  cleanupE2EAgents,
  createAgentViaAPI,
} from "./helpers";

test.use({ deviceScaleFactor: 2 });
test.afterEach(async ({ request }) => {
  await cleanupE2EAgents(request);
});

for (const mobile of [false, true]) {
  test(`thread turns and explicit steering preserve output location (${mobile ? "mobile" : "desktop"})`, async ({
    page,
    request,
  }, testInfo) => {
    test.setTimeout(90_000);
    expect(process.env.DISPATCH_AGENT_RUNTIME).toBe("acp");
    await page.setViewportSize(
      mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }
    );
    const agent = await createAgentViaAPI(request, {
      name: `e2e-thread-routing-${mobile}`,
    });
    await expect
      .poll(
        async () =>
          (
            await (
              await request.get(`/api/v1/agents/${agent.id}`, {
                headers: authHeaders(),
              })
            ).json()
          ).agent.status
      )
      .toBe("running");
    async function call(name: string, args: Record<string, unknown> = {}) {
      const result = await callMcpToolViaAPI(request, agent.id, name, args);
      return JSON.parse(
        (result.result as { content: { text: string }[] }).content[0]!.text
      );
    }
    async function send(text: string, replyTo?: string) {
      const res = await request.post(`/api/v1/streams/${agent.id}/blocks`, {
        headers: authHeaders(),
        data: { text, ...(replyTo ? { replyTo } : {}) },
      });
      expect(res.ok(), await res.text()).toBe(true);
      return (await res.json()).block;
    }
    async function location(threadId: string | null) {
      await expect
        .poll(
          async () =>
            (await call("get_conversation_context")).current?.threadId,
          { timeout: 20_000 }
        )
        .toBe(threadId);
    }
    async function capture(name: string) {
      const path = `/tmp/thread-turn-${mobile ? "mobile" : "desktop"}-${name}.png`;
      await page.screenshot({ path, fullPage: true });
      await testInfo.attach(name, { path, contentType: "image/png" });
    }
    const root = await call("post", { text: "Routing discussion" });
    await page.goto(`/agents/${agent.id}?block=${root.id}`, {
      waitUntil: "domcontentloaded",
    });
    await page
      .locator(`[data-chat-entry-id="${root.id}"]`)
      .getByRole("button", { name: "Reply in thread" })
      .click();
    const editor = page.locator(
      '[data-placeholder="Reply in thread…"]:visible'
    );
    await editor.fill("idle thread sleep:10000");
    await editor.press("Enter");
    await location(root.id);
    await expect(
      page.getByTestId("chat-thread-panel").filter({ visible: true })
    ).toContainText("Waiting for the requested delay");
    await capture("idle-start");
    async function executionTurnId(blockId: string) {
      const response = await request.get(
        `/api/v1/streams/${agent.id}/blocks/${root.id}/thread`,
        { headers: authHeaders() }
      );
      expect(response.ok()).toBe(true);
      const thread = await response.json();
      const block = thread.replies.find(
        (reply: { id: string }) => reply.id === blockId
      );
      expect(block?.data?.turnEventId).toBeDefined();
      return block.data.turnEventId;
    }
    const initial = await call("get_conversation_context");
    const initialExecution = await executionTurnId(initial.activeTurnId);
    await send("same discussion steering", root.id);
    const discussion = page
      .getByTestId("chat-thread-panel")
      .filter({ visible: true });
    await expect(
      discussion
        .getByTestId("chat-thread-turn")
        .filter({ hasText: "Steered:" })
        .filter({ hasText: "same discussion steering" })
    ).toBeVisible();
    const steered = await call("get_conversation_context");
    expect(steered.current).toEqual(initial.current);
    // A pickup may split the response block, but must keep the execution turn.
    expect(await executionTurnId(steered.activeTurnId)).toBe(initialExecution);
    await expect
      .poll(async () => (await call("get_conversation_context")).current, {
        timeout: 15_000,
      })
      .toBeNull();

    await send("independent home sleep:12000");
    await location(null);
    await send("queued thread steering", root.id);
    const panel = page
      .getByTestId("chat-thread-panel")
      .filter({ visible: true });
    await expect(
      panel.getByText("Queued for a reply here", { exact: true })
    ).toBeVisible();
    await panel
      .getByRole("button", { name: "Send now", exact: true })
      .scrollIntoViewIfNeeded();
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(
      panel.getByText("Queued for a reply here", { exact: true })
    ).toBeVisible();
    await capture("queued");
    await panel.getByRole("button", { name: "Send now", exact: true }).click();
    await location(null);
    await expect(
      panel.getByText("Queued for a reply here", { exact: true })
    ).toHaveCount(0);
    await page.goto(`/agents/${agent.id}`, { waitUntil: "domcontentloaded" });
    await expect(
      page.getByText("Steered:", { exact: false }).first()
    ).toBeVisible();
    await capture("send-now-home-unmoved");
    await page.goto(`/agents/${agent.id}?thread=${root.id}`, {
      waitUntil: "domcontentloaded",
    });
    await expect
      .poll(async () => (await call("get_conversation_context")).current, {
        timeout: 20_000,
      })
      .toBeNull();

    await send("next home sleep:4000");
    await location(null);
    await send("queued next thread sleep:5000", root.id);
    await page.reload({ waitUntil: "domcontentloaded" });
    await location(root.id);
    const released = await call("get_conversation_context");
    expect(released.activeTurnId).not.toBe(initial.activeTurnId);
    await expect(
      page
        .getByTestId("chat-thread-panel")
        .filter({ visible: true })
        .locator(`[data-chat-entry-id="${released.activeTurnId}"]`)
    ).toContainText("Waiting for the requested delay");
    await capture("queue-released-after-reload");
  });
}
