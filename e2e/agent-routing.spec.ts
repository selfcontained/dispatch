import { expect, test } from "@playwright/test";
import { turnEntry } from "../apps/web/src/test-utils/blocks";
import {
  authHeaders,
  callMcpToolViaAPI,
  cleanupE2EAgents,
  createAgentViaAPI,
} from "./helpers";

async function waitForAppShell(
  page: import("@playwright/test").Page,
  agentName?: string
): Promise<void> {
  await page.getByTestId("agent-sidebar").waitFor({ state: "visible" });
  await page.getByTestId("chat-pane").waitFor({ state: "visible" });
  if (agentName) {
    await page
      .getByTestId("agent-sidebar")
      .getByText(agentName)
      .first()
      .waitFor({ state: "visible" });
  }
}

test.describe("Agent routing", () => {
  test.afterEach(async ({ request }) => {
    await cleanupE2EAgents(request);
  });

  for (const type of ["agent.upsert", "agent.deleted"]) {
    test(`a cold deep link survives ${type} before the initial agent list`, async ({
      page,
      request,
    }) => {
      const selected = await createAgentViaAPI(request);
      const unrelated = await createAgentViaAPI(request);
      await page.addInitScript(() => {
        const sources: EventSource[] = [];
        class ControlledEventSource extends EventTarget {
          onmessage: ((event: MessageEvent) => void) | null = null;
          onerror = null;
          readyState = 1;
          constructor() {
            super();
            sources.push(this as unknown as EventSource);
          }
          close() {}
        }
        Object.assign(window, {
          EventSource: ControlledEventSource,
          emitAgentEvent: (payload: unknown) => {
            for (const source of sources) {
              source.onmessage?.(
                new MessageEvent("message", { data: JSON.stringify(payload) })
              );
            }
            return sources.length;
          },
        });
      });
      let releaseList!: () => void;
      const listGate = new Promise<void>((resolve) => {
        releaseList = resolve;
      });
      let listRequested = false;
      await page.route("**/api/v1/agents", async (route) => {
        listRequested = true;
        await listGate;
        await route.continue();
      });
      try {
        await page.goto(`/agents/${selected.id}`, {
          waitUntil: "domcontentloaded",
        });
        await expect.poll(() => listRequested).toBe(true);
        const payload =
          type === "agent.upsert"
            ? { type, agent: unrelated }
            : { type, agentId: unrelated.id };
        await expect
          .poll(() =>
            page.evaluate((event) => {
              const emit = (
                window as unknown as {
                  emitAgentEvent: (event: unknown) => number;
                }
              ).emitAgentEvent;
              return emit(event);
            }, payload)
          )
          .toBeGreaterThan(0);
        // Flush React's render/effect work before checking the route. The
        // old implementation redirects here, while REST is still blocked.
        await page.evaluate(
          () =>
            new Promise<void>((resolve) => {
              requestAnimationFrame(() =>
                requestAnimationFrame(() => resolve())
              );
            })
        );
        await expect(page).toHaveURL(new RegExp(`/agents/${selected.id}$`));
        releaseList();
        await expect(page.getByTestId("chat-pane")).toContainText(
          selected.name
        );
        await expect(page).toHaveURL(new RegExp(`/agents/${selected.id}$`));
        await page.screenshot({ path: `/tmp/dispatch-cold-route-${type}.png` });
      } finally {
        releaseList();
      }
    });
  }

  for (const ownChild of [false, true]) {
    test(`sidebar activity ${ownChild ? "preserves a child's own page" : "opens a foreign stream"}`, async ({
      page,
      request,
    }) => {
      const owner = await createAgentViaAPI(request, {
        name: `e2e-activity-owner-${Date.now()}`,
      });
      const worker = await createAgentViaAPI(request, {
        name: `e2e-activity-worker-${Date.now()}`,
        ...(ownChild ? { parentAgentId: owner.id } : {}),
      });
      const child = ownChild
        ? worker
        : await createAgentViaAPI(request, {
            name: "Foreign thread helper",
            parentAgentId: owner.id,
          });
      // Agent creation returns before its launch card is written. Wait for
      // that card before using it as the activity thread's host.
      let threadId = "";
      await expect
        .poll(async () => {
          const feed = await request.get(`/api/v1/streams/${owner.id}/blocks`, {
            headers: authHeaders(),
          });
          expect(feed.ok()).toBe(true);
          const { entries } = await feed.json();
          threadId =
            entries.find(
              (entry: { block: { kind: string; toAgentId: string } }) =>
                entry.block.kind === "launch" &&
                entry.block.toAgentId === child.id
            )?.id ?? "";
          return threadId;
        })
        .not.toBe("");
      const post = await callMcpToolViaAPI(request, owner.id, "post", {
        replyTo: threadId,
        text: "Activity belongs in this stream.",
      });
      const blockId = JSON.parse(
        (post.result as { content: Array<{ text: string }> }).content[0]!.text
      ).id as string;
      // Inert E2E agents have no live turns. Supply just the runtime snapshot
      // and label; the foreign launch thread and its lookup are real server data.
      const agentsResponse = await request.get("/api/v1/agents", {
        headers: authHeaders(),
      });
      const data = await agentsResponse.json();
      data.agents = data.agents.map((agent: { id: string }) =>
        agent.id === worker.id
          ? {
              ...agent,
              activity: "working",
              currentTurn: { streamId: owner.id, blockId, threadId },
            }
          : agent
      );
      await page.route("**/api/v1/agents", (route) =>
        route.fulfill({ json: data })
      );
      await page.route("**/api/v1/events", (route) =>
        route.fulfill({
          contentType: "text/event-stream",
          body: `data: ${JSON.stringify({ type: "snapshot", agents: data.agents })}\n\n`,
        })
      );
      await page.route(`**/api/v1/agents/${worker.id}/turn`, (route) =>
        route.fulfill({
          json: {
            entry: turnEntry({
              id: blockId,
              streamId: owner.id,
              threadId,
              author: { kind: "agent", agentId: worker.id },
              turn: {
                settled: false,
                trace: { startedAt: new Date().toISOString(), steps: [] },
              },
            }),
          },
        })
      );
      // Prove the old request fails for this fixture, just as on the affected host.
      const wrongStream = await request.get(
        `/api/v1/streams/${worker.id}/blocks/${threadId}/thread`,
        { headers: authHeaders() }
      );
      expect(wrongStream.status()).toBe(404);
      for (const mobile of [false, true]) {
        await page.setViewportSize(
          mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }
        );
        await page.goto(`/agents/${worker.id}`, {
          waitUntil: "domcontentloaded",
        });
        if (mobile) await page.getByTitle("Open sidebar").click();
        const activity = page.getByTestId(`agent-activity-${worker.id}`);
        await expect(activity).toBeVisible();
        const loadedThread = page.waitForResponse(
          (response) =>
            response
              .url()
              .includes(
                `/api/v1/streams/${owner.id}/blocks/${threadId}/thread`
              ) && response.status() === 200
        );
        await activity.click();
        await loadedThread;
        await expect(page).toHaveURL(
          new RegExp(
            `/agents/${ownChild ? worker.id : owner.id}\\?thread=${threadId}&block=${blockId}$`
          )
        );
        const thread = page.locator(
          '[data-testid="chat-thread-panel"]:visible'
        );
        await expect(thread).toContainText("Activity belongs in this stream.");
        await expect(thread.getByText("Couldn't load the thread")).toHaveCount(
          0
        );
        await expect
          .poll(async () => {
            const bounds = await thread.boundingBox();
            return (
              bounds !== null &&
              bounds.x >= 0 &&
              bounds.x + bounds.width <= page.viewportSize()!.width + 1
            );
          })
          .toBe(true);
        await page.screenshot({
          path: `/tmp/dispatch-activity-${ownChild ? "child" : "stream"}-${mobile ? "mobile" : "desktop"}.png`,
          fullPage: true,
        });
        await page.reload({ waitUntil: "domcontentloaded" });
        await expect(thread).toContainText("Activity belongs in this stream.");
        await page.locator('[data-testid="drawer-close"]:visible').click();
        await expect(page).not.toHaveURL(/thread=/);
      }
    });
  }

  test("deep-linking to an agent route auto-attaches that agent", async ({
    page,
    request,
  }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-agent-${Date.now()}`,
    });

    await page.goto(`/agents/${agent.id}`, { waitUntil: "domcontentloaded" });
    await waitForAppShell(page, agent.name);

    await expect(page).toHaveURL(new RegExp(`/agents/${agent.id}$`));
    await expect(page.getByTestId("current-session-name")).toContainText(
      agent.name
    );
    await expect(page.getByTestId("chat-composer-input")).toBeVisible();
  });

  test("browser back returns to the same agent session after visiting settings", async ({
    page,
    request,
  }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-agent-${Date.now()}`,
    });

    await page.goto(`/agents/${agent.id}`, { waitUntil: "domcontentloaded" });
    await waitForAppShell(page, agent.name);
    await expect(page.getByTestId("chat-composer-input")).toBeVisible();

    await page.getByTestId("settings-button").click();
    await expect(page).toHaveURL(/\/settings$/);

    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/agents/${agent.id}$`));
    await expect(page.getByTestId("current-session-name")).toContainText(
      agent.name
    );
    await expect(page.getByTestId("chat-composer-input")).toBeVisible();
  });

  test("legacy feedback and review routes normalize back to the agent route", async ({
    page,
    request,
  }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-agent-${Date.now()}`,
    });

    await page.goto(`/agents/${agent.id}/feedback/not-a-number`, {
      waitUntil: "domcontentloaded",
    });
    await waitForAppShell(page, agent.name);
    await expect(page).toHaveURL(new RegExp(`/agents/${agent.id}$`));

    await page.goto(`/agents/${agent.id}/feedback/99999`, {
      waitUntil: "domcontentloaded",
    });
    await waitForAppShell(page, agent.name);
    await expect(page).toHaveURL(new RegExp(`/agents/${agent.id}$`));

    await page.goto(`/agents/${agent.id}/review/not-a-real-agent`, {
      waitUntil: "domcontentloaded",
    });
    await waitForAppShell(page, agent.name);
    await expect(page).toHaveURL(new RegExp(`/agents/${agent.id}$`));
  });

  test("base agents route stays detached until the URL selects an agent", async ({
    page,
  }) => {
    await page.goto("/agents", { waitUntil: "domcontentloaded" });
    await waitForAppShell(page);

    await expect(page).toHaveURL(/\/agents$/);
    await expect(page.getByTestId("chat-empty")).toContainText(
      "Select an agent to start chatting."
    );
  });
});
