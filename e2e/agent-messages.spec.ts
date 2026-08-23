import path from "node:path";
import { expect, test } from "@playwright/test";

import {
  cleanupE2EAgents,
  clickAgentRow,
  createAgentViaAPI,
  loadApp,
  seedAgentMessageViaDB,
} from "./helpers";

// Agents run inert (no tmux) in E2E, so the real dispatch_send_message path
// cannot run here. Messages are seeded directly into `agent_messages` to
// exercise the sidebar + history UI that reads them.

test.describe("Agent messages", () => {
  test.afterAll(async ({ request }) => {
    await cleanupE2EAgents(request);
  });

  test("shows seeded messages in the sidebar and history detail", async ({
    page,
    request,
  }) => {
    const agentA = await createAgentViaAPI(request, {
      name: `e2e-agent-messages-a-${Date.now()}`,
    });
    const otherAgentId = `e2e-agent-messages-other-${Date.now()}`;

    const receivedContent = `Incoming message ${Date.now()}`;
    const sentContent = `Outgoing message ${Date.now()}`;

    // Unread message received by agent A — should trigger the sidebar's
    // unread badge on the Messages tab.
    await seedAgentMessageViaDB({
      senderAgentId: otherAgentId,
      recipientAgentId: agentA.id,
      senderName: "Other Agent",
      recipientName: agentA.name,
      content: receivedContent,
      delivered: true,
      read: false,
    });

    // A message sent by agent A, already read (no badge contribution).
    await seedAgentMessageViaDB({
      senderAgentId: agentA.id,
      recipientAgentId: otherAgentId,
      senderName: agentA.name,
      recipientName: "Other Agent",
      content: sentContent,
      delivered: true,
      read: true,
    });

    await loadApp(page);

    await clickAgentRow(page, agentA.id);
    const toggle = page.getByTestId("toggle-media-sidebar");
    await expect(toggle).toBeVisible();
    await toggle.click();

    const mediaSidebar = page.getByTestId("media-sidebar");
    await expect(mediaSidebar).toBeVisible();

    const messagesTabButton = mediaSidebar.getByRole("button", {
      name: "Messages",
    });
    const messagesUnreadBadge = messagesTabButton.locator(
      "span.bg-destructive"
    );

    // Unread badge should be visible before opening the tab.
    await expect(messagesUnreadBadge).toBeVisible();
    await expect(messagesUnreadBadge).toHaveText("1");

    await messagesTabButton.click();

    const messageItems = mediaSidebar.getByTestId("message-item");
    await expect(
      messageItems.filter({ hasText: receivedContent })
    ).toBeVisible();
    await expect(messageItems.filter({ hasText: sentContent })).toBeVisible();

    // Opening the tab marks the unread message as read, clearing the badge.
    await expect(messagesUnreadBadge).toBeHidden({ timeout: 10_000 });
    // Confirm it stays cleared (guards against the badge re-appearing due to
    // a stale re-render before the mark-read mutation settles).
    await page.waitForTimeout(500);
    await expect(messagesUnreadBadge).toBeHidden();

    // Visual validation artifact for the sidebar Messages tab (published via
    // dispatch_share_file since no browser MCP is available in this environment).
    await page.screenshot({
      path: path.join(
        process.env.E2E_SCREENSHOT_DIR ?? "/tmp",
        "agent-messages-sidebar.png"
      ),
    });

    await page.goto(`/activity/history/${agentA.id}`, {
      waitUntil: "domcontentloaded",
    });

    const historyMessagesTabButton = page.getByRole("button", {
      name: "Messages",
    });
    await expect(historyMessagesTabButton).toBeVisible();
    await historyMessagesTabButton.click();

    const historyMessages = page.getByTestId("message-item");
    await expect(
      historyMessages.filter({ hasText: receivedContent })
    ).toBeVisible();
    await expect(
      historyMessages.filter({ hasText: sentContent })
    ).toBeVisible();

    // Visual validation artifact for the history detail Messages tab.
    await page.screenshot({
      path: path.join(
        process.env.E2E_SCREENSHOT_DIR ?? "/tmp",
        "agent-messages-history.png"
      ),
    });
  });
});
