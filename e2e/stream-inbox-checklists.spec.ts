import { expect, test } from "@playwright/test";
import {
  callMcpToolViaAPI,
  cleanupE2EAgents,
  createAgentViaAPI,
} from "./helpers";

test.use({ deviceScaleFactor: 2 });

function postedId(response: Record<string, unknown>): string {
  return JSON.parse(
    (response.result as { content: Array<{ text: string }> }).content[0]!.text
  ).id;
}

for (const width of [1280, 390]) {
  test(`live direct and child checklist progress opens the original message at ${width}px`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(() =>
      localStorage.setItem("dispatch:chatShowChildAgents", "true")
    );
    const parent = await createAgentViaAPI(request, {
      name: `e2e-checklist-parent-${width}-${Date.now()}`,
    });
    const child = await createAgentViaAPI(request, {
      name: "Checklist builder",
      parentAgentId: parent.id,
    });
    const unrelated = await createAgentViaAPI(request, {
      name: "Other checklist stream",
    });
    try {
      await callMcpToolViaAPI(request, unrelated.id, "post", {
        text: "Other stream only",
        tasks: { items: [{ id: "x", text: "Private progress" }] },
      });
      await page.goto(`/agents/${parent.id}`, {
        waitUntil: "domcontentloaded",
      });
      await expect(page.getByTestId("chat-pane")).toBeVisible();
      const openInbox = async () => {
        await expect(
          page.getByTestId("chat-composer").getByRole("textbox")
        ).toBeEditable();
        const sidebar = page.getByTestId("drawer");
        const opener = page.getByTestId("toggle-drawer");
        // Closed drawers stay mounted offscreen, so isVisible() on their
        // content does not mean the drawer has been opened.
        if (await opener.isVisible()) await opener.click();
        await expect(sidebar.getByTestId("sidebar-tab-inbox")).toBeInViewport();
        await sidebar.getByTestId("sidebar-tab-inbox").click();
        return sidebar.getByTestId("inbox");
      };
      let inbox = await openInbox();
      // Both post and update use the real per-agent MCP endpoint while the
      // browser is mounted; no cache/DB seed or reload can hide a live bug.
      for (const [agent, title] of [
        [parent, "Direct plan"],
        [child, "Child home plan"],
      ] as const) {
        const id = postedId(
          await callMcpToolViaAPI(request, agent.id, "post", {
            text: title,
            tasks: {
              items: [
                { id: "one", text: "Implement" },
                { id: "two", text: "Verify" },
              ],
            },
            placement: "home",
          })
        );
        const card = inbox
          .getByTestId("inbox-checklist")
          .filter({ hasText: title });
        await expect(card).toHaveCount(1);
        await expect(card).toContainText("0/2 done");
        await callMcpToolViaAPI(request, agent.id, "update", {
          id,
          state: { items: { one: "done", two: "now" } },
        });
        await expect(card).toContainText("1/2 done");
        await expect(card).toContainText("Now: Verify");
        await expect(inbox).not.toContainText("Other stream only");
        const progressScreenshot = `/tmp/dispatch-checklist-${width}-${agent.id}-progress.png`;
        await page.screenshot({ path: progressScreenshot, fullPage: true });
        await test.info().attach(`${title} progress ${width}`, {
          path: progressScreenshot,
          contentType: "image/png",
        });
        await card.click();
        await expect(page).toHaveURL(new RegExp(`thread=${id}`));
        const thread =
          width < 768 ? page.getByRole("dialog", { name: "Thread" }) : page;
        const source = thread.getByTestId("chat-thread-panel");
        await expect(source.getByTestId("chat-tasks-block")).toBeVisible();
        await expect(source).toContainText(title);
        await expect(source).toContainText("Verify");
        const sourceScreenshot = `/tmp/dispatch-checklist-${width}-${agent.id}-source.png`;
        await page.screenshot({ path: sourceScreenshot, fullPage: true });
        await test.info().attach(`${title} original ${width}`, {
          path: sourceScreenshot,
          contentType: "image/png",
        });
        await thread.getByTestId("drawer-close").click();
        inbox = await openInbox();
        await callMcpToolViaAPI(request, agent.id, "update", {
          id,
          state: { items: { two: "done" } },
        });
        await expect(
          inbox.getByTestId("inbox-checklist").filter({ hasText: title })
        ).toContainText("2/2 done");
      }
      await page.reload({ waitUntil: "domcontentloaded" });
      inbox = await openInbox();
      await expect(inbox.getByTestId("inbox-checklist")).toHaveCount(2);
      await expect(inbox.getByTestId("inbox-checklist-progress")).toHaveText([
        "2/2 done",
        "2/2 done",
      ]);
      // A child's own page uses the same root stream, but only its own lists.
      await page.goto(`/agents/${child.id}`, { waitUntil: "domcontentloaded" });
      inbox = await openInbox();
      await expect(inbox.getByTestId("inbox-checklist")).toHaveCount(1);
      await expect(inbox).toContainText("Child home plan");
      await inbox.getByTestId("inbox-checklist").click();
      const thread =
        width < 768 ? page.getByRole("dialog", { name: "Thread" }) : page;
      await expect(thread.getByTestId("chat-thread-panel")).toContainText(
        "Child home plan"
      );
    } finally {
      await cleanupE2EAgents(request);
    }
  });
}
