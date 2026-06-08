import {
  test,
  expect,
  type Page,
  type APIRequestContext,
} from "@playwright/test";
import { execSync } from "child_process";
import { cleanupE2EAgents, loadApp } from "./helpers";

const AUTH_TOKEN = process.env.AUTH_TOKEN ?? "dev-token";
const IS_LIVE = process.env.DISPATCH_AGENT_RUNTIME === "tmux";

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${AUTH_TOKEN}` };
}

async function createAndStartAgent(
  request: APIRequestContext,
  name: string
): Promise<{ id: string; name: string; tmuxSession: string | null }> {
  const createRes = await request.post("/api/v1/agents", {
    headers: authHeaders(),
    data: { name, type: "terminal", cwd: "/tmp", useWorktree: false },
  });
  const { agent } = (await createRes.json()) as {
    agent: { id: string; name: string; tmuxSession: string | null };
  };

  await waitForAgentRunning(request, agent.id);

  const agentRes = await request.get(`/api/v1/agents/${agent.id}`, {
    headers: authHeaders(),
  });
  const agentBody = (await agentRes.json()) as {
    agent: { id: string; name: string; tmuxSession: string | null };
  };

  return agentBody.agent;
}

async function waitForAgentRunning(
  request: APIRequestContext,
  agentId: string,
  timeoutMs = 10_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pollRes = await request.get(`/api/v1/agents/${agentId}`, {
      headers: authHeaders(),
    });
    if (pollRes.ok()) {
      const pollBody = (await pollRes.json()) as {
        agent?: { status?: string };
      };
      if (pollBody.agent?.status === "running") {
        return;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function waitForTerminalConnected(
  page: Page,
  agentName: string,
  timeoutMs = 10_000
): Promise<void> {
  // A focused live session renders the current session name header and hides
  // the connected marker once the WebSocket is actually attached.
  await expect(page.getByTestId("current-session-name")).toHaveText(agentName, {
    timeout: timeoutMs,
  });
  await expect(page.getByTestId("terminal-connected-state")).toBeVisible({
    timeout: timeoutMs,
  });
}

async function waitForAgentCardRunning(
  page: Page,
  agentId: string,
  timeoutMs = 10_000
): Promise<void> {
  await expect(page.getByTestId(`agent-card-${agentId}`)).not.toHaveClass(
    /opacity-60/,
    {
      timeout: timeoutMs,
    }
  );
}

function resolveTmuxPaneTarget(sessionName: string): string {
  return execSync(
    `tmux display-message -p -t ${JSON.stringify(sessionName)} '#{pane_id}'`,
    {
      encoding: "utf8",
    }
  ).trim();
}

function readTmuxPaneInMode(sessionName: string): boolean {
  const paneTarget = resolveTmuxPaneTarget(sessionName);
  return (
    execSync(
      `tmux display-message -p -t ${JSON.stringify(paneTarget)} '#{pane_in_mode}'`,
      {
        encoding: "utf8",
      }
    ).trim() === "1"
  );
}

async function waitForTmuxCopyMode(
  sessionName: string,
  expected: boolean,
  timeoutMs = 5_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (readTmuxPaneInMode(sessionName) === expected) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  expect(readTmuxPaneInMode(sessionName)).toBe(expected);
}

async function simulateHidden(page: Page): Promise<void> {
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      value: "hidden",
      writable: true,
      configurable: true,
    });
    Object.defineProperty(document, "hidden", {
      value: true,
      writable: true,
      configurable: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

async function simulateVisibleWithFocus(page: Page): Promise<void> {
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      writable: true,
      configurable: true,
    });
    Object.defineProperty(document, "hidden", {
      value: false,
      writable: true,
      configurable: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
  });
}

test.describe("Terminal live connection", () => {
  test.skip(!IS_LIVE, "Requires --live agent runtime");

  test.afterEach(async ({ request }) => {
    await cleanupE2EAgents(request, "all");
  });

  test("connects to terminal within 3 seconds", async ({ page, request }) => {
    test.skip(!IS_LIVE, "Requires --live agent runtime");

    const agent = await createAndStartAgent(request, `e2e-agent-${Date.now()}`);
    await loadApp(page);

    const agentCard = page.getByTestId(`agent-card-${agent.id}`);
    await agentCard.waitFor({ state: "visible", timeout: 5_000 });
    await page.getByTestId(`agent-row-${agent.id}`).click();

    // Terminal should connect within 3 seconds
    await waitForTerminalConnected(page, agent.name, 3_000);
  });

  test("terminal stays connected during SSE agent events", async ({
    page,
    request,
  }) => {
    test.skip(!IS_LIVE, "Requires --live agent runtime");

    const agent = await createAndStartAgent(request, `e2e-agent-${Date.now()}`);
    await loadApp(page);

    // Attach to the agent's terminal
    const agentCard = page.getByTestId(`agent-card-${agent.id}`);
    await agentCard.waitFor({ state: "visible", timeout: 5_000 });
    await page.getByTestId(`agent-row-${agent.id}`).click();
    await waitForTerminalConnected(page, agent.name, 5_000);

    // Now create 3 agents rapidly to trigger SSE agent.upsert events
    for (let i = 0; i < 3; i++) {
      await request.post("/api/v1/agents", {
        headers: authHeaders(),
        data: {
          name: `e2e-agent-noise-${Date.now()}-${i}`,
          type: "terminal",
          cwd: "/tmp",
          useWorktree: false,
        },
      });
      // Small delay so events fire individually
      await page.waitForTimeout(200);
    }

    // After the SSE storm, terminal should still be connected (detach button visible)
    await page.waitForTimeout(500);
    await waitForTerminalConnected(page, agent.name, 5_000);
  });

  test("reconnects after agent restart", async ({ page, request }) => {
    test.skip(!IS_LIVE, "Requires --live agent runtime");

    const agent = await createAndStartAgent(request, `e2e-agent-${Date.now()}`);
    await loadApp(page);

    // Attach to terminal
    const agentCard = page.getByTestId(`agent-card-${agent.id}`);
    await agentCard.waitFor({ state: "visible", timeout: 5_000 });
    await page.getByTestId(`agent-row-${agent.id}`).click();
    await waitForTerminalConnected(page, agent.name, 5_000);

    // Stop the agent
    await request.post(`/api/v1/agents/${agent.id}/stop`, {
      headers: authHeaders(),
    });
    await page.waitForTimeout(1_000);

    // Restart it
    await request.post(`/api/v1/agents/${agent.id}/start`, {
      headers: authHeaders(),
    });

    await waitForAgentRunning(request, agent.id);
    await waitForAgentCardRunning(page, agent.id);
    await page.goto(`/agents/${agent.id}`, { waitUntil: "domcontentloaded" });

    // Should reconnect within a reasonable time
    await waitForTerminalConnected(page, agent.name, 5_000);
  });

  test("rapid agent switching stays stable", async ({ page, request }) => {
    test.skip(!IS_LIVE, "Requires --live agent runtime");

    const agentA = await createAndStartAgent(
      request,
      `e2e-agent-A-${Date.now()}`
    );
    const agentB = await createAndStartAgent(
      request,
      `e2e-agent-B-${Date.now()}`
    );
    await loadApp(page);

    const cardA = page.getByTestId(`agent-card-${agentA.id}`);
    const cardB = page.getByTestId(`agent-card-${agentB.id}`);
    await cardA.waitFor({ state: "visible", timeout: 5_000 });
    await cardB.waitFor({ state: "visible", timeout: 5_000 });

    // Switch back and forth 5 times
    for (let i = 0; i < 5; i++) {
      const targetAgentId = i % 2 === 0 ? agentA.id : agentB.id;
      await page.getByTestId(`agent-row-${targetAgentId}`).click();
      await page.waitForTimeout(300);
    }

    // Finish with an explicit attach to the final target after the burst.
    await page.getByTestId(`agent-row-${agentB.id}`).click();
    await waitForTerminalConnected(page, agentB.name, 5_000);
  });

  test("healthy resume does not fetch a duplicate terminal token", async ({
    page,
    request,
  }) => {
    test.skip(!IS_LIVE, "Requires --live agent runtime");

    const agent = await createAndStartAgent(request, `e2e-agent-${Date.now()}`);
    let tokenRequests = 0;
    page.on("request", (req) => {
      if (
        req.method() === "POST" &&
        req.url().includes(`/api/v1/agents/${agent.id}/terminal/token`)
      ) {
        tokenRequests += 1;
      }
    });

    await loadApp(page);

    const agentCard = page.getByTestId(`agent-card-${agent.id}`);
    await agentCard.waitFor({ state: "visible", timeout: 5_000 });
    await page.getByTestId(`agent-row-${agent.id}`).click();
    await waitForTerminalConnected(page, agent.name, 5_000);
    await expect.poll(() => tokenRequests).toBeGreaterThan(0);
    const initialTokenRequests = tokenRequests;

    await simulateHidden(page);
    await page.waitForTimeout(100);
    await simulateVisibleWithFocus(page);
    await page.waitForTimeout(500);

    await waitForTerminalConnected(page, agent.name, 5_000);
    await expect.poll(() => tokenRequests).toBe(initialTokenRequests);
  });

  test("re-focuses terminal when window is foregrounded", async ({
    page,
    request,
  }) => {
    test.skip(!IS_LIVE, "Requires --live agent runtime");

    const agent = await createAndStartAgent(request, `e2e-agent-${Date.now()}`);
    await loadApp(page);

    const agentCard = page.getByTestId(`agent-card-${agent.id}`);
    await agentCard.waitFor({ state: "visible", timeout: 5_000 });
    await page.getByTestId(`agent-row-${agent.id}`).click();
    await waitForTerminalConnected(page, agent.name, 5_000);
    await expect(page.locator(".xterm-helper-textarea")).toBeFocused();

    // Move focus away from the terminal, mimicking what the browser often
    // does when the app loses focus and is later re-foregrounded.
    await page.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur?.();
      document.body.focus();
    });
    await expect(page.locator(".xterm-helper-textarea")).not.toBeFocused();

    await simulateVisibleWithFocus(page);

    await expect(page.locator(".xterm-helper-textarea")).toBeFocused({
      timeout: 1_000,
    });
  });

  test("focuses terminal input with the global shortcut", async ({
    page,
    request,
  }) => {
    test.skip(!IS_LIVE, "Requires --live agent runtime");

    const agent = await createAndStartAgent(request, `e2e-agent-${Date.now()}`);
    await loadApp(page);

    const agentCard = page.getByTestId(`agent-card-${agent.id}`);
    await agentCard.waitFor({ state: "visible", timeout: 5_000 });
    await page.getByTestId(`agent-row-${agent.id}`).click();
    await waitForTerminalConnected(page, agent.name, 5_000);

    const pinsButton = page.getByRole("button", { name: "Pins" });
    await pinsButton.focus();
    await expect(pinsButton).toBeFocused();

    await page.keyboard.press("Meta+Shift+Space");

    await expect(page.locator(".xterm-helper-textarea")).toBeFocused({
      timeout: 1_000,
    });
  });

  test("does not steal focus from another input on foreground", async ({
    page,
    request,
  }) => {
    test.skip(!IS_LIVE, "Requires --live agent runtime");

    const agent = await createAndStartAgent(request, `e2e-agent-${Date.now()}`);
    await loadApp(page);

    const agentCard = page.getByTestId(`agent-card-${agent.id}`);
    await agentCard.waitFor({ state: "visible", timeout: 5_000 });
    await page.getByTestId(`agent-row-${agent.id}`).click();
    await waitForTerminalConnected(page, agent.name, 5_000);

    // Plant a focused text input outside the terminal host.
    await page.evaluate(() => {
      const input = document.createElement("input");
      input.id = "e2e-decoy-input";
      input.type = "text";
      document.body.appendChild(input);
      input.focus();
    });
    await expect(page.locator("#e2e-decoy-input")).toBeFocused();

    await simulateVisibleWithFocus(page);
    await page.waitForTimeout(150);

    await expect(page.locator("#e2e-decoy-input")).toBeFocused();
    await expect(page.locator(".xterm-helper-textarea")).not.toBeFocused();
  });

  test("does not steal focus from a portal-backed dialog input on foreground", async ({
    page,
    request,
  }) => {
    test.skip(!IS_LIVE, "Requires --live agent runtime");

    const agent = await createAndStartAgent(request, `e2e-agent-${Date.now()}`);
    await loadApp(page);

    const agentCard = page.getByTestId(`agent-card-${agent.id}`);
    await agentCard.waitFor({ state: "visible", timeout: 5_000 });
    await page.getByTestId(`agent-row-${agent.id}`).click();
    await waitForTerminalConnected(page, agent.name, 5_000);

    // Open the real create-agent dialog (portal-backed via Radix). This
    // exercises the same focus-trap structure a user would hit if Cmd-Tab
    // happened with a dialog open, instead of a decoy input on body.
    await page.getByTestId("create-agent-button").click();
    const nameInput = page.getByTestId("create-agent-name");
    await expect(nameInput).toBeVisible();
    await nameInput.focus();
    await expect(nameInput).toBeFocused();

    await simulateVisibleWithFocus(page);
    await page.waitForTimeout(150);

    await expect(nameInput).toBeFocused();
    await expect(page.locator(".xterm-helper-textarea")).not.toBeFocused();
  });

  test("shows a copy-mode banner and returns to live immediately", async ({
    page,
    request,
  }) => {
    test.skip(!IS_LIVE, "Requires --live agent runtime");

    const agent = await createAndStartAgent(request, `e2e-agent-${Date.now()}`);
    expect(agent.tmuxSession).toBeTruthy();
    const tmuxSession = agent.tmuxSession!;

    await page.addInitScript(() => {
      const sentInput: string[] = [];
      (
        window as typeof window & { __sentTerminalInput?: string[] }
      ).__sentTerminalInput = sentInput;
      const originalSend = WebSocket.prototype.send;
      WebSocket.prototype.send = function patchedSend(
        data: string | ArrayBufferLike | Blob | ArrayBufferView
      ) {
        if (typeof data === "string") {
          try {
            const payload = JSON.parse(data) as {
              type?: string;
              data?: string;
            };
            if (payload.type === "input" && typeof payload.data === "string") {
              sentInput.push(payload.data);
            }
          } catch {
            // ignore non-JSON websocket frames
          }
        }
        return originalSend.call(this, data);
      };
    });

    await loadApp(page);

    const agentCard = page.getByTestId(`agent-card-${agent.id}`);
    await agentCard.waitFor({ state: "visible", timeout: 5_000 });
    await page.getByTestId(`agent-row-${agent.id}`).click();
    await waitForTerminalConnected(page, agent.name, 5_000);

    execSync(
      `tmux copy-mode -t ${JSON.stringify(resolveTmuxPaneTarget(tmuxSession))}`
    );

    const banner = page.getByTestId("terminal-copy-mode-banner");
    await expect(banner).toBeVisible({ timeout: 2_000 });
    await expect(banner).toContainText("Input paused");
    await waitForTmuxCopyMode(tmuxSession, true);

    let releaseExitRoute: (() => void) | null = null;
    await page.route(
      `**/api/v1/agents/${agent.id}/terminal/copy-mode/exit`,
      async (route) => {
        await new Promise<void>((resolve) => {
          releaseExitRoute = resolve;
        });
        await route.continue();
      }
    );

    const clickStartedAt = Date.now();
    await banner.click();
    await expect(banner).toContainText("Returning to live…", {
      timeout: 300,
    });
    expect(Date.now() - clickStartedAt).toBeLessThan(250);
    await page.keyboard.type("xyz");
    await page.waitForTimeout(150);
    expect(releaseExitRoute).not.toBeNull();
    releaseExitRoute?.();
    await waitForTmuxCopyMode(tmuxSession, false);
    await expect(banner).toBeHidden({ timeout: 1_000 });
    await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
    await page.unroute(`**/api/v1/agents/${agent.id}/terminal/copy-mode/exit`);

    execSync(
      `tmux copy-mode -t ${JSON.stringify(resolveTmuxPaneTarget(tmuxSession))}`
    );
    await expect(banner).toBeVisible({ timeout: 2_000 });
    await waitForTmuxCopyMode(tmuxSession, true);

    await page.locator(".xterm-screen").click();
    await page.keyboard.press("Escape");
    await expect(banner).toBeHidden({ timeout: 1_000 });
    await waitForTmuxCopyMode(tmuxSession, false);
  });

  test("terminal-features not duplicated across attaches", async ({
    request,
  }) => {
    test.skip(!IS_LIVE, "Requires --live agent runtime");

    const agent = await createAndStartAgent(request, `e2e-agent-${Date.now()}`);

    const countSyncEntries = () =>
      execSync("tmux show-options -s terminal-features", {
        encoding: "utf-8",
      })
        .split("\n")
        .filter((line) => line.includes("xterm-256color:sync")).length;

    const beforeCount = countSyncEntries();

    // Request terminal tokens multiple times without attaching.
    for (let i = 0; i < 5; i++) {
      const res = await request.post(
        `/api/v1/agents/${agent.id}/terminal/token`,
        {
          headers: authHeaders(),
        }
      );
      expect(res.ok()).toBe(true);
    }

    expect(countSyncEntries()).toBe(beforeCount);
  });
});
