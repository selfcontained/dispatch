import { expect, test } from "@playwright/test";

import {
  authHeaders,
  callMcpToolViaAPI,
  cleanupE2EAgents,
  createAgentViaAPI,
  loadApp,
} from "./helpers";

test.afterEach(async ({ request }) => {
  await cleanupE2EAgents(request);
});

for (const width of [1280, 390]) {
  test.describe(`Sidebar input indicator at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 }, deviceScaleFactor: 2 });

    test("ignores unread replies, survives reading, and clears after answering and canceling", async ({
      page,
      request,
    }) => {
      const agent = await createAgentViaAPI(request, {
        name: `e2e-sidebar-input-${width}`,
      });
      await callMcpToolViaAPI(request, agent.id, "post", {
        text: "An unread reply that needs no decision",
      });
      await loadApp(page);
      if (width === 390) {
        const openSidebar = page.getByTitle("Open sidebar");
        if (await openSidebar.isVisible()) await openSidebar.click();
        await expect(
          page.getByTestId("sidebar-shell").getByTitle("Close sidebar")
        ).toBeInViewport();
      }
      const row = page.getByTestId(`agent-row-${agent.id}`);
      const indicator = row.getByRole("img", { name: "Needs your input" });
      await expect(row).toBeVisible();
      await expect(indicator).toHaveCount(0);
      const post = async (args: Record<string, unknown>) => {
        const result = (await callMcpToolViaAPI(
          request,
          agent.id,
          "post",
          args
        )) as {
          result: { content: { text: string }[] };
        };
        return JSON.parse(result.result.content[0]!.text).id as string;
      };
      const questionId = await post({
        text: "Which option should we use?",
        question: { options: [{ label: "Proceed" }, { label: "Wait" }] },
      });
      const formId = await post({
        text: "Release details",
        form: {
          fields: [{ id: "note", label: "Note", type: "text", required: true }],
        },
      });
      await expect(indicator).toHaveCount(1);
      await expect(indicator).toHaveText("");
      await expect(indicator.locator("svg")).toHaveCount(1);
      await indicator.focus();
      await expect(page.getByRole("tooltip")).toHaveText("Needs your input");
      await page.keyboard.press("Escape");
      await page.screenshot({
        path: test.info().outputPath(`sidebar-input-pending-${width}.png`),
      });

      // This informational target must still select the containing header.
      await indicator.click();
      await expect(page).toHaveURL(new RegExp(`/agents/${agent.id}$`));
      await expect(page.getByTestId("chat-pane")).toBeVisible();
      await expect
        .poll(async () => {
          const res = await request.get("/api/v1/chat/unread", {
            headers: authHeaders(),
          });
          const summary = await res.json();
          return summary.agents[agent.id]?.unread ?? 0;
        })
        .toBe(0);
      if (width === 390) await page.getByTitle("Open sidebar").click();
      await expect(indicator).toBeVisible();
      await expect(indicator).toHaveText("");
      if (width === 390)
        await page
          .getByTestId("sidebar-shell")
          .getByTitle("Close sidebar")
          .click();

      const pane = page.getByTestId("chat-pane");
      const question = pane.locator(`[data-chat-entry-id="${questionId}"]`);
      await question
        .getByTestId("chat-question-option")
        .filter({ hasText: "Proceed" })
        .click();
      await expect(question.getByTestId("chat-question-answer")).toContainText(
        "Proceed"
      );
      const form = pane.locator(`[data-chat-entry-id="${formId}"]`);
      if (width === 1280) {
        await expect(indicator).toBeVisible();
        await form
          .getByRole("textbox", { name: "Note *", exact: true })
          .fill("Ready for review");
        await form.getByTestId("chat-form-submit").click();
        await expect(form.getByTestId("chat-form-value")).toContainText(
          "Ready for review"
        );
      } else {
        await form.getByTestId("chat-ask-cancel").click();
        await expect(form.getByTestId("chat-ask-canceled")).toBeVisible();
        await page.getByTitle("Open sidebar").click();
      }
      await expect(indicator).toHaveCount(0);
      await page.screenshot({
        path: test.info().outputPath(`sidebar-input-resolved-${width}.png`),
      });
    });
  });
}
