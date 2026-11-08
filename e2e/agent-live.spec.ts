import { expect, test, type Page } from "@playwright/test";

import {
  authHeaders,
  cleanupE2EAgents,
  createAgentViaAPI,
  loadApp,
  trackAgent,
} from "./helpers";

// The default suite spawns real agent
// hosts against the fake ACP engine in e2e/fixtures/fake-acp-agent.mjs, which
// answers every prompt with `You said: <prompt>`, delays the turn for
// `sleep:<ms>`, and honors cancel.
test.beforeAll(() => {
  expect(
    process.env.DISPATCH_AGENT_RUNTIME,
    "Run via pnpm run test:e2e (isolated fake ACP runtime)"
  ).toBe("acp");
});

const TURN_TIMEOUT = 30_000;

async function sendChat(page: Page, text: string): Promise<void> {
  const input = page.getByTestId("chat-composer-input");
  await expect(input).toBeEnabled({ timeout: TURN_TIMEOUT });
  await input.fill(text);
  await page.getByTestId("chat-composer-send").click();
  await expect(input).toHaveText("");
}

// Other journeys can have active turns. The shared Stop control then opens a
// picker; select this test's agent instead of assuming the app is otherwise idle.
async function stopTurn(page: Page, agentId: string): Promise<void> {
  const cancelled = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname ===
        `/api/v1/agents/${agentId}/runtime/cancel` &&
      response.request().method() === "POST"
  );
  const choice = page.getByTestId(`chat-stop-agent-${agentId}`);
  await page.getByTestId("chat-stop-turn").click();
  await Promise.race([cancelled, choice.waitFor({ state: "visible" })]);
  if (await choice.isVisible()) await choice.click();
  expect((await cancelled).ok()).toBeTruthy();
}

test.describe("Live agent", () => {
  test("restricted approvals survive reload, allow and deny reach the engine, and stop cancels", async ({
    page,
    request,
  }, testInfo) => {
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
    await stopTurn(page, agent.id);
    await expect(approvals).toHaveCount(0);
    const res = await request.get(`/api/v1/agents/${agent.id}/permissions`, {
      headers: authHeaders(),
    });
    expect((await res.json()).requests).toEqual([]);
    await testInfo.attach("approval and cancellation", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
  });

  test.afterEach(async ({ request }) => {
    await cleanupE2EAgents(request);
  });

  test("thread input opens a reply in its discussion while root work stays home", async ({
    page,
    request,
  }, testInfo) => {
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
    const replyId = await post({
      text: "in the thread",
      replyTo: rootId,
      delivery: "queue",
    });

    await page.goto(`/agents/${agent.id}?thread=${rootId}`, {
      waitUntil: "domcontentloaded",
    });
    const threadPage = page
      .getByTestId("chat-thread-panel")
      .filter({ visible: true });
    const mainTurns = page.getByTestId("chat-pane").getByTestId("chat-turn");
    await expect(mainTurns).toHaveCount(1, { timeout: TURN_TIMEOUT });
    await expect(mainTurns.first().getByTestId("harness-result")).toContainText(
      "root post"
    );
    const threadTurns = threadPage.getByTestId("chat-thread-turn");
    await expect(threadTurns).toHaveCount(1, { timeout: TURN_TIMEOUT });
    await expect(
      threadTurns.first().getByTestId("harness-result")
    ).toContainText("in the thread", { timeout: TURN_TIMEOUT });
    await expect(
      threadTurns.getByTestId("turn-source-discussion")
    ).toHaveAttribute("href", new RegExp(`thread=${rootId}.*block=${replyId}`));
    // Output ownership survives reload while source input stays at its original anchor.
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(mainTurns).toHaveCount(1);
    await expect(threadPage.getByTestId("chat-thread-turn")).toHaveCount(1);
    await expect(threadPage).toContainText("in the thread");
    const screenshotPath = "/tmp/thread-live-regression.png";
    await page.screenshot({ path: screenshotPath });
    await testInfo.attach("thread output with independent root work", {
      path: screenshotPath,
      contentType: "image/png",
    });
  });

  test("create, chat, cancel a turn, stop, start and archive", async ({
    page,
  }, testInfo) => {
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
    trackAgent(agent.id);
    await expect(page).toHaveURL(
      (url) => url.pathname === `/agents/${agent.id}`,
      {
        timeout: 15_000,
      }
    );

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
    await stopTurn(page, agent.id);
    await expect(turns.nth(2)).toHaveAttribute("data-settled", "true", {
      timeout: 15_000,
    });
    await expect(turns.nth(2).getByTestId("harness-interrupted")).toBeVisible();

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
    await expect(page.getByTestId("chat-composer-input")).toHaveAttribute(
      "aria-placeholder",
      /not running/
    );

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

    await testInfo.attach("conversation after restart", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
    // Archive it.
    await page.getByTestId(`agent-archive-${agent.id}`).click();
    await page.getByTestId("delete-agent-confirm").click();
    await expect(card).toHaveCount(0, { timeout: 20_000 });
  });
});
