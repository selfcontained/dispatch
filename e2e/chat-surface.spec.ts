import { expect, test } from "@playwright/test";

import {
  authHeaders,
  callMcpToolViaAPI as callMcpTool,
  cleanupE2EAgents,
  clickAgentRow,
  createAgentViaAPI,
  loadApp,
  seedBlockViaDB,
  seedChatMessageViaDB,
} from "./helpers";

test.describe("Chat surface", () => {
  test.afterEach(async ({ request }) => {
    await cleanupE2EAgents(request);
  });

  test("Agent tab renders a seeded feed", async ({ page, request }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-chat-on-${Date.now()}`,
    });
    await loadApp(page);

    // Seed a feed the way an agent would: chat posts.
    await callMcpTool(request, agent.id, "post", {
      text: "Tests are **green**. Two files changed.",
      attachments: [
        { type: "link", url: "https://example.com/report", title: "Report" },
        {
          type: "code",
          code: "const ok = true;",
          language: "ts",
          path: "ok.ts",
        },
      ],
    });
    await callMcpTool(request, agent.id, "post", {
      text: "Ship it now or wait for review?",
      question: {
        options: [{ label: "Ship it" }, { label: "Wait", value: "wait" }],
        allowFreeform: true,
      },
    });
    await callMcpTool(request, agent.id, "post", {
      text: "## Done\n\nAll checks pass.",
    });

    // Opening the agent lands on the Agent tab, which is the Chat.
    await clickAgentRow(page, agent.id);
    await page.waitForURL(new RegExp(`/agents/${agent.id}$`));

    const agentTab = page.getByTestId("center-tab-agent");
    await expect(agentTab).toHaveAttribute("aria-selected", "true");
    await expect(agentTab).toHaveText("Agent");
    await expect(page.getByTestId("center-tab-chat")).toHaveCount(0);

    const pane = page.getByTestId("chat-pane");
    await expect(pane).toBeVisible();

    // Every seeded entry renders.
    const messages = pane.getByTestId("chat-message");
    await expect(messages).toHaveCount(3);
    await expect(messages.nth(0).locator("strong")).toHaveText("green");
    await expect(pane.getByRole("link", { name: "Report" })).toHaveAttribute(
      "href",
      "https://example.com/report"
    );
    await expect(pane.getByTestId("chat-attachment-code")).toContainText(
      "const ok = true;"
    );
    await expect(pane.getByTestId("chat-needs-reply")).toBeVisible();
    await expect(pane.getByTestId("chat-question-option")).toHaveCount(2);
    await expect(messages.nth(2)).toContainText("Done");
    await expect(messages.nth(2)).toContainText("All checks pass.");

    // A post exposes a compact copy action and copies its raw Markdown text.
    await page
      .context()
      .grantPermissions(["clipboard-read", "clipboard-write"]);
    await messages.nth(0).hover();
    const copyMessage = messages.nth(0).getByTestId("chat-copy-message");
    await expect(copyMessage).toBeVisible();
    await copyMessage.click();
    await expect(copyMessage).toHaveAttribute("aria-label", "Message copied");
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe("Tests are **green**. Two files changed.");

    // Inert agents still accept posts for UI/demo inspection; the stream
    // marks them not delivered instead of pretending an engine received them.
    await expect(pane.getByTestId("chat-composer-input")).toBeEnabled();
    await expect(pane.getByTestId("chat-composer-disabled-reason")).toHaveCount(
      0
    );

    // Answers use the same stream-only behavior in inert mode.
    const options = pane.getByTestId("chat-question-option");
    await expect(options.nth(0)).toBeEnabled();
    await expect(options.nth(1)).toBeEnabled();

    await page.screenshot({
      path: test.info().outputPath("chat-surface.png"),
      fullPage: true,
    });

    // Reading the tab marks the agent's messages read.
    await expect
      .poll(async () => {
        const res = await request.get(`/api/v1/streams/${agent.id}/blocks`, {
          headers: authHeaders(),
        });
        return ((await res.json()) as { unreadCount: number }).unreadCount;
      })
      .toBe(0);

    // An old /chat link lands on the Agent tab with Chat showing.
    await page.goto(`/agents/${agent.id}/chat`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForURL(new RegExp(`/agents/${agent.id}$`));
    await expect(page.getByTestId("center-tab-agent")).toHaveAttribute(
      "aria-selected",
      "true"
    );
    await expect(page.getByTestId("chat-pane")).toBeVisible();
  });

  test("renders a user post's attachments and a pending post to a child", async ({
    page,
    request,
  }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-chat-attach-${Date.now()}`,
    });
    // Launched by this agent, so its posts read as a child agent's.
    const peer = await createAgentViaAPI(request, {
      name: `e2e-chat-peer-${Date.now()}`,
      type: "claude",
      parentAgentId: agent.id,
    });
    // A user message with every user-side attachment kind, as the send route
    // stores them once the composer has uploaded the file.
    await seedChatMessageViaDB({
      agentId: agent.id,
      authorKind: "user",
      text: "Have a look at these.",
      attachments: [
        { type: "link", url: "https://example.com/spec", title: "The spec" },
        { type: "pr", url: "https://github.com/o/r/pull/12", title: "PR 12" },
      ],
      delivered: true,
    });
    // An attachment-only message has no text line at all.
    await seedChatMessageViaDB({
      agentId: agent.id,
      authorKind: "user",
      text: "",
      attachments: [{ type: "link", url: "https://example.com/bare" }],
      delivered: true,
    });
    // This agent's post to its child, whose delivery has not settled yet.
    await seedBlockViaDB({
      streamId: agent.id,
      authorKind: "agent",
      toAgentId: peer.id,
      text: "Ping from the chat agent",
      delivered: null,
    });
    // And the child's reply, posted into its parent's stream.
    await seedBlockViaDB({
      streamId: agent.id,
      authorKind: "agent",
      authorAgentId: peer.id,
      toAgentId: agent.id,
      text: "Pong from the child",
      delivered: true,
    });

    await page.goto(`/agents/${agent.id}/chat`, {
      waitUntil: "domcontentloaded",
    });
    const pane = page.getByTestId("chat-pane");
    await expect(pane).toBeVisible();

    const posts = pane.getByTestId("chat-message");
    await expect(posts).toHaveCount(4);
    await expect(posts.nth(0)).toContainText("Have a look at these.");
    await expect(
      posts.nth(0).getByRole("link", { name: "The spec" })
    ).toHaveAttribute("href", "https://example.com/spec");
    await expect(
      posts.nth(0).getByTestId("chat-attachment-pr").getByRole("link")
    ).toHaveAttribute("href", "https://github.com/o/r/pull/12");
    await expect(
      posts.nth(1).getByRole("link", { name: "https://example.com/bare" })
    ).toBeVisible();

    const pending = posts.filter({ hasText: "Ping from the chat agent" });
    await expect(pending.getByTestId("chat-delivery-pending")).toBeVisible();
    await expect(pending.getByTestId("chat-side-recipient")).toContainText(
      peer.name
    );

    // The child's post: its own name, as a peer.
    const fromChild = posts.filter({ hasText: "Pong from the child" });
    await expect(fromChild.getByTestId("chat-post-author")).toHaveText(
      peer.name
    );
    await expect(fromChild).toHaveAttribute("data-author-kind", "peer");

    // The rail lists the links the stream produced, newest first.
    await page.getByTestId("toggle-media-sidebar").click();
    const mediaSidebar = page.getByTestId("media-sidebar");
    await mediaSidebar.getByTestId("sidebar-tab-rail").click();
    const railLinks = mediaSidebar.getByTestId("stream-rail-link");
    await expect(railLinks).toHaveCount(3);
    await expect(railLinks.nth(0).getByRole("link")).toHaveAttribute(
      "href",
      "https://example.com/bare"
    );

    await page.screenshot({
      path: test.info().outputPath("chat-attachments.png"),
      fullPage: true,
    });
  });

  test("sends a message with a link attachment from the composer", async ({
    page,
    request,
  }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-chat-send-${Date.now()}`,
    });
    await expect
      .poll(async () => {
        const res = await request.get(`/api/v1/agents/${agent.id}`, {
          headers: authHeaders(),
        });
        return ((await res.json()) as { agent: { status: string } }).agent
          .status;
      })
      .toBe("running");

    await page.goto(`/agents/${agent.id}`, { waitUntil: "domcontentloaded" });
    const composer = page.getByTestId("chat-composer");
    const input = composer.getByTestId("chat-composer-input");
    await expect(input).toBeEnabled();
    await input.fill("Please read this");

    // The draft survives a trip to the Changes tab and a reload.
    await page.getByTestId("center-tab-changes").click();
    await page.waitForURL(new RegExp(`/agents/${agent.id}/changes$`));
    await page.getByTestId("center-tab-agent").click();
    await expect(input).toHaveValue("Please read this");
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("chat-composer-input")).toHaveValue(
      "Please read this"
    );

    // A lone URL on the clipboard becomes a link chip instead of text.
    await input.evaluate((el) => {
      const data = new DataTransfer();
      data.setData("text/plain", "https://example.com/design");
      el.dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData: data,
          bubbles: true,
          cancelable: true,
        })
      );
    });
    const chip = composer.getByTestId("context-link-item");
    await expect(chip).toHaveAttribute("title", "https://example.com/design");
    await expect(input).toHaveValue("Please read this");

    await composer.getByTestId("chat-composer-send").click();
    await expect(input).toHaveValue("");
    await expect(chip).toHaveCount(0);

    const post = page.getByTestId("chat-message").filter({
      hasText: "Please read this",
    });
    await expect(post).toBeVisible();
    await expect(
      post.getByRole("link", { name: "https://example.com/design" })
    ).toHaveAttribute("href", "https://example.com/design");
    await expect(post.getByTestId("chat-delivery-failed")).toBeVisible();

    // The server stored the attachment on the message.
    await expect
      .poll(async () => {
        const res = await request.get(`/api/v1/streams/${agent.id}/blocks`, {
          headers: authHeaders(),
        });
        const body = (await res.json()) as {
          entries: Array<{
            type: string;
            block?: { attachments: Array<{ type: string; url?: string }> };
          }>;
        };
        return body.entries
          .filter((entry) => entry.type === "block")
          .flatMap((entry) => entry.block?.attachments ?? [])
          .map((attachment) => `${attachment.type}:${attachment.url ?? ""}`);
      })
      .toEqual(["link:https://example.com/design"]);
  });

  test("unread count shows on the Agent tab while another tab is up", async ({
    page,
    request,
  }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-chat-unread-${Date.now()}`,
    });

    await page.goto(`/agents/${agent.id}/changes`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByTestId("center-tab-agent").waitFor({ state: "visible" });

    await callMcpTool(request, agent.id, "post", {
      text: "Something new for you.",
    });

    // The count sits on the Agent tab while Changes is up...
    const agentTab = page.getByTestId("center-tab-agent");
    await expect(agentTab.getByTestId("chat-unread-count")).toHaveText("1");

    await agentTab.click();
    await page.waitForURL(new RegExp(`/agents/${agent.id}$`));
    await expect(page.getByTestId("chat-pane")).toBeVisible();
    // ...and clears once the Agent tab is up.
    await expect(page.getByTestId("chat-unread-count")).toHaveCount(0);
  });

  test("keeps wide markdown tables reachable without page overflow", async ({
    page,
    request,
  }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-chat-table-${Date.now()}`,
    });
    await callMcpTool(request, agent.id, "post", {
      text: [
        "| Alpha heading | Bravo heading | Charlie heading | Delta heading | Echo heading |",
        "| --- | --- | --- | --- | --- |",
        "| alpha-value-long | bravo-value-long | charlie-value-long | delta-value-long | echo-value-long |",
      ].join("\n"),
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/agents/${agent.id}`, { waitUntil: "domcontentloaded" });
    const scroller = page.getByTestId("markdown-table-scroll");
    await scroller.waitFor({ state: "visible" });
    await expect
      .poll(() =>
        scroller.evaluate((node) => ({
          overflowX: getComputedStyle(node).overflowX,
          scrollable: node.scrollWidth > node.clientWidth,
          pageOverflow: document.documentElement.scrollWidth - innerWidth,
        }))
      )
      .toEqual({ overflowX: "auto", scrollable: true, pageOverflow: 0 });

    await scroller.evaluate((node) => {
      node.scrollLeft = 120;
    });
    await expect
      .poll(() => scroller.evaluate((node) => node.scrollLeft))
      .toBeGreaterThan(0);
    await page.screenshot({
      path: test.info().outputPath("chat-surface-wide-table-390.png"),
    });
  });
});
