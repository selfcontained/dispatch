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

      // The tasks strip shows for engines that publish a plan, and only them.
      if (engine.plan) {
        await expect(pane.getByTestId("harness-tasks")).toContainText(
          "1 of 3 done",
          { timeout: 30_000 }
        );
      } else {
        await expect(pane.getByTestId("harness-tasks")).toHaveCount(0);
      }

      // A Claude subagent's steps nest under the Task step.
      if (engine.nested) {
        await pane.getByTestId("harness-activity-summary").first().click();
        const task = pane
          .getByTestId("harness-step")
          .filter({ hasText: "task" })
          .first();
        await task.click();
        await expect(pane.getByTestId("harness-nested-steps")).toBeVisible();
      }

      // The model chip is disabled with a reason for an engine that fixes its model.
      const chip = pane.getByTestId("harness-model-chip");
      if (engine.chipFixed) {
        await expect(chip).toHaveAttribute("data-fixed", "true");
        await expect(chip).toHaveAttribute("title", /sets its model at launch/);
      } else {
        await expect(chip).not.toHaveAttribute("data-fixed", "true");
      }

      // The usage dialog names the engine and says what it reports.
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

      // Slash menu lists the engine's commands.
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

    // "@" lists the worktree root: directories first, then files.
    await input.fill("look at @");
    const items = pane.getByTestId("chat-composer-at-item");
    await expect(items).toHaveCount(2, { timeout: 30_000 });
    await expect(items.nth(0)).toContainText("src/");
    await expect(items.nth(1)).toContainText("README.md");
    // The first row is picked by default; ArrowUp wraps to the last row,
    // ArrowDown comes back, and the marked row is the one Enter takes.
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

    // Typing narrows; picking a directory descends into it.
    await input.type("s");
    await expect(items).toHaveCount(1, { timeout: 30_000 });
    await input.press("Enter");
    await expect(input).toHaveValue("look at @src/");
    // The picked path is painted as a token over the field.
    await expect(pane.getByTestId("chat-composer-token")).toHaveText("@src/");
    await expect(items.first()).toContainText("src/index.ts", {
      timeout: 30_000,
    });
    // The single child row is marked as the pick.
    await expect(items.first()).toHaveAttribute("aria-selected", "true");
    if (shotDir) {
      await page.screenshot({
        path: path.join(shotDir, "harness-at-token.png"),
      });
    }
    // A file pick ends the token.
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

    // Two more land in the queue, in order, above the composer.
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

    // Remove drops one without it ever running.
    await queued.nth(0).getByTestId("harness-queued-remove").click();
    await expect(queued).toHaveCount(1, { timeout: 30_000 });
    await expect(queued.first()).toContainText("third");

    // Send now interrupts the sleeping turn and runs "third" next.
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
    // "second" never ran: it opened no turn of its own.
    await expect(turns).toHaveCount(2);
    await expect(turns.first().getByTestId("chat-message")).toContainText(
      "first"
    );
  });

  test("shows a running step's command live, then folds it when it settles", async ({
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
    // While it runs the row is open on the command it was asked to run.
    await expect(step.getByRole("button")).toHaveAttribute(
      "aria-expanded",
      "true",
      { timeout: 10_000 }
    );
    await expect(step).toContainText("$ sleep 8");
    await expect(step).not.toContainText("slept well");
    await page.screenshot({
      path: process.env.E2E_SCREENSHOT_DIR
        ? `${process.env.E2E_SCREENSHOT_DIR}/harness-live-step.png`
        : "/tmp/harness-live-step.png",
    });

    // Settled, the step folds to one line and the turn goes on.
    const result = pane.getByTestId("harness-result").last();
    await expect(result).toContainText("You said:", { timeout: 30_000 });
    await pane.getByTestId("harness-activity-summary").last().click();
    const settled = pane
      .getByTestId("harness-step")
      .filter({ hasText: "bash" })
      .first();
    await expect(settled.getByRole("button")).toHaveAttribute(
      "aria-expanded",
      "false"
    );
    await expect(settled).toContainText("sleep 8");
    await settled.getByRole("button").click();
    await expect(settled).toContainText("slept well");
  });
});
