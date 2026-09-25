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

  test("composer shortcut focuses only a visible composer", async ({
    page,
    request,
  }) => {
    const agent = await createAgentViaAPI(request);
    await callMcpTool(request, agent.id, "post", {
      text: "A message to reply to",
    });
    await loadApp(page);
    await clickAgentRow(page, agent.id);
    const mod = await page.evaluate(() =>
      /Mac|iPod|iPhone|iPad/.test(navigator.platform) ? "Meta" : "Control"
    );
    const shortcut = `${mod}+Shift+Space`;
    const composer = page
      .getByTestId("chat-pane")
      .getByTestId("chat-composer-input");
    await composer.fill("Keep this draft");
    await page.getByTestId("center-tab-agent").click();
    await page.keyboard.press(shortcut);
    await expect(composer).toBeFocused();
    await expect(composer).toHaveValue("Keep this draft");

    await page
      .getByTestId("chat-message")
      .filter({ hasText: "A message to reply to" })
      .getByTestId("chat-reply-in-thread")
      .click();
    const thread = page.getByTestId("chat-thread-panel");
    const reply = thread.getByTestId("chat-composer-input");
    await page.getByRole("button", { name: "Close", exact: true }).focus();
    await page.keyboard.press(shortcut);
    await expect(reply).toBeFocused();
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await expect(thread).toHaveCount(0);
    await page.keyboard.press(shortcut);
    await expect(composer).toBeFocused();

    const changes = page.getByTestId("center-tab-changes");
    await changes.click();
    await expect(composer).not.toBeVisible();
    await page.keyboard.press(shortcut);
    await expect(composer).not.toBeFocused();
    await expect(changes).toHaveAttribute("aria-selected", "true");

    await page.getByTestId("center-tab-agent").click();
    await expect(composer).toBeVisible();
    await page.keyboard.press(`${mod}+k`);
    const palette = page.getByRole("dialog", { name: "Command palette" });
    await expect(palette.getByRole("combobox")).toBeFocused();
    await page.keyboard.press(shortcut);
    await expect(palette.getByRole("combobox")).toBeFocused();
    await expect(composer).not.toBeFocused();
  });

  test("composer keeps full-width text above its toolbar at desktop and mobile widths", async ({
    page,
    request,
  }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-composer-layout-${Date.now()}`,
    });
    await page.route("**/api/v1/agents/" + agent.id + "/commands", (route) =>
      route.fulfill({
        json: { commands: [{ name: "review", description: "Review changes" }] },
      })
    );
    await loadApp(page);
    await clickAgentRow(page, agent.id);
    const input = page.getByTestId("chat-composer-input");
    const controls = page.getByTestId("chat-composer-controls");

    for (const width of [1100, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await input.fill("Short draft");
      await expect
        .poll(async () => (await input.boundingBox())!.height)
        .toBeLessThan(60);
      const field = (await input.boundingBox())!;
      const buttons = (await controls.boundingBox())!;
      // The toolbar has a consistent home below the full-width field.
      expect(buttons.y).toBeGreaterThanOrEqual(field.y + field.height);
      expect(buttons.width).toBe(field.width);
      await expect(page.getByTestId("chat-composer-send")).toHaveText("");

      await input.fill(
        "A longer draft fills the space above the icons. ".repeat(6) +
          "\nLast line."
      );
      await expect
        .poll(async () => (await input.boundingBox())!.height)
        .toBeGreaterThan(60);
      await page.screenshot({
        path: test.info().outputPath(`composer-${width}.png`),
      });

      await input.fill("A line in a long draft.\n".repeat(30));
      await expect
        .poll(
          async () =>
            (await controls.boundingBox())!.y -
            ((await input.boundingBox())!.y +
              (await input.boundingBox())!.height)
        )
        .toBeGreaterThanOrEqual(0);
      await input.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      await expect(input).toBeFocused();
      await input.fill("");
      await expect(page.getByTestId("chat-composer-send")).toBeDisabled();
      await expect(
        page.getByTestId("chat-composer-mention-button")
      ).toBeVisible();
      await expect(
        page.getByTestId("chat-composer-command-button")
      ).toBeVisible();
      await input.fill("Please ");
      await page.getByTestId("chat-composer-mention-button").click();
      await expect(page.getByTestId("mention-picker")).toBeVisible();
      await page.getByTestId("mention-option").first().click();
      await expect(input).toHaveValue("Please @" + agent.name + " ");

      await input.fill("check this draft");
      await page.getByTestId("chat-composer-command-button").click();
      await expect(page.getByTestId("slash-picker")).toBeVisible();
      await expect
        .poll(() => input.evaluate((el) => el.selectionStart))
        .toBe(1);
      await input.pressSequentially("rev");
      await expect(page.getByTestId("slash-option")).toHaveCount(1);
      await input.press("Enter");
      await expect(input).toHaveValue("/review check this draft");
      await expect(page.getByTestId("slash-picker")).toBeHidden();
      await page.getByTestId("chat-composer-command-button").click();
      await expect(page.getByTestId("slash-picker")).toBeVisible();
      await input.press("Escape");
      await expect(page.getByTestId("slash-picker")).toBeHidden();
      await page.screenshot({
        path: test.info().outputPath("composer-pickers-" + width + ".png"),
      });
    }
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

    // The Inbox lists the links the stream produced, newest first.
    await page.getByTestId("toggle-drawer").click();
    const drawer = page.getByTestId("drawer");
    await drawer.getByTestId("sidebar-tab-inbox").click();
    const inboxLinks = drawer.getByTestId("inbox-link");
    await expect(inboxLinks).toHaveCount(3);
    await expect(inboxLinks.nth(0).getByRole("link")).toHaveAttribute(
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

    // The person's own post; the agent's answer (a block too, now) quotes
    // the same words on the live runtime.
    const post = page
      .locator('[data-testid="chat-message"][data-author="user"]')
      .filter({ hasText: "Please read this" });
    await expect(post).toBeVisible();
    await expect(
      post.getByRole("link", { name: "https://example.com/design" })
    ).toHaveAttribute("href", "https://example.com/design");
    // Inert runtime: nothing to deliver to, so the post shows as failed.
    // Live runtime: the fake engine takes it and answers.
    if (process.env.DISPATCH_AGENT_RUNTIME === "acp") {
      await expect(post.getByTestId("chat-delivery-failed")).toHaveCount(0);
    } else {
      await expect(post.getByTestId("chat-delivery-failed")).toBeVisible();
    }

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
            // On the live runtime the post opened a turn, which draws it
            // and carries its attachments.
            prompt?: { attachments: Array<{ type: string; url?: string }> };
          }>;
        };
        return body.entries
          .flatMap(
            (entry) =>
              entry.block?.attachments ?? entry.prompt?.attachments ?? []
          )
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
