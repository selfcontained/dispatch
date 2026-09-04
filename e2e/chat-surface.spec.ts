import { expect, test, type APIRequestContext } from "@playwright/test";

import {
  authHeaders,
  cleanupE2EAgents,
  clickAgentRow,
  createAgentViaAPI,
  loadApp,
  seedAgentMessageViaDB,
  seedChatMessageViaDB,
  setAgentPinsViaDB,
} from "./helpers";

const SETTING = "/api/v1/app/settings/chat-surface";
const IS_LIVE = process.env.DISPATCH_AGENT_RUNTIME === "tmux";

async function setChatSurface(
  request: APIRequestContext,
  enabled: boolean
): Promise<void> {
  const res = await request.post(SETTING, {
    headers: authHeaders(),
    data: { enabled },
  });
  expect(res.ok()).toBe(true);
}

/** Calls an MCP tool the way an agent would, through its per-agent endpoint. */
async function callMcpTool(
  request: APIRequestContext,
  agentId: string,
  toolName: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const res = await request.fetch(`/api/mcp/${agentId}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    data: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: toolName, arguments: args },
    },
  });
  const text = await res.text();
  const dataLine = text.split("\n").find((l) => l.startsWith("data: "));
  if (!dataLine) throw new Error(`No data line in MCP response: ${text}`);
  const payload = JSON.parse(dataLine.slice("data: ".length)) as {
    result?: { isError?: boolean; content?: Array<{ text?: string }> };
    error?: unknown;
  };
  if (payload.error || payload.result?.isError) {
    throw new Error(`MCP ${toolName} failed: ${text}`);
  }
  return payload as Record<string, unknown>;
}

test.describe("Chat surface", () => {
  test.afterEach(async ({ request }) => {
    await setChatSurface(request, false);
    await cleanupE2EAgents(request);
  });

  test("flag off: no Agent tab or toggle, terminal keeps its label, /chat falls back", async ({
    page,
    request,
  }) => {
    await setChatSurface(request, false);
    const agent = await createAgentViaAPI(request, {
      name: `e2e-chat-off-${Date.now()}`,
    });

    await page.goto(`/agents/${agent.id}/chat`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByTestId("agent-sidebar").waitFor({ state: "visible" });
    await expect(page).toHaveURL(new RegExp(`/agents/${agent.id}$`));

    await expect(page.getByTestId("center-tab-terminal")).toHaveText(
      "Terminal"
    );
    await expect(page.getByTestId("center-tab-chat")).toHaveCount(0);
    await expect(page.getByTestId("center-tab-agent")).toHaveCount(0);
    await expect(page.getByTestId("agent-view-toggle")).toHaveCount(0);
    await expect(page.getByTestId("chat-pane")).toHaveCount(0);
    await expect(page.getByTestId("terminal-pane")).toBeVisible();
  });

  test("flag on: settings toggle, Agent tab, seeded feed, Chat | Console toggle", async ({
    page,
    request,
  }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-chat-on-${Date.now()}`,
    });

    // Enable through the UI, the way a user would.
    await loadApp(page);
    await page.getByTestId("settings-button").click();
    await page
      .getByTestId("sidebar-shell")
      .getByText("Agents", { exact: true })
      .click();
    const toggle = page.getByTestId("chat-surface-toggle");
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute("data-state", "unchecked");
    await toggle.click();
    await expect(toggle).toHaveAttribute("data-state", "checked");
    await expect
      .poll(async () => {
        const res = await request.get(SETTING, { headers: authHeaders() });
        return ((await res.json()) as { enabled: boolean }).enabled;
      })
      .toBe(true);

    // Seed a feed the way an agent would: status events plus chat posts.
    await callMcpTool(request, agent.id, "dispatch_event", {
      type: "working",
      message: "Reading the plan",
    });
    await callMcpTool(request, agent.id, "dispatch_event", {
      type: "working",
      message: "Running tests",
    });
    await callMcpTool(request, agent.id, "dispatch_chat_post", {
      text: "Tests are **green**. Two files changed.",
      kind: "reply",
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
    await callMcpTool(request, agent.id, "dispatch_chat_post", {
      text: "Ship it now or wait for review?",
      kind: "question",
      question: {
        options: [{ label: "Ship it" }, { label: "Wait", value: "wait" }],
        allowFreeform: true,
      },
    });
    await callMcpTool(request, agent.id, "dispatch_chat_post", {
      text: "## Done\n\nAll checks pass.",
      kind: "summary",
    });

    // Opening the agent lands on the Agent tab, showing Chat by default.
    await page.getByTestId("agents-button").click();
    await clickAgentRow(page, agent.id);
    await page.waitForURL(new RegExp(`/agents/${agent.id}$`));

    const agentTab = page.getByTestId("center-tab-agent");
    await expect(agentTab).toHaveAttribute("aria-selected", "true");
    await expect(agentTab).toHaveText("Agent");
    await expect(page.getByTestId("center-tab-terminal")).toHaveCount(0);
    await expect(page.getByTestId("center-tab-chat")).toHaveCount(0);
    const viewToggle = page.getByTestId("agent-view-toggle");
    await expect(viewToggle).toHaveAttribute("data-view", "chat");

    const pane = page.getByTestId("chat-pane");
    await expect(pane).toBeVisible();

    // Every seeded entry renders.
    // The server logs its own "Session started" event first; the two seeded
    // working events collapse into the line after it.
    const workingLine = pane
      .getByTestId("chat-status")
      .filter({ hasText: "Running tests" });
    await expect(workingLine).toBeVisible();
    await expect(workingLine).not.toContainText("Reading the plan");
    await expect(pane.getByTestId("chat-status-collapsed-count")).toHaveText(
      "×2"
    );

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
    await expect(messages.nth(2)).toContainText("Summary");
    await expect(messages.nth(2)).toContainText("All checks pass.");

    // The presence line reflects the latest event.
    await expect(pane.getByTestId("chat-presence")).toContainText(
      "Running tests"
    );

    if (!IS_LIVE) {
      // Agents run inert in E2E, so the composer explains it cannot deliver.
      await expect(pane.getByTestId("chat-composer-input")).toBeDisabled();
      await expect(
        pane.getByTestId("chat-composer-disabled-reason")
      ).toBeVisible();

      // Answers are injected like typed messages, so they lock with the
      // composer: the server would 409 on an inert agent.
      const options = pane.getByTestId("chat-question-option");
      await expect(options.nth(0)).toBeDisabled();
      await expect(options.nth(1)).toBeDisabled();
    }

    await page.screenshot({
      path: test.info().outputPath("chat-surface.png"),
      fullPage: true,
    });

    // Reading the tab marks the agent's messages read.
    await expect
      .poll(async () => {
        const res = await request.get(`/api/v1/agents/${agent.id}/chat`, {
          headers: authHeaders(),
        });
        return ((await res.json()) as { unreadCount: number }).unreadCount;
      })
      .toBe(0);

    // The toggle flips to the Console in place: same URL, same tab, the
    // terminal shows and the chat hides.
    await viewToggle.getByTestId("agent-view-console").click();
    await expect(viewToggle).toHaveAttribute("data-view", "console");
    await expect(page).toHaveURL(new RegExp(`/agents/${agent.id}$`));
    await expect(agentTab).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("terminal-pane")).toBeVisible();
    await expect(pane).toBeHidden();

    // The choice is remembered per agent across a reload.
    await page.goto(`/agents/${agent.id}`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("agent-view-toggle").waitFor({ state: "visible" });
    await expect(page.getByTestId("agent-view-toggle")).toHaveAttribute(
      "data-view",
      "console"
    );
    await expect(page.getByTestId("terminal-pane")).toBeVisible();
    await expect(page.getByTestId("chat-pane")).toBeHidden();

    // An old /chat link lands on the Agent tab with Chat showing.
    await page.goto(`/agents/${agent.id}/chat`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForURL(new RegExp(`/agents/${agent.id}$`));
    await expect(page.getByTestId("agent-view-toggle")).toHaveAttribute(
      "data-view",
      "chat"
    );
    await expect(page.getByTestId("chat-pane")).toBeVisible();

    // And back to the Console through the toggle, then Chat again.
    await page.getByTestId("agent-view-console").click();
    await expect(page.getByTestId("terminal-pane")).toBeVisible();
    await page.getByTestId("agent-view-chat").click();
    await expect(page.getByTestId("chat-pane")).toBeVisible();
  });

  test("renders a user post's attachments and a pending agent message", async ({
    page,
    request,
  }) => {
    await setChatSurface(request, true);
    const agent = await createAgentViaAPI(request, {
      name: `e2e-chat-attach-${Date.now()}`,
    });
    // Launched by this agent, so its posts read as a child agent's.
    const peer = await createAgentViaAPI(request, {
      name: `e2e-chat-peer-${Date.now()}`,
      type: "claude",
      parentAgentId: agent.id,
    });
    await setAgentPinsViaDB(agent.id, [
      {
        id: "pin-dev",
        label: "Dev URL",
        value: "http://localhost:5173",
        type: "url",
      },
    ]);
    // A user message with every user-side attachment kind, as the send route
    // stores them once the composer has uploaded the file.
    await seedChatMessageViaDB({
      agentId: agent.id,
      authorKind: "user",
      text: "Have a look at these.",
      attachments: [
        { type: "link", url: "https://example.com/spec", title: "The spec" },
        { type: "pin", pinId: "pin-dev" },
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
    // A cross-agent message whose pane delivery has not settled yet.
    await seedAgentMessageViaDB({
      senderAgentId: agent.id,
      recipientAgentId: peer.id,
      senderName: agent.name,
      recipientName: peer.name,
      content: "Ping from the chat agent",
      delivered: null,
    });
    // And the child's reply.
    await seedAgentMessageViaDB({
      senderAgentId: peer.id,
      recipientAgentId: agent.id,
      senderName: peer.name,
      recipientName: agent.name,
      content: "Pong from the child",
      delivered: true,
    });

    await page.goto(`/agents/${agent.id}/chat`, {
      waitUntil: "domcontentloaded",
    });
    const pane = page.getByTestId("chat-pane");
    await expect(pane).toBeVisible();

    const posts = pane.getByTestId("chat-message");
    await expect(posts).toHaveCount(2);
    await expect(posts.nth(0)).toContainText("Have a look at these.");
    await expect(
      posts.nth(0).getByRole("link", { name: "The spec" })
    ).toHaveAttribute("href", "https://example.com/spec");
    await expect(posts.nth(0).getByTestId("chat-attachment-pin")).toContainText(
      "Dev URL"
    );
    await expect(
      posts.nth(1).getByRole("link", { name: "https://example.com/bare" })
    ).toBeVisible();

    const pending = pane
      .getByTestId("chat-agent-message")
      .filter({ hasText: "Ping from the chat agent" });
    await expect(pending.getByTestId("chat-agent-message-pending")).toHaveText(
      "Sending"
    );
    await expect(pending.getByTestId("agent-relation-badge")).toHaveCount(0);

    // The child's post: its own icon, its name, and its relation to this agent.
    const fromChild = pane
      .getByTestId("chat-agent-message")
      .filter({ hasText: "Pong from the child" });
    await expect(fromChild.getByTestId("chat-post-author")).toHaveText(
      peer.name
    );
    await expect(fromChild.getByTestId("agent-relation-badge")).toHaveText(
      "child agent"
    );
    await expect(fromChild.getByLabel("Claude agent")).toBeVisible();
    await expect(fromChild).toHaveAttribute("data-author-kind", "peer");

    // The messages panel renders the same pending state.
    await page.getByTestId("toggle-media-sidebar").click();
    const mediaSidebar = page.getByTestId("media-sidebar");
    await mediaSidebar.getByRole("button", { name: "Messages" }).click();
    await expect(mediaSidebar.getByTestId("message-sending")).toContainText(
      "sending"
    );
    await expect(mediaSidebar.getByTestId("agent-relation-badge")).toHaveText(
      "child agent"
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
    test.skip(
      !IS_LIVE,
      "Sending needs a live pane — run via E2E_AGENT_RUNTIME=tmux"
    );
    await setChatSurface(request, true);
    const agent = await createAgentViaAPI(request, {
      name: `e2e-chat-send-${Date.now()}`,
      type: "terminal",
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

    // The draft survives a Chat → Console → Chat flip and a reload.
    await page.getByTestId("agent-view-console").click();
    await expect(page.getByTestId("terminal-pane")).toBeVisible();
    await page.getByTestId("agent-view-chat").click();
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

    // The server stored the attachment on the message.
    await expect
      .poll(async () => {
        const res = await request.get(`/api/v1/agents/${agent.id}/chat`, {
          headers: authHeaders(),
        });
        const body = (await res.json()) as {
          entries: Array<{
            type: string;
            message?: { attachments: Array<{ type: string; url?: string }> };
          }>;
        };
        return body.entries
          .filter((entry) => entry.type === "chat")
          .flatMap((entry) => entry.message?.attachments ?? [])
          .map((attachment) => `${attachment.type}:${attachment.url ?? ""}`);
      })
      .toEqual(["link:https://example.com/design"]);
  });

  test("unread count shows on the Agent tab, then on the Chat segment under Console", async ({
    page,
    request,
  }) => {
    await setChatSurface(request, true);
    const agent = await createAgentViaAPI(request, {
      name: `e2e-chat-unread-${Date.now()}`,
    });

    await page.goto(`/agents/${agent.id}/changes`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByTestId("center-tab-agent").waitFor({ state: "visible" });

    await callMcpTool(request, agent.id, "dispatch_chat_post", {
      text: "Something new for you.",
    });

    // The count sits on the Agent tab while Changes is up...
    const agentTab = page.getByTestId("center-tab-agent");
    await expect(agentTab.getByTestId("chat-unread-count")).toHaveText("1");

    await agentTab.click();
    await page.waitForURL(new RegExp(`/agents/${agent.id}$`));
    await expect(page.getByTestId("chat-pane")).toBeVisible();
    await expect(page.getByTestId("chat-unread-count")).toHaveCount(0);
    await expect(page.getByTestId("agent-view-chat-unread")).toHaveCount(0);

    // ...and on the Chat segment of the toggle while the Console is up.
    await page.getByTestId("agent-view-console").click();
    await expect(page.getByTestId("terminal-pane")).toBeVisible();
    await callMcpTool(request, agent.id, "dispatch_chat_post", {
      text: "And another.",
    });
    await expect(page.getByTestId("agent-view-chat-unread")).toHaveText("1");
    await expect(page.getByTestId("chat-unread-count")).toHaveCount(0);

    await page.getByTestId("agent-view-chat").click();
    await expect(page.getByTestId("chat-pane")).toBeVisible();
    await expect(page.getByTestId("agent-view-chat-unread")).toHaveCount(0);
  });

  test("keeps the split Agent header's toggle clear of the unsplit button at 820px", async ({
    page,
    request,
  }) => {
    await setChatSurface(request, true);
    const agent = await createAgentViaAPI(request, {
      name: `e2e-chat-split-820-${Date.now()}`,
    });

    await page.setViewportSize({ width: 820, height: 1180 });
    await page.goto(`/agents/${agent.id}`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("agent-view-toggle").waitFor({ state: "visible" });
    await page.evaluate((id) => {
      window.localStorage.setItem(
        `dispatch:splitPaneV2:${id}`,
        JSON.stringify({
          mode: "split",
          left: "agent",
          right: "changes",
          sizes: [50, 50],
        })
      );
    }, agent.id);
    await page.reload({ waitUntil: "domcontentloaded" });

    const unsplit = page.getByTestId("unsplit-button");
    await expect(unsplit).toBeVisible({ timeout: 10_000 });
    const toggle = page.getByTestId("agent-view-toggle");
    await expect(toggle).toBeVisible();
    const consoleSegment = page.getByTestId("agent-view-console");
    await expect(consoleSegment).toBeVisible();

    // The toggle sits wholly left of the button: no overlap, nothing cut off.
    const button = (await unsplit.boundingBox())!;
    const toggleBox = (await toggle.boundingBox())!;
    const segmentBox = (await consoleSegment.boundingBox())!;
    expect(toggleBox.x + toggleBox.width).toBeLessThanOrEqual(button.x);
    expect(segmentBox.x + segmentBox.width).toBeLessThanOrEqual(button.x);
    expect(await consoleSegment.evaluate((el) => el.scrollWidth)).toBe(
      Math.round(segmentBox.width)
    );
    await page.screenshot({
      path: test.info().outputPath("chat-surface-split-820.png"),
    });

    // Both segments still take a click.
    await consoleSegment.click();
    await expect(toggle).toHaveAttribute("data-view", "console");
    await expect(page.getByTestId("terminal-pane")).toBeVisible();
    await page.getByTestId("agent-view-chat").click();
    await expect(toggle).toHaveAttribute("data-view", "chat");
    await expect(page.getByTestId("chat-pane")).toBeVisible();
  });

  test("gives the Chat | Console toggle touch-sized segments on a phone", async ({
    browser,
    request,
  }) => {
    await setChatSurface(request, true);
    const agent = await createAgentViaAPI(request, {
      name: `e2e-chat-touch-with-a-realistically-long-agent-task-name-${Date.now()}`,
    });

    const protocol = process.env.TLS_CERT ? "https" : "http";
    const baseURL = `${protocol}://127.0.0.1:${process.env.E2E_PORT ?? "8788"}`;
    const context = await browser.newContext({
      baseURL,
      hasTouch: true,
      ignoreHTTPSErrors: true,
      viewport: { width: 390, height: 844 },
    });
    const touchPage = await context.newPage();
    try {
      await touchPage.goto(`/agents/${agent.id}`, {
        waitUntil: "domcontentloaded",
      });
      const toggle = touchPage.getByTestId("agent-view-toggle");
      await toggle.waitFor({ state: "visible" });
      expect(
        await touchPage.evaluate(() => matchMedia("(pointer: coarse)").matches)
      ).toBe(true);

      for (const id of [
        "agent-view-chat",
        "agent-view-console",
        "chat-filters-trigger",
      ]) {
        await expect
          .poll(() =>
            touchPage
              .getByTestId(id)
              .evaluate((node) => node.getBoundingClientRect().height)
          )
          .toBeGreaterThanOrEqual(44);
      }
      const track = touchPage.getByTestId("agent-view-track");
      const filterSurface = touchPage.getByTestId("chat-filters-surface");
      const filterIcon = touchPage.getByTestId("chat-filters-icon");
      await expect
        .poll(async () => {
          const trackBox = (await track.boundingBox())!;
          const surfaceBox = (await filterSurface.boundingBox())!;
          const iconBox = (await filterIcon.boundingBox())!;
          return {
            trackHeight: Math.round(trackBox.height),
            surfaceWidth: Math.round(surfaceBox.width),
            surfaceHeight: Math.round(surfaceBox.height),
            centerDelta: Math.round(
              surfaceBox.y +
                surfaceBox.height / 2 -
                (trackBox.y + trackBox.height / 2)
            ),
            iconWidth: Math.round(iconBox.width),
            iconHeight: Math.round(iconBox.height),
          };
        })
        .toEqual({
          trackHeight: 24,
          surfaceWidth: 24,
          surfaceHeight: 24,
          centerDelta: 0,
          iconWidth: 14,
          iconHeight: 14,
        });
      // The header grew to hold it rather than clipping it.
      const controls = toggle.locator("xpath=..");
      const header = controls.locator("xpath=..");
      const headerBox = (await header.boundingBox())!;
      const toggleBox = (await toggle.boundingBox())!;
      expect(toggleBox.y).toBeGreaterThanOrEqual(headerBox.y);
      expect(toggleBox.y + toggleBox.height).toBeLessThanOrEqual(
        headerBox.y + headerBox.height
      );
      await expect(touchPage.getByTestId("chat-pane")).toBeVisible();

      const indicator = touchPage.getByTestId("agent-view-indicator");
      const indicatorInsets = async () => {
        const trackBox = (await track.boundingBox())!;
        const indicatorBox = (await indicator.boundingBox())!;
        const segmentStart =
          (await toggle.getAttribute("data-view")) === "console"
            ? trackBox.x + trackBox.width / 2
            : trackBox.x;
        const segmentEnd = segmentStart + trackBox.width / 2;
        return {
          left: Math.round(indicatorBox.x - segmentStart),
          right: Math.round(segmentEnd - (indicatorBox.x + indicatorBox.width)),
          top: Math.round(indicatorBox.y - trackBox.y),
          bottom: Math.round(
            trackBox.y +
              trackBox.height -
              (indicatorBox.y + indicatorBox.height)
          ),
        };
      };
      await expect.poll(indicatorInsets).toEqual({
        left: 2,
        right: 2,
        top: 2,
        bottom: 2,
      });
      await touchPage.screenshot({
        path: test.info().outputPath("chat-surface-touch-390.png"),
      });

      await touchPage.getByTestId("agent-view-console").tap();
      await expect(toggle).toHaveAttribute("data-view", "console");
      await expect(touchPage.getByTestId("terminal-pane")).toBeVisible();
      await expect.poll(indicatorInsets).toEqual({
        left: 2,
        right: 2,
        top: 2,
        bottom: 2,
      });

      await touchPage.getByTestId("agent-view-chat").tap();
      await expect(toggle).toHaveAttribute("data-view", "chat");
      await expect(touchPage.getByTestId("chat-pane")).toBeVisible();
      await expect.poll(indicatorInsets).toEqual({
        left: 2,
        right: 2,
        top: 2,
        bottom: 2,
      });

      await touchPage.setViewportSize({ width: 320, height: 844 });
      await expect
        .poll(async () => {
          const toggleBox = (await toggle.boundingBox())!;
          const triggerBox = (await touchPage
            .getByTestId("chat-filters-trigger")
            .boundingBox())!;
          return {
            railWidth: Math.round(
              (await touchPage.getByTestId("agent-view-track").boundingBox())!
                .width
            ),
            controlsOverlap: Math.max(
              0,
              Math.round(toggleBox.x + toggleBox.width - triggerBox.x)
            ),
            pageOverflow: await touchPage.evaluate(
              () => document.documentElement.scrollWidth - innerWidth
            ),
          };
        })
        .toEqual({ railWidth: 152, controlsOverlap: 0, pageOverflow: 0 });
      await touchPage.screenshot({
        path: test.info().outputPath("chat-surface-touch-long-name-320.png"),
      });
    } finally {
      await context.close();
    }
  });

  test("keeps wide markdown tables reachable without page overflow", async ({
    page,
    request,
  }) => {
    await setChatSurface(request, true);
    const agent = await createAgentViaAPI(request, {
      name: `e2e-chat-table-${Date.now()}`,
    });
    await callMcpTool(request, agent.id, "dispatch_chat_post", {
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
