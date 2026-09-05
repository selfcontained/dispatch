import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, expect, type APIRequestContext } from "@playwright/test";

import {
  authHeaders,
  cleanupE2EAgents,
  clickAgentRow,
  createAgentViaAPI,
  loadApp,
  setEnabledAgentTypesViaAPI,
} from "./helpers";

// A dsh agent's setup runs through the tmux setup script (worktree, then a
// login shell in the pane) before the ACP child starts, so this spec needs
// the live runtime: E2E_AGENT_RUNTIME=tmux. The harness itself is the fake
// in e2e/fixtures/fake-dsh.mjs, selected through DISPATCH_DSH_BIN.
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
  const dir = mkdtempSync(path.join(os.tmpdir(), "dsh-e2e-repo-"));
  writeFileSync(path.join(dir, "README.md"), "# dsh e2e\n");
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

test.describe("dsh agent", () => {
  test.skip(!live, "dsh setup completes through the tmux setup script");
  test.setTimeout(120_000);

  test.afterEach(async ({ request }) => {
    await cleanupE2EAgents(request);
  });

  test("opens on the Harness view and runs a turn there", async ({
    page,
    request,
  }) => {
    await setEnabledAgentTypesViaAPI(request, ["claude", "codex", "dsh"]);
    await setChatSurface(request, true);
    const repo = makeRepo();
    const agent = await createAgentViaAPI(request, {
      name: `e2e-dsh-${Date.now()}`,
      type: "dsh",
      cwd: repo,
      useWorktree: true,
      // A persona launch hands its kickoff over this way; dsh takes no
      // launch argument, so it must arrive as the first turn.
      initialPrompt: "kickoff: begin",
    });
    expect(agent.status).toBe("running");

    await loadApp(page);
    await clickAgentRow(page, agent.id);
    await page.getByTestId("center-tab-agent").click();

    // A Dispatch Harness agent opens on the Harness view.
    await expect(page.getByTestId("agent-view-toggle")).toHaveAttribute(
      "data-view",
      "harness"
    );
    const harness = page.getByTestId("harness-pane");
    await expect(harness).toBeVisible();

    // The initial prompt ran as the first turn before anything was typed.
    await expect(harness.getByTestId("harness-prompt").first()).toContainText(
      "kickoff: begin",
      { timeout: 30_000 }
    );
    await expect(harness.getByTestId("harness-result").first()).toContainText(
      "You said:",
      { timeout: 30_000 }
    );

    const input = harness.getByTestId("chat-composer-input");
    await input.fill("hello harness");
    await input.press("Enter");

    // Prompt line, then the turn's activity settles to a collapsed summary
    // (one tool call in the fake), then the echoed result.
    await expect(harness.getByTestId("harness-prompt").last()).toContainText(
      "hello harness"
    );
    await expect(
      harness.getByTestId("harness-activity-summary").last()
    ).toContainText("1 step", { timeout: 30_000 });
    const result = harness.getByTestId("harness-result").last();
    await expect(result).toContainText("You said:", { timeout: 30_000 });
    await expect(result).toContainText("hello harness");

    // Harness stands in for Chat: the toggle is Harness | Console.
    await expect(page.getByTestId("agent-view-chat")).toHaveCount(0);
    await expect(page.getByTestId("agent-view-console")).toBeVisible();

    await expect
      .poll(
        async () => {
          const res = await request.get(`/api/v1/agents/${agent.id}`, {
            headers: authHeaders(),
          });
          const body = (await res.json()) as {
            agent: { latestEvent: { type: string } | null };
          };
          return body.agent.latestEvent?.type ?? null;
        },
        { timeout: 30_000 }
      )
      .toBe("idle");
  });

  test("shows messages queued behind a running turn, with Send now and Remove", async ({
    page,
    request,
  }) => {
    await setEnabledAgentTypesViaAPI(request, ["claude", "codex", "dsh"]);
    await setChatSurface(request, true);
    const repo = makeRepo();
    const agent = await createAgentViaAPI(request, {
      name: `e2e-dsh-queue-${Date.now()}`,
      type: "dsh",
      cwd: repo,
      useWorktree: true,
    });
    expect(agent.status).toBe("running");

    await loadApp(page);
    await clickAgentRow(page, agent.id);
    await page.getByTestId("center-tab-agent").click();
    const harness = page.getByTestId("harness-pane");
    await expect(harness).toBeVisible();
    const input = harness.getByTestId("chat-composer-input");
    await expect(input).toBeEnabled({ timeout: 30_000 });

    // A long turn: the fake holds it until cancelled.
    await input.fill("sleep:60000 first");
    await input.press("Enter");
    await expect(harness.getByTestId("harness-live-activity")).toBeVisible({
      timeout: 30_000,
    });
    await expect(harness.getByTestId("chat-composer-hint")).toHaveText(
      "Agent is working · Enter queues your message"
    );

    // Two more land in the queue, in order, under the live turn.
    await input.fill("second");
    await input.press("Enter");
    await input.fill("third");
    await input.press("Enter");
    const queued = harness.getByTestId("harness-queued");
    await expect(queued).toHaveCount(2, { timeout: 30_000 });
    await expect(queued.nth(0)).toContainText("second");
    await expect(queued.nth(0)).toContainText("Queued");
    await expect(queued.nth(1)).toContainText("third");

    // Remove drops one without it ever running.
    await queued.nth(0).getByTestId("harness-queued-remove").click();
    await expect(queued).toHaveCount(1, { timeout: 30_000 });
    await expect(queued.first()).toContainText("third");

    // Send now interrupts the sleeping turn and runs "third" next.
    await queued.first().getByTestId("harness-queued-send-now").click();
    await expect(queued).toHaveCount(0, { timeout: 30_000 });
    await expect(harness.getByTestId("harness-prompt").last()).toContainText(
      "third",
      { timeout: 30_000 }
    );
    const result = harness.getByTestId("harness-result").last();
    await expect(result).toContainText("You said:", { timeout: 30_000 });
    await expect(result).toContainText("third");
    // "second" never ran: no prompt line carries it.
    await expect(harness.getByTestId("harness-prompt")).toHaveCount(2);
    await expect(harness.getByTestId("harness-prompt").first()).toContainText(
      "first"
    );
  });
});
