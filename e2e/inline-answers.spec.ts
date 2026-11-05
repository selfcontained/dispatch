import { expect, test } from "@playwright/test";
import {
  callMcpToolViaAPI,
  cleanupE2EAgents,
  createAgentViaAPI,
} from "./helpers";

test.afterEach(async ({ request }) => {
  await cleanupE2EAgents(request);
});

test("answer an agent question and form, then reload the saved answers", async ({
  page,
  request,
}, testInfo) => {
  const agent = await createAgentViaAPI(request, {
    name: `e2e-answers-${testInfo.testId}`,
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
  const questionId = await post({
    text: "Choose the release scope",
    question: {
      options: [{ label: "Core journeys" }, { label: "All surfaces" }],
    },
  });
  const formId = await post({
    text: "Release details",
    form: {
      fields: [
        { id: "name", label: "Release name", type: "text", required: true },
      ],
    },
  });
  await page.goto(`/agents/${agent.id}`, { waitUntil: "domcontentloaded" });
  const question = page.locator(`[data-chat-entry-id="${questionId}"]`);
  await question
    .getByRole("button", { name: "Core journeys", exact: true })
    .click();
  await expect(question.getByTestId("chat-question-answer")).toContainText(
    "Core journeys"
  );
  const form = page.locator(`[data-chat-entry-id="${formId}"]`);
  await form.getByLabel("Release name").fill("Focused regression suite");
  const saved = page.waitForResponse(
    (res) =>
      new URL(res.url()).pathname.endsWith(`/blocks/${formId}/submit`) &&
      res.request().method() === "POST"
  );
  await form.getByTestId("chat-form-submit").click();
  expect((await saved).ok()).toBeTruthy();
  await expect(form.getByTestId("chat-form-value")).toContainText(
    "Focused regression suite"
  );
  await page.goto(`/agents/${agent.id}?block=${questionId}`, {
    waitUntil: "domcontentloaded",
  });
  await expect(question.getByTestId("chat-question-answer")).toContainText(
    "Core journeys"
  );
  // The live engine adds turns after each answer. Navigate to the saved form
  // rather than assuming both asks remain mounted in the virtualized feed.
  await page.goto(`/agents/${agent.id}?block=${formId}`, {
    waitUntil: "domcontentloaded",
  });
  await expect(form.getByTestId("chat-form-value")).toContainText(
    "Focused regression suite"
  );
  await testInfo.attach("answers persisted", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
});
