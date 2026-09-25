import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";

import {
  block,
  blockEntry,
  turnEntry,
} from "../apps/web/src/test-utils/blocks";
import { cleanupE2EAgents, createAgentViaAPI, loadApp } from "./helpers";

test("folded steering receipts wrap and remain operable at 320px and desktop", async ({
  page,
  request,
}) => {
  const agent = await createAgentViaAPI(request);
  try {
    const recipients = [
      "agt_arch",
      "agt_backend",
      "agt_frontend",
      "agt_release",
    ];
    const startedAt = "2026-09-25T20:00:00.000Z";
    const postedAt = "2026-09-25T20:00:01.000Z";
    const entries = [
      turnEntry({
        id: randomUUID(),
        streamId: agent.id,
        createdAt: startedAt,
        text: "Review is underway.",
        turn: {
          trace: { startedAt, endedAt: "2026-09-25T20:00:10.000Z", steps: [] },
        },
      }),
      blockEntry(
        block({
          id: randomUUID(),
          streamId: agent.id,
          createdAt: postedAt,
          toAgentId: recipients[0],
          delivered: true,
          text: "Please review the steering receipt follow-up.\n\nCheck acknowledgement races and per-recipient persistence.",
          delivery: recipients.map((agentId, i) => ({
            agentId,
            state: "delivered",
            receipt: { pickedUpAt: i < 2 ? postedAt : null },
          })),
        })
      ),
    ];
    await page.route(`**/api/v1/streams/${agent.id}/blocks?*`, (route) =>
      route.fulfill({
        json: {
          entries,
          hasMore: false,
          nextCursor: null,
          unreadCount: 0,
          openInputs: [],
          threadLinks: [],
          agentNames: {
            [recipients[0]]: "Architecture reviewer",
            [recipients[1]]: "Backend security reviewer",
            [recipients[2]]: "Frontend accessibility reviewer",
            [recipients[3]]: "ReleaseReadinessReviewerWithALongName",
          },
        },
      })
    );
    await loadApp(page);
    await page.goto(`/agents/${agent.id}`, { waitUntil: "domcontentloaded" });
    const fold = page.getByTestId("chat-turn-sent-to");
    const toggle = fold.getByTestId("chat-turn-sent-to-toggle");
    for (const width of [320, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(fold).toBeVisible();
      await expect(fold.getByTestId("chat-receipt-received")).toHaveCount(0);
      await expect(fold.getByTestId("chat-receipt-waiting")).toContainText(
        "Frontend accessibility reviewer and ReleaseReadinessReviewerWithALongName"
      );
      await fold.hover();
      await fold
        .getByRole("button", { name: "Message delivery details" })
        .click();
      const details = page.getByRole("dialog", {
        name: "Message delivery",
        exact: true,
      });
      await expect(details).toContainText("Received");
      await expect(details).toContainText("Architecture reviewer");
      const detailsBounds = await details.boundingBox();
      expect(detailsBounds!.x).toBeGreaterThanOrEqual(0);
      expect(detailsBounds!.x + detailsBounds!.width).toBeLessThanOrEqual(
        width
      );
      await page.keyboard.press("Escape");
      for (const id of [
        "chat-receipt-status",
        "chat-receipt-waiting",
        "chat-turn-sent-to-toggle",
      ]) {
        const bounds = await fold.getByTestId(id).boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      }
      expect(
        await fold.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)
      ).toBe(true);
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      await expect(fold.getByTestId("chat-turn-sent-to-body")).toContainText(
        "Check acknowledgement races"
      );
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
    }
  } finally {
    await cleanupE2EAgents(request);
  }
});

test("a queued post confirms a combined delivery and pickup update, then stays quiet on reload", async ({
  page,
  request,
}) => {
  const agent = await createAgentViaAPI(request);
  try {
    let post = block({
      id: randomUUID(),
      streamId: agent.id,
      authorKind: "user",
      toAgentId: agent.id,
      text: "Queue transition receipt test",
      delivered: null,
      delivery: [{ agentId: agent.id, state: "held" }],
    });
    await page.route(`**/api/v1/streams/${agent.id}/blocks?*`, (route) =>
      route.fulfill({
        json: {
          entries: [blockEntry(post)],
          hasMore: false,
          nextCursor: null,
          unreadCount: 0,
          openInputs: [],
          threadLinks: [],
          agentNames: {},
        },
      })
    );
    await page.route(
      `**/api/v1/streams/${agent.id}/blocks/${post.id}/send-now`,
      (route) => {
        post = {
          ...post,
          delivered: true,
          delivery: [
            {
              agentId: agent.id,
              state: "delivered",
              receipt: { pickedUpAt: new Date().toISOString() },
            },
          ],
        };
        return route.fulfill({ json: {} });
      }
    );
    await loadApp(page);
    await page.goto(`/agents/${agent.id}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("chat-held-hint")).toBeVisible();
    await page.getByRole("button", { name: "Send now", exact: true }).click();
    await expect(page.getByTestId("chat-receipt-received")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Send now", exact: true })
    ).toHaveCount(0);
    await expect(page.getByTestId("chat-receipt-status")).toHaveCount(0);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByText(post.text, { exact: true })).toBeVisible();
    await expect(page.getByTestId("chat-receipt-status")).toHaveCount(0);
  } finally {
    await cleanupE2EAgents(request);
  }
});

test("delivery details scroll to the final recipient on a short mobile viewport", async ({
  page,
  request,
}) => {
  const agent = await createAgentViaAPI(request);
  try {
    await page.setViewportSize({ width: 667, height: 320 });
    const recipients = Array.from(
      { length: 20 },
      (_, i) => `agt_recipient_${i + 1}`
    );
    const post = block({
      id: randomUUID(),
      streamId: agent.id,
      authorKind: "user",
      toAgentId: recipients[0],
      text: "Message to the review team",
      delivered: true,
      delivery: recipients.map((agentId) => ({
        agentId,
        state: "delivered",
        receipt: {
          deliveredAt: "2026-09-25T20:00:00Z",
          pickedUpAt: "2026-09-25T20:00:01Z",
        },
      })),
    });
    await page.route(`**/api/v1/streams/${agent.id}/blocks?*`, (route) =>
      route.fulfill({
        json: {
          entries: [blockEntry(post)],
          hasMore: false,
          nextCursor: null,
          unreadCount: 0,
          openInputs: [],
          threadLinks: [],
          agentNames: Object.fromEntries(
            recipients.map((id, i) => [id, `Recipient ${i + 1}`])
          ),
        },
      })
    );
    await loadApp(page);
    await page.goto(`/agents/${agent.id}`, { waitUntil: "domcontentloaded" });
    const message = page
      .getByTestId("chat-message")
      .filter({ hasText: post.text });
    await message.hover();
    const trigger = message.getByRole("button", {
      name: "Message delivery details",
    });
    await trigger.focus();
    await page.keyboard.press("Enter");
    const details = page.getByRole("dialog", {
      name: "Message delivery",
      exact: true,
    });
    await expect(details).toBeVisible();
    const bounds = await details.boundingBox();
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(320);
    const last = details.getByText("Recipient 20", { exact: true });
    await last.scrollIntoViewIfNeeded();
    expect(await details.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    const lastBounds = await last.boundingBox();
    expect(lastBounds!.y).toBeGreaterThanOrEqual(bounds!.y);
    expect(lastBounds!.y + lastBounds!.height).toBeLessThanOrEqual(
      bounds!.y + bounds!.height
    );
    await page.keyboard.press("Escape");
    await expect(details).toHaveCount(0);
    await expect(trigger).toBeFocused();
  } finally {
    await cleanupE2EAgents(request);
  }
});
