import { expect, test, type Page } from "@playwright/test";

import {
  authHeaders,
  cleanupE2EAgents,
  createAgentViaAPI,
  loadApp,
} from "./helpers";

// Live mode only (`pnpm run test:e2e:live`): the server spawns real agent
// hosts against the fake ACP engine in e2e/fixtures/fake-acp-agent.mjs, which
// answers every prompt with `You said: <prompt>`, delays the turn for
// `sleep:<ms>`, and honors cancel.
test.skip(
  process.env.DISPATCH_AGENT_RUNTIME !== "acp",
  "needs the live ACP runtime (pnpm run test:e2e:live)"
);

const TURN_TIMEOUT = 30_000;

async function sendChat(page: Page, text: string): Promise<void> {
  const input = page.getByTestId("chat-composer-input");
  await expect(input).toBeEnabled({ timeout: TURN_TIMEOUT });
  await input.fill(text);
  await page.getByTestId("chat-composer-send").click();
  await expect(input).toHaveText("");
}

test.describe("Live agent", () => {
  test("restricted approvals survive reload, allow and deny reach the engine, and stop cancels", async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    const agent = await createAgentViaAPI(request, {
      name: `e2e-permissions-${Date.now()}`,
      type: "claude",
      fullAccess: false,
    });
    await page.goto(`/agents/${agent.id}`, { waitUntil: "domcontentloaded" });
    await sendChat(page, "permission-test");
    const approvals = page.getByTestId("permission-requests");
    await expect(approvals).toContainText("Run workspace validation", {
      timeout: TURN_TIMEOUT,
    });
    const state = await request.get(`/api/v1/agents/${agent.id}`, {
      headers: authHeaders(),
    });
    expect((await state.json()).agent.activity).toBe("waiting");
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(approvals).toContainText("pnpm run check");
    await approvals
      .getByRole("button", { name: "Allow once", exact: true })
      .click();
    await expect(approvals).toHaveCount(0);
    await expect(page.getByTestId("harness-result").last()).toContainText(
      "Permission result: once"
    );
    await sendChat(page, "permission-test deny");
    await expect(approvals).toBeVisible();
    await approvals
      .getByRole("button", { name: "Reject", exact: true })
      .click();
    await expect(page.getByTestId("harness-result").last()).toContainText(
      "Permission result: no"
    );
    await sendChat(page, "permission-test stop");
    await expect(approvals).toBeVisible();
    await page.getByTestId("chat-stop-turn").click();
    await expect(approvals).toHaveCount(0);
    const res = await request.get(`/api/v1/agents/${agent.id}/permissions`, {
      headers: authHeaders(),
    });
    expect((await res.json()).requests).toEqual([]);
  });

  test.afterAll(async ({ request }) => {
    await cleanupE2EAgents(request, "all");
  });

  test("composer chooses which of two active agents to stop", async ({
    page,
    request,
  }) => {
    test.setTimeout(90_000);
    const first = await createAgentViaAPI(request, {
      name: `e2e-stop-first-${Date.now()}`,
      type: "codex",
    });
    const second = await createAgentViaAPI(request, {
      name: `e2e-stop-second-${Date.now()}`,
      type: "codex",
    });
    await loadApp(page);
    await page.goto(`/agents/${first.id}`, { waitUntil: "domcontentloaded" });
    await sendChat(page, "sleep:20000 first");
    await expect(page.getByTestId("chat-turn").last()).not.toHaveAttribute(
      "data-settled",
      "true"
    );
    await page.goto(`/agents/${second.id}`, { waitUntil: "domcontentloaded" });
    await sendChat(page, "sleep:20000 second");
    const stop = page.getByTestId("chat-stop-turn");
    await expect(stop).toHaveAttribute("aria-haspopup", "menu", {
      timeout: TURN_TIMEOUT,
    });
    await stop.click();
    await expect(page.getByTestId(`chat-stop-agent-${first.id}`)).toBeVisible();
    await expect(
      page.getByTestId(`chat-stop-agent-${second.id}`)
    ).toBeVisible();
    await test.info().attach("choose-agent-to-stop", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
    await page.getByTestId(`chat-stop-agent-${first.id}`).click();
    await page.goto(`/agents/${first.id}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("harness-interrupted")).toBeVisible({
      timeout: TURN_TIMEOUT,
    });
    const stillRunning = await request.get(`/api/v1/agents/${second.id}`, {
      headers: authHeaders(),
    });
    expect((await stillRunning.json()).agent.currentTurn).not.toBeNull();
    await page.goto(`/agents/${second.id}`, { waitUntil: "domcontentloaded" });
    await expect(stop).not.toHaveAttribute("aria-haspopup", "menu");
    await stop.click();
    await expect(page.getByTestId("harness-interrupted")).toBeVisible({
      timeout: TURN_TIMEOUT,
    });
  });

  test("Stop picker scrolls long agent names inside a small mobile viewport", async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    const agents = [];
    for (let index = 0; index < 8; index++) {
      agents.push(
        await createAgentViaAPI(request, {
          name: `e2e-stop-${index}-${"long-agent-name-".repeat(5)}`,
          type: "codex",
        })
      );
    }
    for (const agent of agents) {
      await expect
        .poll(
          async () => {
            const response = await request.get(`/api/v1/agents/${agent.id}`, {
              headers: authHeaders(),
            });
            return ((await response.json()) as { agent: { status: string } })
              .agent.status;
          },
          { timeout: TURN_TIMEOUT }
        )
        .toBe("running");
      const response = await request.post(
        `/api/v1/streams/${agent.id}/blocks`,
        {
          headers: authHeaders(),
          data: { text: "sleep:60000" },
        }
      );
      expect(response.ok(), await response.text()).toBe(true);
    }
    await expect
      .poll(
        async () => {
          const response = await request.get("/api/v1/agents", {
            headers: authHeaders(),
          });
          const payload = (await response.json()) as {
            agents: Array<{ id: string; currentTurn: unknown }>;
          };
          const ids = new Set(agents.map((agent) => agent.id));
          return payload.agents.filter(
            (agent) => ids.has(agent.id) && agent.currentTurn
          ).length;
        },
        { timeout: TURN_TIMEOUT }
      )
      .toBe(agents.length);

    await page.setViewportSize({ width: 320, height: 360 });
    await loadApp(page);
    await page.goto(`/agents/${agents[0]!.id}`, {
      waitUntil: "domcontentloaded",
    });
    const stop = page.getByTestId("chat-stop-turn");
    await expect(stop).toHaveAttribute("aria-haspopup", "menu", {
      timeout: TURN_TIMEOUT,
    });
    await stop.click();
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    const bounds = await menu.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(360);
    const scroll = await menu.evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
    }));
    expect(scroll.scrollHeight).toBeGreaterThan(scroll.clientHeight);
    const label = menu.locator("span.truncate").first();
    expect(
      await label.evaluate(
        (element) => element.scrollWidth > element.clientWidth
      )
    ).toBe(true);
    const last = page.getByTestId(`chat-stop-agent-${agents.at(-1)!.id}`);
    await last.scrollIntoViewIfNeeded();
    const lastBounds = await last.boundingBox();
    const scrolledBounds = await menu.boundingBox();
    expect(lastBounds).not.toBeNull();
    expect(scrolledBounds).not.toBeNull();
    expect(lastBounds!.y).toBeGreaterThanOrEqual(scrolledBounds!.y);
    expect(lastBounds!.y + lastBounds!.height).toBeLessThanOrEqual(
      scrolledBounds!.y + scrolledBounds!.height
    );
    await test.info().attach("mobile-stop-picker", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
    for (const agent of agents) {
      const response = await request.post(
        `/api/v1/agents/${agent.id}/runtime/cancel`,
        { headers: authHeaders() }
      );
      expect(response.ok()).toBe(true);
    }
    await expect
      .poll(
        async () => {
          const response = await request.get("/api/v1/agents", {
            headers: authHeaders(),
          });
          const payload = (await response.json()) as {
            agents: Array<{ id: string; currentTurn: unknown }>;
          };
          const ids = new Set(agents.map((agent) => agent.id));
          return payload.agents.filter(
            (agent) => ids.has(agent.id) && agent.currentTurn
          ).length;
        },
        { timeout: TURN_TIMEOUT }
      )
      .toBe(0);
  });

  test("Send steers the active turn and Queue waits without interrupting it", async ({
    page,
    request,
  }) => {
    test.setTimeout(90_000);
    const agent = await createAgentViaAPI(request, {
      name: `e2e-steering-${Date.now()}`,
      type: "codex",
    });
    await loadApp(page);
    await page.goto(`/agents/${agent.id}`, { waitUntil: "domcontentloaded" });
    await sendChat(page, "sleep:10000 original work");
    const turns = page.getByTestId("chat-turn");
    await expect(turns).toHaveCount(1, { timeout: TURN_TIMEOUT });
    await expect(turns.first()).not.toHaveAttribute("data-settled", "true");
    const initial = page
      .locator('[data-testid="chat-message"][data-author-kind="user"]')
      .filter({ hasText: "sleep:10000 original work" });
    await expect(
      initial.getByRole("button", { name: "Message delivery details" })
    ).toHaveCount(0);
    await sendChat(page, "incorporate this correction");
    const correction = page
      .locator('[data-testid="chat-message"][data-author-kind="user"]')
      .filter({ hasText: "incorporate this correction" });
    await expect(correction.getByTestId("chat-receipt-sent")).toBeVisible();
    const sentHeight = (await correction.boundingBox())!.height;
    const slot = correction.getByTestId("chat-delivery-slot");
    const sentSlot = await slot.boundingBox();
    await correction.hover();
    const hoveredSlot = await slot.boundingBox();
    expect(sentSlot).not.toBeNull();
    expect(hoveredSlot).not.toBeNull();
    expect(Math.abs(hoveredSlot!.x - sentSlot!.x)).toBeLessThan(1);
    expect(Math.abs(hoveredSlot!.y - sentSlot!.y)).toBeLessThan(1);
    expect(hoveredSlot!.width).toBe(sentSlot!.width);
    expect(hoveredSlot!.height).toBe(sentSlot!.height);
    expect(
      await slot.evaluate(
        (e) => !!e.closest('[data-testid="chat-post-action"]')
      )
    ).toBe(false);
    await expect(correction.getByTestId("chat-receipt-received")).toBeVisible();
    expect((await correction.boundingBox())!.height).toBe(sentHeight);
    await expect(correction.getByTestId("chat-receipt-received")).toHaveCount(
      0
    );
    expect((await correction.boundingBox())!.height).toBe(sentHeight);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(correction.getByTestId("chat-receipt-received")).toHaveCount(
      0
    );
    await expect(correction.getByTestId("chat-delivery-indicator")).toHaveClass(
      /opacity-0/
    );
    await expect(turns.first()).toContainText("Steered:", {
      timeout: TURN_TIMEOUT,
    });
    await expect(turns).toHaveCount(1);
    await expect(turns.first()).not.toHaveAttribute("data-settled", "true");
    const input = page.getByTestId("chat-composer-input");
    await input.fill("a separate task for later");
    await page.getByTestId("chat-composer-send-options").click();
    await page.getByTestId("chat-composer-queue").click();
    await expect(input).toHaveText("");
    await expect(page.getByTestId("chat-held-hint")).toBeVisible();
    await expect(turns).toHaveCount(2, { timeout: TURN_TIMEOUT });
    await expect(turns.last()).toHaveAttribute("data-settled", "true", {
      timeout: TURN_TIMEOUT,
    });
    await expect(turns.last()).toContainText("a separate task for later");
    await expect(page.getByTestId("harness-interrupted")).toHaveCount(0);
    await expect(page.getByTestId("chat-held-hint")).toHaveCount(0);
  });

  test("a queued ACP command cannot be promoted to steering and runs in its own turn", async ({
    page,
    request,
  }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-command-queue-${Date.now()}`,
      type: "codex",
    });
    await loadApp(page);
    await page.goto(`/agents/${agent.id}`, { waitUntil: "domcontentloaded" });
    await sendChat(page, "sleep:10000 original work");
    const turns = page.getByTestId("chat-turn");
    await expect(turns).toHaveCount(1, { timeout: TURN_TIMEOUT });
    await sendChat(page, "/compact");
    const command = page
      .locator('[data-testid="chat-message"][data-author-kind="user"]')
      .filter({ hasText: "/compact" });
    await expect(command.getByTestId("chat-held-hint")).toBeVisible();
    await expect(
      command.getByRole("button", { name: "Send now", exact: true })
    ).toHaveCount(0);
    await expect(
      command.getByRole("button", { name: "Delete", exact: true })
    ).toBeVisible();
    const blockId = await command.getAttribute("data-block-id");
    const promoted = await request.post(
      `/api/v1/streams/${agent.id}/blocks/${blockId}/send-now`,
      { headers: authHeaders() }
    );
    expect(promoted.status()).toBe(400);
    await expect(turns.first()).not.toContainText("Steered:");
    await expect(turns).toHaveCount(2, { timeout: TURN_TIMEOUT });
    await expect(turns.last()).toHaveAttribute("data-settled", "true", {
      timeout: TURN_TIMEOUT,
    });
    await expect(turns.last()).toContainText("/compact");
    await expect(turns.last()).not.toContainText("DISPATCH POST");
  });

  test("Send now on a post queued behind another conversation interrupts that turn and opens its own", async ({
    page,
    request,
  }) => {
    test.setTimeout(90_000);
    const agent = await createAgentViaAPI(request, {
      name: `e2e-send-now-interrupt-${Date.now()}`,
      type: "codex",
    });
    const post = async (body: Record<string, unknown>) => {
      const res = await request.post(`/api/v1/streams/${agent.id}/blocks`, {
        headers: authHeaders(),
        data: body,
      });
      return ((await res.json()) as { block: { id: string } }).block.id;
    };
    // The host is up once the agent leaves `creating`.
    await expect
      .poll(
        async () => {
          const res = await request.get(`/api/v1/agents/${agent.id}`, {
            headers: authHeaders(),
          });
          return ((await res.json()) as { agent: { status: string } }).agent
            .status;
        },
        { timeout: TURN_TIMEOUT }
      )
      .toBe("running");
    await loadApp(page);
    await page.goto(`/agents/${agent.id}`, { waitUntil: "domcontentloaded" });
    const rootId = await post({ text: "root post" });
    const turns = page.getByTestId("chat-turn");
    await expect(turns).toHaveCount(1, { timeout: TURN_TIMEOUT });
    await expect(turns.first()).toHaveAttribute("data-settled", "true", {
      timeout: TURN_TIMEOUT,
    });
    // A long turn in the thread; a main-column post cannot steer into it.
    // Wait until the engine is inside its delay: a cancel that lands in the
    // same instant as the prompt itself is a race no person can produce.
    await post({ text: "sleep:60000 thread work", replyTo: rootId });
    await expect
      .poll(
        async () => {
          const res = await request.get(
            `/api/v1/streams/${agent.id}/blocks/${rootId}/thread`,
            { headers: authHeaders() }
          );
          return JSON.stringify(await res.json());
        },
        { timeout: TURN_TIMEOUT }
      )
      .toContain("Waiting for the requested delay.");
    await expect(page.getByTestId("chat-stop-turn")).toBeVisible();
    await sendChat(page, "urgent main post");
    const queued = page
      .locator('[data-testid="chat-message"][data-author-kind="user"]')
      .filter({ hasText: "urgent main post" });
    await expect(queued.getByTestId("chat-held-hint")).toContainText(
      "Queued until the turn ends"
    );
    const sendNow = queued.getByRole("button", {
      name: "Send now",
      exact: true,
    });
    await expect(sendNow).toHaveAttribute("data-send-now", "interrupt");
    await sendNow.click();
    // Its own turn, in the main column, after the thread's turn was cut.
    await expect(turns).toHaveCount(2, { timeout: TURN_TIMEOUT });
    await expect(turns.last()).toContainText("urgent main post", {
      timeout: TURN_TIMEOUT,
    });
    await expect(turns.last()).toHaveAttribute("data-settled", "true", {
      timeout: TURN_TIMEOUT,
    });
    await expect(queued.getByTestId("chat-held-hint")).toHaveCount(0);
    const thread = await request.get(
      `/api/v1/streams/${agent.id}/blocks/${rootId}/thread`,
      { headers: authHeaders() }
    );
    expect(JSON.stringify(await thread.json())).toContain('"interrupted"');
  });

  test("a reply in a thread opens a turn drawn in that thread, not the main column", async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    const agent = await createAgentViaAPI(request, {
      name: `e2e-live-thread-${Date.now()}`,
      type: "claude",
    });
    // The host is up once the agent leaves `creating`.
    await expect
      .poll(
        async () => {
          const res = await request.get(`/api/v1/agents/${agent.id}`, {
            headers: authHeaders(),
          });
          return ((await res.json()) as { agent: { status: string } }).agent
            .status;
        },
        { timeout: TURN_TIMEOUT }
      )
      .toBe("running");

    const post = async (body: Record<string, unknown>) => {
      const res = await request.post(`/api/v1/streams/${agent.id}/blocks`, {
        headers: authHeaders(),
        data: body,
      });
      return ((await res.json()) as { block: { id: string } }).block.id;
    };
    const rootId = await post({ text: "root post" });
    await post({ text: "in the thread", replyTo: rootId, delivery: "queue" });

    await page.goto(`/agents/${agent.id}?thread=${rootId}`, {
      waitUntil: "domcontentloaded",
    });
    const threadPage = page.locator(
      '[data-testid="drawer-page"][data-top="true"]'
    );
    const threadTurn = threadPage.getByTestId("chat-thread-turn");
    await expect(threadTurn).toHaveCount(1, { timeout: TURN_TIMEOUT });
    await expect(threadTurn.getByTestId("harness-result")).toContainText(
      "You said:",
      { timeout: TURN_TIMEOUT }
    );
    await expect(threadTurn.getByTestId("harness-result")).toContainText(
      "in the thread"
    );
    const threadInput = threadPage.getByTestId("chat-composer-input");
    await threadInput.fill("draft reply");
    await threadPage.getByTestId("chat-composer-send-options").click();
    await expect(page.getByTestId("chat-composer-queue")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("chat-composer-queue")).toHaveCount(0);
    await expect(threadPage).toBeVisible();
    await expect(threadInput).toHaveText("draft reply");
    await threadInput.fill("");
    // The main column keeps only the turn the root post opened.
    const mainTurns = page.getByTestId("chat-pane").getByTestId("chat-turn");
    await expect(mainTurns).toHaveCount(1);
    await expect(mainTurns.first().getByTestId("harness-result")).toContainText(
      "root post",
      { timeout: TURN_TIMEOUT }
    );
  });

  test("create, chat, cancel a turn, stop, start and archive", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await loadApp(page);

    // Create a Claude agent with an initial prompt, through the dialog.
    await page.getByTestId("create-agent-button").click();
    const form = page.getByTestId("create-agent-form");
    await expect(form).toBeVisible();
    const typeTrigger = form.getByRole("combobox").first();
    await typeTrigger.click();
    await page.getByRole("option", { name: "Claude" }).click();
    await expect(typeTrigger).toContainText("Claude");

    const agentName = `e2e-agent-live-${Date.now()}`;
    await page.getByTestId("create-agent-name").fill(agentName);
    await page.getByTestId("create-agent-cwd").fill("/tmp");
    await expect(form.getByText("Valid directory")).toBeVisible();
    await page.getByTestId("create-agent-with-context").click();
    await page
      .getByTestId("create-agent-initial-prompt")
      .fill("hello from the live suite");

    const createResponse = page.waitForResponse(
      (resp) =>
        resp.request().method() === "POST" &&
        new URL(resp.url()).pathname === "/api/v1/agents" &&
        resp.status() === 201
    );
    await page.getByTestId("create-agent-context-submit").click();
    const { agent } = (await (await createResponse).json()) as {
      agent: { id: string };
    };
    await expect(page).toHaveURL(new RegExp(`/agents/${agent.id}$`), {
      timeout: 15_000,
    });

    // The launch prompt runs as the first turn and settles with the engine's
    // answer.
    const turns = page.getByTestId("chat-turn");
    const firstTurn = turns.first();
    await expect(firstTurn).toHaveAttribute("data-settled", "true", {
      timeout: TURN_TIMEOUT,
    });
    await expect(firstTurn.getByTestId("harness-result")).toContainText(
      "You said:",
      { timeout: TURN_TIMEOUT }
    );
    await expect(firstTurn.getByTestId("harness-result")).toContainText(
      "hello from the live suite"
    );

    // A chat message becomes a second turn.
    await sendChat(page, "second message");
    await expect(turns).toHaveCount(2, { timeout: TURN_TIMEOUT });
    await expect(turns.nth(1)).toHaveAttribute("data-settled", "true", {
      timeout: TURN_TIMEOUT,
    });
    await expect(turns.nth(1).getByTestId("harness-result")).toContainText(
      "You said:"
    );
    await expect(turns.nth(1).getByTestId("harness-result")).toContainText(
      "second message"
    );

    // A long turn shows Stop while it runs; Stop ends it as interrupted.
    await sendChat(page, "sleep:20000");
    await expect(turns).toHaveCount(3, { timeout: TURN_TIMEOUT });
    const stop = page.getByTestId("chat-stop-turn");
    await expect(stop).toBeVisible({ timeout: TURN_TIMEOUT });
    await stop.click();
    await expect(turns.nth(2)).toHaveAttribute("data-settled", "true", {
      timeout: 15_000,
    });
    await expect(turns.nth(2).getByTestId("harness-interrupted")).toBeVisible();
    await expect(stop).toHaveAttribute("aria-label", "No active turns");

    // Stop the agent from its sidebar card, then start it again.
    const card = page.getByTestId(`agent-card-${agent.id}`);
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: "Pause", exact: true }).click();
    await page.getByTestId("stop-agent-confirm").click();
    const resume = card.getByRole("button", { name: "Resume", exact: true });
    await expect(resume).toBeVisible({ timeout: 20_000 });
    // Stopping the focused agent drops focus, and a stopped agent's row does
    // not open it; its route still shows the feed.
    await page.goto(`/agents/${agent.id}`, { waitUntil: "domcontentloaded" });
    await expect(turns).toHaveCount(3);
    await expect(
      page.getByTestId("chat-composer-disabled-reason")
    ).toContainText("not running");

    await resume.click();
    await expect(
      card.getByRole("button", { name: "Pause", exact: true })
    ).toBeVisible({
      timeout: TURN_TIMEOUT,
    });

    // The restarted host resumes the session and still answers.
    await sendChat(page, "after restart");
    const lastTurn = turns.last();
    await expect(lastTurn.getByTestId("harness-result")).toContainText(
      "after restart",
      { timeout: TURN_TIMEOUT }
    );

    // Archive it.
    await page.getByTestId(`agent-archive-${agent.id}`).click();
    await page.getByTestId("delete-agent-confirm").click();
    await expect(card).toHaveCount(0, { timeout: 20_000 });
  });
});
