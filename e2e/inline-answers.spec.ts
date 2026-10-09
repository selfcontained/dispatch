import { expect, test } from "@playwright/test";
import {
  authHeaders,
  callMcpToolViaAPI,
  cleanupE2EAgents,
  createAgentViaAPI,
} from "./helpers";

test.afterEach(async ({ request }) => {
  await cleanupE2EAgents(request);
});
for (const width of [390, 1280]) {
  test(`questions and forms resolve inline at ${width}px`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const agent = await createAgentViaAPI(request, {
      name: `e2e-inline-${width}`,
    });
    async function post(args: Record<string, unknown>) {
      const result = (await callMcpToolViaAPI(
        request,
        agent.id,
        "post",
        args
      )) as { result: { content: { text: string }[] } };
      return JSON.parse(result.result.content[0]!.text).id as string;
    }
    const q = await post({
      text: "How should supplied databases update?",
      question: {
        options: [{ label: "Add flag" }, { label: "Document only" }],
        allowFreeform: true,
      },
    });
    const form = await post({
      text: "Development setup",
      form: {
        fields: [
          { id: "name", label: "Database", type: "text", required: true },
          { id: "updates", label: "Automatic updates", type: "checkbox" },
        ],
      },
    });
    // Separate rows, not paragraphs: the asks must be outside the first page.
    for (let i = 0; i < 105; i++) {
      await post({
        text: `Progress note ${i + 1}: continuing the database review.`,
      });
    }
    await page.goto(`/agents/${agent.id}`, { waitUntil: "domcontentloaded" });
    const pane = page.getByTestId("chat-pane");
    const badge = page.getByTestId("chat-pending-inputs");
    await expect(badge).toContainText("2");
    await expect(pane.locator(`[data-chat-entry-id="${q}"]`)).toHaveCount(0);
    await badge.click();
    await expect(page).toHaveURL(new RegExp(`block=${q}`));
    const question = pane.locator(`[data-chat-entry-id="${q}"]`);
    await expect(question.getByTestId("chat-question-write")).toBeVisible();
    await expect(pane.getByTestId("chat-pending-question")).toHaveCount(0);
    await expect(question.getByRole("textbox")).toHaveCount(0);
    await expect(question.getByTestId("chat-ask-cancel")).toBeVisible();
    const choiceBounds = await question
      .getByTestId("chat-question-option")
      .first()
      .boundingBox();
    expect(choiceBounds!.height).toBeLessThanOrEqual(32);
    await question.getByTestId("chat-question-write").click();
    await expect(question.getByTestId("chat-input-surface")).toHaveAttribute(
      "data-state",
      "open"
    );
    const input = question.getByRole("textbox", { name: "Your answer" });
    await expect(input).toHaveJSProperty("tagName", "TEXTAREA");
    await expect(
      question.getByRole("button", { name: "Cancel question", exact: true })
    ).toBeVisible();
    await input.fill("Add the flag.\nKeep it opt-in.");
    await question
      .getByRole("button", { name: "Back to choices", exact: true })
      .click();
    await expect(input).toHaveCount(0);
    await question.getByTestId("chat-question-write").click();
    await expect(input).toHaveValue("Add the flag.\nKeep it opt-in.");
    await question.getByLabel("Attach files to answer").setInputFiles({
      name: "diagnostic.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Database diagnostic details"),
    });
    await expect(
      question.getByRole("button", { name: "Remove diagnostic.txt" })
    ).toBeVisible();
    await page.reload({ waitUntil: "domcontentloaded" });
    await question.getByTestId("chat-question-write").click();
    await expect(input).toHaveValue("Add the flag.\nKeep it opt-in.");
    await expect(
      question.getByRole("button", { name: "Remove diagnostic.txt" })
    ).toBeVisible();
    await page.screenshot({
      path: `/tmp/dispatch-question-design/inline-draft-attachments-${width}.png`,
    });
    // A failed save must retain the draft and permit retry.
    await page.route(
      `**/blocks/${q}/answer`,
      (route) =>
        route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "Try again" }),
        }),
      { times: 1 }
    );
    await question.getByRole("button", { name: "Send", exact: true }).click();
    await expect(input).toHaveValue("Add the flag.\nKeep it opt-in.");
    await expect(pane.getByRole("alert")).toBeVisible();
    await question.getByRole("button", { name: "Send", exact: true }).click();
    await expect(question.getByTestId("chat-question-answer")).toContainText(
      "Add the flag.\nKeep it opt-in."
    );
    await expect(question.getByTestId("chat-question-option")).toHaveCount(0);
    await expect(question.getByTestId("chat-question-answer")).toBeInViewport();
    await expect(question.getByTestId("chat-input-surface")).toHaveAttribute(
      "data-state",
      "resolved"
    );
    await expect(badge).toContainText("1");
    await badge.click();
    const fields = pane.locator(`[data-chat-entry-id="${form}"]`);
    await expect(fields.getByTestId("chat-input-surface")).toHaveAttribute(
      "data-state",
      "open"
    );
    await fields.getByLabel("Database").fill("dispatch_dev");
    await fields.getByTestId("chat-form-submit").click();
    await expect(fields.getByTestId("chat-form-value").first()).toContainText(
      "dispatch_dev"
    );
    await expect(fields.getByTestId("chat-input-surface")).toHaveAttribute(
      "data-state",
      "resolved"
    );
    await expect(fields.getByRole("textbox")).toHaveCount(0);
    await expect(badge).toHaveCount(0);
    const saved = await request.get(
      `/api/v1/streams/${agent.id}/blocks/${q}/thread`,
      { headers: authHeaders() }
    );
    const savedBody = await saved.json();
    expect(JSON.stringify(savedBody)).toContain("diagnostic");
    expect(
      await page.evaluate(
        (key) => JSON.parse(localStorage.getItem(key) ?? "{}"),
        `dispatch:questionDraft:${agent.id}:${q}`
      )
    ).toEqual({ text: "", files: [] });

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(question.getByTestId("chat-question-answer")).toContainText(
      "Add the flag.\nKeep it opt-in."
    );
    for (const id of [q, form]) {
      const res = await request.get(
        `/api/v1/streams/${agent.id}/blocks/${id}/thread`,
        { headers: authHeaders() }
      );
      expect((await res.json()).replies).toHaveLength(0);
    }
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth
      )
    ).toBe(true);
    await page.screenshot({
      path: `/tmp/dispatch-question-design/e2e-inline-${width}.png`,
      fullPage: true,
    });
  });
}

test("nested asks remain parent-owned and only root escalations count as user input", async ({
  page,
  request,
}) => {
  const root = await createAgentViaAPI(request, { name: "e2e-nested-root" });
  const child = await createAgentViaAPI(request, {
    name: "e2e-nested-child",
    parentAgentId: root.id,
  });
  const grandchild = await createAgentViaAPI(request, {
    name: "e2e-nested-grandchild",
    parentAgentId: child.id,
  });
  const response = (await callMcpToolViaAPI(request, grandchild.id, "post", {
    text: "Grandchild needs a decision",
    question: { options: [{ label: "Proceed" }] },
  })) as { result: { content: { text: string }[] } };
  const questionId = JSON.parse(response.result.content[0]!.text).id;
  await page.goto(`/agents/${root.id}`, { waitUntil: "domcontentloaded" });
  for (const show of [false, true]) {
    await page.getByTestId("chat-filters-trigger").click();
    await page
      .getByRole("switch", { name: "Show child messages" })
      .setChecked(show);
    await page.keyboard.press("Escape");
    await page.reload({ waitUntil: "domcontentloaded" });
    const saved = await request.get(
      `/api/v1/streams/${root.id}/blocks/${questionId}/thread`,
      { headers: authHeaders() }
    );
    expect((await saved.json()).root).toMatchObject({
      toAgentId: root.id,
      data: { parentHandled: true },
    });
    await expect(page.getByTestId("chat-pending-inputs")).toHaveCount(0);
  }
  await callMcpToolViaAPI(request, root.id, "post", {
    text: "I need your decision before answering the child",
    question: { options: [{ label: "Proceed" }] },
  });
  await expect(page.getByTestId("chat-pending-inputs")).toContainText("1");
});
