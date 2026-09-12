import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, expect, type APIRequestContext } from "@playwright/test";

import {
  authHeaders,
  cleanupE2EAgents,
  clickAgentRow,
  createAgentViaAPI,
  loadApp,
  setDispatchHarnessViaAPI,
  setEnabledAgentTypesViaAPI,
} from "./helpers";

// A harness agent's setup runs through the tmux setup script (worktree,
// then a login shell in the pane) before the ACP child starts, so this spec
// needs the live runtime: E2E_AGENT_RUNTIME=tmux. The engine itself is the
// fake in e2e/fixtures/fake-acp-agent.mjs, selected through the four
// DISPATCH_*_HARNESS_BIN / DISPATCH_GEMINI_BIN / DISPATCH_OPENCODE_BIN
// settings.
const live = process.env.DISPATCH_AGENT_RUNTIME === "tmux";

async function setChatSurface(
  request: APIRequestContext,
  enabled: boolean
): Promise<void> {
  const res = await request.post("/api/v1/app/settings/chat-surface", {
    headers: authHeaders(),
    data: { enabled },
  });
  expect(res.ok()).toBe(true);
}

/** A throwaway git repo with one commit, so the worktree setup has a base. */
function makeRepo(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "harness-e2e-repo-"));
  writeFileSync(path.join(dir, "README.md"), "# harness e2e\n");
  mkdirSync(path.join(dir, "src"));
  writeFileSync(path.join(dir, "src", "index.ts"), "export {};\n");
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("-c", "user.email=e2e@dispatch", "-c", "user.name=e2e", "add", ".");
  git(
    "-c",
    "user.email=e2e@dispatch",
    "-c",
    "user.name=e2e",
    "commit",
    "-q",
    "-m",
    "init"
  );
  return dir;
}

test.describe("harness agent", () => {
  test.skip(!live, "harness setup completes through the tmux setup script");
  test.setTimeout(120_000);

  test.afterEach(async ({ request }) => {
    // Server-wide and not per-test: every case here turns it on, and
    // settings.spec.ts asserts the toggle starts off.
    await setDispatchHarnessViaAPI(request, false);
    await cleanupE2EAgents(request);
  });

  const ENGINES = [
    {
      model: "claude/default",
      plan: true,
      cost: true,
      chipFixed: false,
      nested: true,
    },
    {
      model: "codex/default",
      plan: true,
      cost: false,
      chipFixed: false,
      nested: false,
    },
    {
      model: "gemini/default",
      plan: false,
      cost: false,
      chipFixed: true,
      nested: false,
    },
    {
      model: "opencode/default",
      plan: false,
      cost: true,
      chipFixed: false,
      nested: false,
    },
  ] as const;

  for (const engine of ENGINES) {
    test(`${engine.model}: opens on the Agent pane's Chat, runs a turn, shows what the engine publishes`, async ({
      page,
      request,
    }) => {
      await setEnabledAgentTypesViaAPI(request, ["claude", "codex"]);
      await setDispatchHarnessViaAPI(request, true);
      await setChatSurface(request, true);
      const repo = makeRepo();
      const agent = await createAgentViaAPI(request, {
        name: `e2e-harness-${engine.model.split("/")[0]}-${Date.now()}`,
        type: "dispatch",
        model: engine.model,
        cwd: repo,
        useWorktree: true,
        initialPrompt: `kickoff: begin tasks: subagent:`,
      });
      expect(agent.status).toBe("running");

      await loadApp(page);
      await page.emulateMedia({ reducedMotion: "reduce" });
      await clickAgentRow(page, agent.id);
      await page.getByTestId("center-tab-agent").click();
      const pane = page.getByTestId("chat-pane");
      await expect(pane).toBeVisible();

      // The kickoff ran as the first turn; the persona prefix (for engines
      // that take it that way) is not shown, the launch post is. The prompt
      // is a user post inside the turn entry now, not a prompt line.
      const firstTurn = pane.getByTestId("chat-turn").first();
      await expect(firstTurn.getByTestId("chat-message").first()).toContainText(
        "kickoff: begin",
        { timeout: 30_000 }
      );
      await expect(
        firstTurn.getByTestId("harness-result").first()
      ).toContainText("You said:", { timeout: 30_000 });

      if (engine.plan) {
        await expect(pane.getByTestId("harness-tasks")).toContainText(
          "1 of 3 done",
          { timeout: 30_000 }
        );
      } else {
        await expect(pane.getByTestId("harness-tasks")).toHaveCount(0);
      }

      if (engine.nested) {
        await pane.getByTestId("harness-activity-summary").first().click();
        const task = pane
          .getByTestId("harness-step")
          .filter({ hasText: "task" })
          .first();
        await task.click();
        await expect(pane.getByTestId("harness-nested-steps")).toBeVisible();
      }

      const chip = pane.getByTestId("harness-model-chip");
      if (engine.chipFixed) {
        await expect(chip).toHaveAttribute("data-fixed", "true");
        await expect(chip).toHaveAttribute("title", /sets its model at launch/);
      } else {
        await expect(chip).not.toHaveAttribute("data-fixed", "true");
      }

      await pane.getByTestId("harness-usage-chip").click();
      const row = page.getByTestId(
        `harness-usage-engine-${engine.model.split("/")[0]}`
      );
      await expect(row).toBeVisible();
      if (engine.cost) await expect(row).toContainText("$");
      else if (engine.model.startsWith("gemini"))
        await expect(row).toContainText("not reported over ACP");
      else await expect(row).toContainText("no cost reported");
      await page.keyboard.press("Escape");

      const input = pane.getByTestId("chat-composer-input");
      await input.fill("/rev");
      await expect(
        pane.getByTestId("chat-composer-slash-item").first()
      ).toContainText("review");
      await input.fill("");
    });
  }

  test("offers paths under the working tree from an @ in the composer", async ({
    page,
    request,
  }) => {
    await setEnabledAgentTypesViaAPI(request, ["claude", "codex"]);
    await setDispatchHarnessViaAPI(request, true);
    await setChatSurface(request, true);
    const repo = makeRepo();
    const agent = await createAgentViaAPI(request, {
      name: `e2e-harness-paths-${Date.now()}`,
      type: "dispatch",
      cwd: repo,
      useWorktree: true,
    });
    expect(agent.status).toBe("running");

    await loadApp(page);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await clickAgentRow(page, agent.id);
    await page.getByTestId("center-tab-agent").click();
    const pane = page.getByTestId("chat-pane");
    await expect(pane).toBeVisible();
    const input = pane.getByTestId("chat-composer-input");
    await expect(input).toBeEnabled({ timeout: 30_000 });

    await input.fill("look at @");
    const items = pane.getByTestId("chat-composer-at-item");
    await expect(items).toHaveCount(2, { timeout: 30_000 });
    await expect(items.nth(0)).toContainText("src/");
    await expect(items.nth(1)).toContainText("README.md");
    await expect(items.nth(0)).toHaveAttribute("aria-selected", "true");
    await input.press("ArrowUp");
    await expect(items.nth(1)).toHaveAttribute("aria-selected", "true");
    await input.press("ArrowDown");
    await expect(items.nth(0)).toHaveAttribute("aria-selected", "true");
    const shotDir = process.env.E2E_SCREENSHOT_DIR;
    if (shotDir) {
      await page.screenshot({
        path: path.join(shotDir, "harness-at-picker.png"),
      });
    }

    await input.type("s");
    await expect(items).toHaveCount(1, { timeout: 30_000 });
    await input.press("Enter");
    await expect(input).toHaveValue("look at @src/");
    await expect(pane.getByTestId("chat-composer-token")).toHaveText("@src/");
    await expect(items.first()).toContainText("src/index.ts", {
      timeout: 30_000,
    });
    await expect(items.first()).toHaveAttribute("aria-selected", "true");
    if (shotDir) {
      await page.screenshot({
        path: path.join(shotDir, "harness-at-token.png"),
      });
    }
    await input.press("Tab");
    await expect(input).toHaveValue("look at @src/index.ts ");
    await expect(items).toHaveCount(0);
  });

  test("shows messages queued behind a running turn, with Send now and Remove", async ({
    page,
    request,
  }) => {
    await setEnabledAgentTypesViaAPI(request, ["claude", "codex"]);
    await setDispatchHarnessViaAPI(request, true);
    await setChatSurface(request, true);
    const repo = makeRepo();
    const agent = await createAgentViaAPI(request, {
      name: `e2e-harness-queue-${Date.now()}`,
      type: "dispatch",
      cwd: repo,
      useWorktree: true,
    });
    expect(agent.status).toBe("running");

    await loadApp(page);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await clickAgentRow(page, agent.id);
    await page.getByTestId("center-tab-agent").click();
    const pane = page.getByTestId("chat-pane");
    await expect(pane).toBeVisible();
    const input = pane.getByTestId("chat-composer-input");
    await expect(input).toBeEnabled({ timeout: 30_000 });

    // A long turn: the fake holds it until cancelled. An unsettled turn
    // entry is what "a turn is running" looks like in the feed.
    await input.fill("sleep:60000 first");
    await input.press("Enter");
    const runningTurn = pane.locator(
      '[data-testid="chat-turn"]:not([data-settled])'
    );
    await expect(runningTurn).toBeVisible({ timeout: 30_000 });
    await expect(pane.getByTestId("chat-composer-hint")).toContainText(
      "Enter queues your message"
    );

    const queued = pane.getByTestId("harness-queued");
    await input.fill("second");
    await input.press("Enter");
    // Enter is ignored while a send is in flight (the draft is kept), so
    // wait for the first to land before typing the next.
    await expect(queued).toHaveCount(1, { timeout: 30_000 });
    await input.fill("third");
    await input.press("Enter");
    await expect(queued).toHaveCount(2, { timeout: 30_000 });
    await expect(pane.getByTestId("chat-composer-hint")).toContainText(
      "↑ edits the newest queued message"
    );
    await expect(queued.nth(0)).toContainText("second");
    await expect(queued.nth(0)).toContainText("Queued");
    await expect(queued.nth(1)).toContainText("third");
    // The queue is chrome above the composer, not a row in the feed: it
    // holds the controls for what is waiting and must not scroll away.
    await expect(
      pane.getByTestId("chat-harness-chrome").getByTestId("harness-queued")
    ).toHaveCount(2);
    await expect(
      pane.getByTestId("chat-scroll").getByTestId("harness-queued")
    ).toHaveCount(0);

    await queued.nth(0).getByTestId("harness-queued-remove").click();
    await expect(queued).toHaveCount(1, { timeout: 30_000 });
    await expect(queued.first()).toContainText("third");

    await queued.first().getByTestId("harness-queued-send-now").click();
    await expect(queued).toHaveCount(0, { timeout: 30_000 });
    const turns = pane.getByTestId("chat-turn");
    await expect(turns.last().getByTestId("chat-message")).toContainText(
      "third",
      { timeout: 30_000 }
    );
    const result = turns.last().getByTestId("harness-result");
    await expect(result).toContainText("You said:", { timeout: 30_000 });
    await expect(result).toContainText("third");
    // The turn Send now cut short says so, above the turn that replaced it
    // (it never got a step, so the line is all that marks it).
    await expect(pane.getByTestId("harness-interrupted")).toHaveCount(1);
    await expect(turns).toHaveCount(2);
    await expect(turns.first().getByTestId("chat-message")).toContainText(
      "first"
    );
  });

  test("folds the queue past two rows and opens it on the count", async ({
    page,
    request,
  }) => {
    await setEnabledAgentTypesViaAPI(request, ["claude", "codex"]);
    await setDispatchHarnessViaAPI(request, true);
    await setChatSurface(request, true);
    const repo = makeRepo();
    const agent = await createAgentViaAPI(request, {
      name: `e2e-harness-fold-${Date.now()}`,
      type: "dispatch",
      cwd: repo,
      useWorktree: true,
    });

    await loadApp(page);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await clickAgentRow(page, agent.id);
    await page.getByTestId("center-tab-agent").click();
    const pane = page.getByTestId("chat-pane");
    const input = pane.getByTestId("chat-composer-input");
    await expect(input).toBeEnabled({ timeout: 30_000 });

    await input.fill("sleep:60000 first");
    await input.press("Enter");
    await expect(
      pane.locator('[data-testid="chat-turn"]:not([data-settled])')
    ).toBeVisible({ timeout: 30_000 });

    // Four behind the running turn. Each Enter is ignored while the previous
    // send is in flight, so each one waits for its row before the next.
    const queued = pane.getByTestId("harness-queued");
    for (const [i, text] of ["two", "three", "four", "five"].entries()) {
      await input.fill(text);
      await input.press("Enter");
      // Only the first two get a row; after that the count carries them.
      const expected = Math.min(i + 1, 2);
      await expect(queued).toHaveCount(expected, { timeout: 30_000 });
      if (i >= 2) {
        await expect(pane.getByTestId("harness-queued-more")).toContainText(
          `+${i - 1} more queued`
        );
      }
    }

    // Folded, the whole queue costs two rows plus the count: four waiting,
    // two shown.
    await expect(queued).toHaveCount(2);
    const more = pane.getByTestId("harness-queued-more");
    await expect(more).toContainText("+2 more queued");
    await page.screenshot({
      path: test.info().outputPath("queue-folded.png"),
      fullPage: true,
    });

    await more.click();
    await expect(queued).toHaveCount(4);
    await expect(more).toContainText("Show fewer");
    await page.screenshot({
      path: test.info().outputPath("queue-open.png"),
      fullPage: true,
    });

    // A row stays one line until its own chevron opens it.
    const first = queued.first();
    await first.getByTestId("harness-queued-toggle").click();
    await expect(first.getByTestId("harness-queued-toggle")).toHaveAttribute(
      "aria-expanded",
      "true"
    );
  });

  test("keeps step details closed until opened and preserves the choice when settled", async ({
    page,
    request,
  }) => {
    await setEnabledAgentTypesViaAPI(request, ["claude", "codex"]);
    await setDispatchHarnessViaAPI(request, true);
    await setChatSurface(request, true);
    const repo = makeRepo();
    const agent = await createAgentViaAPI(request, {
      name: `e2e-harness-live-${Date.now()}`,
      type: "dispatch",
      cwd: repo,
      useWorktree: true,
    });
    expect(agent.status).toBe("running");

    await loadApp(page);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await clickAgentRow(page, agent.id);
    await page.getByTestId("center-tab-agent").click();
    const pane = page.getByTestId("chat-pane");
    const input = pane.getByTestId("chat-composer-input");
    await expect(input).toBeEnabled({ timeout: 30_000 });

    // The fake holds a shell step open for a while before its output lands.
    await input.fill("run:8000 hold the step");
    await input.press("Enter");
    const live = pane.locator('[data-testid="chat-turn"]:not([data-settled])');
    await expect(live).toBeVisible({ timeout: 30_000 });
    const step = live.getByTestId("harness-step").filter({ hasText: "bash" });
    await expect(step.getByRole("button")).toHaveAttribute(
      "aria-expanded",
      "false",
      { timeout: 10_000 }
    );
    await step.getByRole("button").click();
    await expect(step).toContainText("$ sleep 8");
    await expect(step).not.toContainText("slept well");
    await page.screenshot({
      path: process.env.E2E_SCREENSHOT_DIR
        ? `${process.env.E2E_SCREENSHOT_DIR}/harness-live-step.png`
        : "/tmp/harness-live-step.png",
    });

    const result = pane.getByTestId("harness-result").last();
    await expect(result).toContainText("You said:", { timeout: 30_000 });
    await pane.getByTestId("harness-activity-summary").last().click();
    const settled = pane
      .getByTestId("harness-step")
      .filter({ hasText: "bash" })
      .first();
    await expect(settled.getByRole("button")).toHaveAttribute(
      "aria-expanded",
      "true"
    );
    await expect(settled).toContainText("sleep 8");
    await expect(settled).toContainText("slept well");
  });
});
