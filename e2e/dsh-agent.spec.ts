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

  test("shows up as a type, streams into the Chat tab, and takes a chat message", async ({
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
    const pane = page.getByTestId("chat-pane");
    await expect(pane).toBeVisible();

    const input = pane.getByTestId("chat-composer-input");
    await input.fill("hello harness");
    await input.press("Enter");

    await expect(pane.getByTestId("chat-activity")).toContainText(
      "Read README.md",
      { timeout: 30_000 }
    );
    // The fake echoes its prompt, so the assistant post carries the text.
    const assistant = pane.getByTestId("chat-assistant");
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
