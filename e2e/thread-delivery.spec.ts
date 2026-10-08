import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { block, blockEntry } from "../apps/web/src/test-utils/blocks";
import { cleanupE2EAgents, createAgentViaAPI, loadApp } from "./helpers";

for (const width of [390, 1440]) {
  test(`thread delivery survives a late pending send response at ${width}px`, async ({
    page,
    request,
  }) => {
    const agent = await createAgentViaAPI(request);
    try {
      await page.setViewportSize({ width, height: 900 });
      // Control event/response ordering without depending on runtime speed.
      await page.addInitScript(() => {
        const sources: Array<{ onmessage?: (event: MessageEvent) => void }> =
          [];
        class TestEventSource {
          static CLOSED = 2;
          readyState = 1;
          onopen?: () => void;
          onmessage?: (event: MessageEvent) => void;
          constructor() {
            sources.push(this);
            queueMicrotask(() => this.onopen?.());
          }
          close() {
            this.readyState = 2;
          }
        }
        Object.assign(window, {
          EventSource: TestEventSource,
          emitTestStreamEvent: (payload: unknown) => {
            for (const source of sources) {
              source.onmessage?.(
                new MessageEvent("message", { data: JSON.stringify(payload) })
              );
            }
          },
        });
      });
      const root = block({
        id: randomUUID(),
        streamId: agent.id,
        text: "Delivery race discussion",
      });
      await page.route(`**/api/v1/streams/${agent.id}/blocks?*`, (route) =>
        route.fulfill({
          json: {
            entries: [blockEntry(root)],
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
        `**/api/v1/streams/${agent.id}/blocks/${root.id}/thread`,
        (route) => route.fulfill({ json: { root, replies: [] } })
      );
      let releaseResponse: () => void = () => undefined;
      const responseGate = new Promise<void>((resolve) => {
        releaseResponse = resolve;
      });
      let pending: ReturnType<typeof block> | undefined;
      await page.route(
        `**/api/v1/streams/${agent.id}/blocks`,
        async (route) => {
          const input = route.request().postDataJSON();
          pending = block({
            id: input.id,
            streamId: agent.id,
            authorKind: "user",
            text: input.text,
            toAgentId: agent.id,
            threadId: root.id,
            replyTo: root.id,
          });
          await responseGate;
          await route.fulfill({
            json: { block: pending, delivered: null, held: false },
          });
        }
      );
      await loadApp(page);
      await page.goto(`/agents/${agent.id}?thread=${root.id}`, {
        waitUntil: "domcontentloaded",
      });
      const thread = page.locator('[data-testid="chat-thread-panel"]:visible');
      await expect(thread).toContainText(root.text);
      await thread
        .getByTestId("chat-composer-input")
        .fill("Please check delivery");
      await thread.getByTestId("chat-composer-send").click();
      await expect.poll(() => pending?.id).toBeTruthy();
      const emit = async (entry: ReturnType<typeof blockEntry>) => {
        await page.evaluate(
          (payload) => {
            const emitEvent = (
              window as unknown as {
                emitTestStreamEvent: (payload: unknown) => void;
              }
            ).emitTestStreamEvent;
            emitEvent(payload);
          },
          { type: "stream.entry", agentId: agent.id, entry }
        );
      };
      // The optimistic row has no delivery details until the first event.
      await emit(blockEntry(pending!));
      await expect(thread.getByTestId("chat-delivery-pending")).toBeVisible();
      await emit(
        blockEntry({
          ...pending!,
          delivered: true,
          delivery: [
            {
              agentId: agent.id,
              state: "delivered",
              receipt: { pickedUpAt: null },
            },
          ],
        })
      );
      await expect(thread.getByTestId("chat-receipt-sent")).toBeVisible();
      const response = page.waitForResponse(
        (response) =>
          response.url().endsWith(`/streams/${agent.id}/blocks`) &&
          response.request().method() === "POST"
      );
      releaseResponse();
      await (await response).finished();
      // Let the 500ms pending-indicator delay expire if the response regressed it.
      await page.waitForTimeout(600);
      await expect(thread.getByTestId("chat-receipt-sent")).toBeVisible();
      await expect(thread.getByTestId("chat-delivery-pending")).toHaveCount(0);
      await page.screenshot({
        path: `/tmp/dispatch-thread-delivery-${width}.png`,
      });
      await page.getByRole("button", { name: "Close", exact: true }).click();
      await expect(thread).toHaveCount(0);
    } finally {
      await cleanupE2EAgents(request);
    }
  });
}
