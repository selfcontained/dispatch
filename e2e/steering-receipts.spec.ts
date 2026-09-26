import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";

import {
  block,
  blockEntry,
  turnEntry,
} from "../apps/web/src/test-utils/blocks";
import { cleanupE2EAgents, createAgentViaAPI, loadApp } from "./helpers";

test("corner receipts and folded messages remain operable at 320px and desktop", async ({
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
      await expect(fold.getByTestId("chat-receipt-sent")).toBeVisible();
      await expect(
        fold.getByRole("button", { name: "Message delivery details" })
      ).toHaveCount(0);
      const slot = fold.getByTestId("chat-delivery-slot");
      const beforeHover = await slot.boundingBox();
      await fold.hover();
      expect(await slot.boundingBox()).toEqual(beforeHover);
      for (const id of [
        "chat-delivery-slot",
        "chat-receipt-sent",
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
      const openSlot = await slot.boundingBox();
      expect(openSlot!.x).toBe(beforeHover!.x);
      expect(openSlot!.width).toBe(beforeHover!.width);
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
    await expect(page.getByTestId("chat-receipt-received")).toHaveCount(0);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByText(post.text, { exact: true })).toBeVisible();
    await expect(page.getByTestId("chat-receipt-received")).toHaveCount(0);
  } finally {
    await cleanupE2EAgents(request);
  }
});

test("receipt margin stays fixed and separate from changing post actions", async ({
  page,
  request,
}) => {
  const agent = await createAgentViaAPI(request);
  try {
    const post = block({
      id: randomUUID(),
      streamId: agent.id,
      authorKind: "user",
      toAgentId: agent.id,
      text: "A message with copy and reply actions",
      delivered: true,
      delivery: [
        {
          agentId: agent.id,
          state: "delivered",
          receipt: { pickedUpAt: null },
        },
      ],
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
    await loadApp(page);
    for (const width of [320, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      post.text = "A message with copy and reply actions";
      await page.goto(`/agents/${agent.id}`, { waitUntil: "domcontentloaded" });
      const row = page.getByTestId("chat-message");
      const slot = row.getByTestId("chat-delivery-slot");
      await expect(row.getByTestId("chat-receipt-sent")).toBeVisible();
      const offset = async () => {
        const [r, s] = await Promise.all([
          row.boundingBox(),
          slot.boundingBox(),
        ]);
        return { right: r!.x + r!.width - s!.x - s!.width, top: s!.y - r!.y };
      };
      const original = await offset();
      for (const withCopy of [true, false]) {
        if (!withCopy) {
          post.text = "";
          await page.reload({ waitUntil: "domcontentloaded" });
          await expect(row.getByTestId("chat-receipt-sent")).toBeVisible();
        }
        await row.hover();
        expect(await offset()).toEqual(original);
        const [s, a] = await Promise.all([
          slot.boundingBox(),
          row.getByTestId("chat-post-action").boundingBox(),
        ]);
        expect(a!.x + a!.width).toBeLessThanOrEqual(s!.x - 4);
        await page.mouse.move(0, 0);
        expect(await offset()).toEqual(original);
        await expect(
          row.getByRole("button", { name: "Message delivery details" })
        ).toHaveCount(0);
      }
    }
  } finally {
    await cleanupE2EAgents(request);
  }
});
