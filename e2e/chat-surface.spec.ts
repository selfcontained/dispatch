import { expect, test, type APIRequestContext } from "@playwright/test";

import {
  authHeaders,
  cleanupE2EAgents,
  clickAgentRow,
  createAgentViaAPI,
  loadApp,
} from "./helpers";

const SETTING = "/api/v1/app/settings/chat-surface";

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

  test("flag off: no Chat tab, terminal keeps its label, /chat falls back", async ({
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
  });

  test("flag on: settings toggle, Chat tab, seeded feed, console link", async ({
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

    // Opening the agent lands on the Chat tab by default.
    await page.getByTestId("agents-button").click();
    await clickAgentRow(page, agent.id);
    await page.waitForURL(new RegExp(`/agents/${agent.id}/chat$`));

    const chatTab = page.getByTestId("center-tab-chat");
    await expect(chatTab).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("center-tab-terminal")).toHaveText("Console");

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

    // "Open Console" switches to the terminal tab and remembers the choice.
    await pane.getByTestId("chat-open-console").click();
    await page.waitForURL(new RegExp(`/agents/${agent.id}$`));
    await expect(page.getByTestId("center-tab-terminal")).toHaveAttribute(
      "aria-selected",
      "true"
    );
    await expect(page.getByTestId("terminal-pane")).toBeVisible();

    // The bare route now stays on the Console for this agent instead of
    // redirecting to Chat.
    await page.goto(`/agents/${agent.id}`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("center-tab-chat").waitFor({ state: "visible" });
    await expect(page).toHaveURL(new RegExp(`/agents/${agent.id}$`));
    await expect(page.getByTestId("center-tab-terminal")).toHaveAttribute(
      "aria-selected",
      "true"
    );

    // Back to Chat through the tab bar.
    await chatTab.click();
    await page.waitForURL(new RegExp(`/agents/${agent.id}/chat$`));
    await expect(pane).toBeVisible();
  });

  test("unread count shows on the Chat tab while another tab is active", async ({
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
    await page.getByTestId("center-tab-chat").waitFor({ state: "visible" });

    await callMcpTool(request, agent.id, "dispatch_chat_post", {
      text: "Something new for you.",
    });

    await expect(page.getByTestId("chat-unread-count")).toHaveText("1");

    await page.getByTestId("center-tab-chat").click();
    await page.waitForURL(new RegExp(`/agents/${agent.id}/chat$`));
    await expect(page.getByTestId("chat-unread-count")).toHaveCount(0);
  });
});
