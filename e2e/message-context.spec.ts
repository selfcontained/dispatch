import { expect, test } from "@playwright/test";
import {
  callMcpToolViaAPI,
  cleanupE2EAgents,
  createAgentViaAPI,
} from "./helpers";

test("an addressed agent can retrieve a proposal and its thread without reading unrelated discussions", async ({
  page,
  request,
}) => {
  const author = await createAgentViaAPI(request, {
    name: "e2e-context-author",
  });
  const reader = await createAgentViaAPI(request, {
    name: "e2e-context-reader",
  });
  async function call(
    agentId: string,
    name: string,
    args: Record<string, unknown>
  ) {
    const response = await callMcpToolViaAPI(request, agentId, name, args);
    const result = response.result as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    return {
      error: result.isError,
      value: result.isError
        ? result.content[0].text
        : JSON.parse(result.content[0].text),
    };
  }
  try {
    const proposal = (
      await call(author.id, "post", {
        text: "Proposal: include only the direct parent and root, then retrieve more on demand.",
      })
    ).value;
    const other = (
      await call(author.id, "post", {
        text: "Separate conversation outside this request.",
      })
    ).value;
    expect(
      (await call(reader.id, "get_message", { id: proposal.id })).error
    ).toBe(true);
    await call(author.id, "post", {
      to: reader.id,
      replyTo: proposal.id,
      text: "Can you handle this?",
    });
    const message = await call(reader.id, "get_message", { id: proposal.id });
    expect(message.error).not.toBe(true);
    expect(message.value.content).toContain(
      "include only the direct parent and root"
    );
    const thread = await call(reader.id, "get_thread", { id: proposal.id });
    expect(
      thread.value.messages.map((m: { content: string }) => m.content)
    ).toContain("Can you handle this?");
    expect((await call(reader.id, "get_message", { id: other.id })).error).toBe(
      true
    );
    await page.goto(`/agents/${author.id}?thread=${proposal.id}`, {
      waitUntil: "domcontentloaded",
    });
    await expect(page.getByTestId("chat-thread-panel")).toContainText(
      "Can you handle this?"
    );
    await page.screenshot({
      path: "/tmp/dispatch-context-thread.png",
      animations: "disabled",
    });
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await expect(page.getByTestId("chat-thread-panel")).toBeHidden();
    await expect(page.getByTestId("chat-pane")).toContainText(
      "Proposal: include only"
    );
  } finally {
    await cleanupE2EAgents(request);
  }
});
