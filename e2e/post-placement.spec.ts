import { expect, test } from "@playwright/test";
import {
  callMcpToolViaAPI,
  cleanupE2EAgents,
  createAgentViaAPI,
} from "./helpers";

test("a child can surface a root outcome while keeping its detail in its home thread", async ({
  page,
  request,
}) => {
  const parent = await createAgentViaAPI(request, {
    name: `e2e-placement-parent-${Date.now()}`,
  });
  const child = await createAgentViaAPI(request, {
    name: "Placement reviewer",
    parentAgentId: parent.id,
  });
  async function post(args: Record<string, unknown>) {
    const response = await callMcpToolViaAPI(request, child.id, "post", args);
    return JSON.parse(
      (response.result as { content: Array<{ text: string }> }).content[0]!.text
    );
  }
  try {
    const home = await post({
      text: "Finding fixed; detailed verification here.",
      placement: "home",
    });
    const root = await post({
      text: "Overall result: change ready for review.",
      placement: "root",
      attachments: [
        { type: "pr", url: "https://github.com/example/repo/pull/42" },
      ],
    });
    expect(home.streamId).toBe(parent.id);
    expect(home.threadId).toBeTruthy();
    expect(root).toMatchObject({
      streamId: parent.id,
      threadId: null,
      replyTo: null,
    });
    const current = await post({
      text: "Routine child progress remains at home.",
      placement: "current",
    });
    expect(current.threadId).toBe(home.threadId);
    await page.goto(`/agents/${parent.id}?thread=${home.threadId}`, {
      waitUntil: "domcontentloaded",
    });
    const thread = page.getByTestId("chat-thread-panel");
    await expect(thread).toContainText(
      "Finding fixed; detailed verification here."
    );
    await expect(thread).toContainText(
      "Routine child progress remains at home."
    );
    await expect(thread).not.toContainText(
      "Overall result: change ready for review."
    );
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await expect(page.getByTestId("chat-pane")).toContainText(
      "Overall result: change ready for review."
    );
    await expect(page.getByTestId("chat-pane")).not.toContainText(
      "Finding fixed; detailed verification here."
    );
  } finally {
    await cleanupE2EAgents(request);
  }
});
