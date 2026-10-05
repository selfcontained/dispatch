import { expect, test } from "@playwright/test";
import {
  authHeaders,
  callMcpToolViaAPI,
  cleanupE2EAgents,
  createAgentViaAPI,
} from "./helpers";

function postedId(post: Record<string, unknown>): string {
  return JSON.parse(
    (post.result as { content: Array<{ text: string }> }).content[0]!.text
  ).id;
}

for (const mobile of [false, true]) {
  test(`thread questions and child forms mirror and link to their source (${mobile ? "mobile" : "desktop"})`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize(
      mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }
    );
    const parent = await createAgentViaAPI(request, {
      name: `e2e-mirrored-parent-${Date.now()}`,
    });
    const child = await createAgentViaAPI(request, {
      name: "Input helper",
      parentAgentId: parent.id,
    });
    const host = postedId(
      await callMcpToolViaAPI(request, parent.id, "post", {
        text: "Release discussion",
        tasks: { items: [{ id: "plan", text: "Choose release details" }] },
      })
    );
    await page.goto(`/agents/${parent.id}`, { waitUntil: "domcontentloaded" });
    const pane = page.getByTestId("chat-pane");
    await expect(pane).toBeVisible();
    // Post after the feed is mounted: this exercises the live SSE path.
    const question = postedId(
      await callMcpToolViaAPI(request, parent.id, "post", {
        replyTo: host,
        text: "Which release channel?",
        question: { options: [{ label: "Stable" }, { label: "Beta" }] },
      })
    );
    const form = postedId(
      await callMcpToolViaAPI(request, child.id, "post", {
        text: "Release notes from the helper",
        form: {
          title: "Release details",
          fields: [
            { id: "note", label: "Release note", type: "text", required: true },
          ],
        },
      })
    );
    const mirroredQuestion = pane.locator(`[data-chat-entry-id="${question}"]`);
    const mirroredForm = pane.locator(`[data-chat-entry-id="${form}"]`);
    await expect(mirroredQuestion).toContainText("Which release channel?");
    await expect(mirroredForm).toContainText("Release details");
    await mirroredQuestion.getByTestId("chat-input-source").click();
    await expect(page).toHaveURL(
      new RegExp(`thread=${host}&block=${question}`)
    );
    const thread = page.locator('[data-testid="chat-thread-panel"]:visible');
    const sourceQuestion = thread.locator(`[data-chat-entry-id="${question}"]`);
    await expect(sourceQuestion).toBeVisible();
    await expect(sourceQuestion).toHaveAttribute("data-jump-flash", "");
    // Wait for the drawer's entrance animation before capturing its layout.
    await expect
      .poll(async () => {
        const box = await thread.boundingBox();
        return (
          box !== null &&
          box.x >= 0 &&
          box.x + box.width <= page.viewportSize()!.width + 1
        );
      })
      .toBe(true);
    await page.screenshot({
      path: `/tmp/dispatch-mirrored-${mobile ? "mobile" : "desktop"}-source.png`,
      fullPage: true,
    });
    // Desktop answers in the mirror while the original is visible; mobile answers in the source.
    await (mobile ? sourceQuestion : mirroredQuestion)
      .getByTestId("chat-question-option")
      .filter({ hasText: "Beta" })
      .click();
    await expect(sourceQuestion).toContainText("Answered");
    await page.locator('[data-testid="drawer-close"]:visible').click();
    await expect(mirroredQuestion).toContainText("Answered");
    await expect(
      mirroredQuestion.getByTestId("chat-question-option")
    ).toHaveCount(0);
    await mirroredForm.getByTestId("chat-input-source").click();
    const sourceForm = thread.locator(`[data-chat-entry-id="${form}"]`);
    await expect(sourceForm).toBeVisible();
    // Labels must target this form's own controls when two copies are mounted.
    await sourceForm
      .getByLabel("Release note")
      .fill("Ship the visibility fix.");
    await sourceForm.getByTestId("chat-form-submit").click();
    await expect(sourceForm).toContainText("submitted");
    await page.locator('[data-testid="drawer-close"]:visible').click();
    await expect(mirroredForm).toContainText("Ship the visibility fix.");
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(mirroredQuestion).toContainText("Answered");
    await expect(mirroredForm).toContainText("submitted");
    await expect(mirroredForm.getByTestId("chat-input-source")).toBeVisible();
    const res = await request.get(`/api/v1/streams/${parent.id}/blocks`, {
      headers: authHeaders(),
    });
    const feed = await res.json();
    expect(
      feed.entries.filter((entry: { id: string }) => entry.id === question)
    ).toHaveLength(1);
    expect(
      feed.entries.filter((entry: { id: string }) => entry.id === form)
    ).toHaveLength(1);
    await page.screenshot({
      path: `/tmp/dispatch-mirrored-${mobile ? "mobile" : "desktop"}-answered.png`,
      fullPage: true,
    });
  });
}

test.afterEach(async ({ request }) => {
  await cleanupE2EAgents(request);
});
