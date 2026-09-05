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

  test("opens on the Harness view, runs a turn there, and mirrors it in Chat", async ({
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

    // The same turn is in the Chat tab.
    await page.getByTestId("agent-view-chat").click();
    const pane = page.getByTestId("chat-pane");
    await expect(pane).toBeVisible();
    await expect(pane.getByTestId("chat-activity").last()).toContainText(
      "Read README.md",
      { timeout: 30_000 }
    );
    const assistant = pane.getByTestId("chat-assistant").last();
    await expect(assistant).toContainText("You said:", { timeout: 30_000 });
    await expect(assistant).toContainText("hello harness");

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
});
