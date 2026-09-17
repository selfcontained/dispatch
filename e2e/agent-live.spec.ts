import { expect, test, type Page } from "@playwright/test";

import { cleanupE2EAgents, loadApp } from "./helpers";

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
  await expect(input).toHaveValue("");
}

test.describe("Live agent", () => {
  test.afterAll(async ({ request }) => {
    await cleanupE2EAgents(request, "all");
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
    await expect(stop).toHaveCount(0);

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
