import { test, expect, type Page } from "@playwright/test";
import { join } from "node:path";
import { authHeaders, cleanupE2EAgents, createAgentViaAPI } from "../helpers";
import {
  agentInfo,
  enrollViaUi,
  guest,
  guestOk,
  marker,
  runnerRow,
  state,
} from "./harness";

test.use({ actionTimeout: 10_000 });

test.afterAll(async ({ request }) => cleanupE2EAgents(request));

async function openTerminal(page: Page) {
  const tab = page.getByTestId("sidebar-tab-terminal");
  await expect(page.getByTestId("chat-pane")).toBeVisible();
  const box = await tab.boundingBox();
  if (!box || box.x >= page.viewportSize()!.width)
    await page.getByTestId("toggle-drawer").click();
  await tab.click();
  const panel = page.getByRole("region", { name: "Terminal", exact: true });
  await expect(panel.getByRole("status")).toHaveText("Connected");
  return panel;
}

for (const lane of ["native", "runner", "managed"] as const) {
  const remote = lane !== "native";
  const guestName = lane === "managed" ? "scratch" : "alpha";
  test(`${lane} terminal keeps its shell through a browser reconnect`, async ({
    browser,
    page,
    request,
  }, testInfo) => {
    const runner = remote
      ? ((await runnerRow(request, guestName))?.id ??
        (await enrollViaUi(page, request, guestName)))
      : null;
    const ideSettings = "/api/v1/app/settings/ides";
    const headers = authHeaders();
    const previousIdes = await (
      await request.get(ideSettings, { headers })
    ).json();
    const enabled = await request.post(ideSettings, {
      headers,
      data: { enabledIdes: ["vscode"] },
    });
    expect(enabled.ok()).toBe(true);
    const agent = await createAgentViaAPI(request, {
      name: `e2e-${lane}-terminal`,
      cwd: runner
        ? `runner://${runner}/${lane === "managed" ? "@session" : state.workspace}`
        : "/tmp",
    });
    const context = await browser.newContext({
      viewport: remote
        ? { width: 390, height: 844 }
        : { width: 1440, height: 900 },
      deviceScaleFactor: 2,
    });
    try {
      await expect
        .poll(async () => (await agentInfo(request, agent.id)).status, {
          timeout: 15_000,
        })
        .toBe("running");
      let target = state.runners.alpha.workspaceDir;
      let expectedMarker = lane === "runner" ? marker("alpha") : "";
      if (lane === "managed") {
        target = `/tmp/terminal-checkout-${agent.id}`;
        expectedMarker = `managed-marker-${agent.id}`;
        guest(
          guestName,
          `install -d -o 1500 -g 1500 '${target}' && printf '%s\n' '${expectedMarker}' >'${target}/marker.txt'`
        );
        const moved = await request.patch(
          `/api/v1/agents/${agent.id}/workspace`,
          {
            headers,
            data: { path: target },
          }
        );
        expect(moved.ok(), await moved.text()).toBe(true);
      }
      const session = await context.newPage();
      const screenshot = async (phase: string) => {
        const name = `terminal-${lane}-${phase}.png`;
        const evidence = process.env.RUNNER_TERMINAL_EVIDENCE;
        const path = evidence
          ? join(evidence, name)
          : testInfo.outputPath(name);
        await session.screenshot({ path });
        await testInfo.attach(name, { path, contentType: "image/png" });
      };
      let output = "";
      let resize: { cols: number; rows: number } | undefined;
      session.on("websocket", (socket) => {
        if (!socket.url().includes("/human-terminals/")) return;
        socket.on("framereceived", ({ payload }) => {
          if (Buffer.isBuffer(payload)) output += payload.toString("utf8");
        });
        socket.on("framesent", ({ payload }) => {
          if (typeof payload !== "string") return;
          const message = JSON.parse(payload);
          if (message.type === "resize") resize = message;
        });
      });

      await session.goto(`/agents/${agent.id}`, {
        waitUntil: "domcontentloaded",
      });
      const expand = session.getByTestId(`agent-expand-toggle-${agent.id}`);
      await expect(session.getByTestId("chat-pane")).toBeVisible();
      const openSidebar = session.getByTitle("Open sidebar", { exact: true });
      if (await openSidebar.isVisible()) await openSidebar.click();
      await expect(expand).toHaveAttribute("aria-expanded", "true");
      if (remote) {
        const action = session.getByRole("button", {
          name: "Open in IDE is unavailable for runner checkouts",
        });
        await expect(action).toBeDisabled();
        await action.scrollIntoViewIfNeeded();
        await expect(action).toBeInViewport({ ratio: 0.8 });
        await expect(session.locator('a[href^="vscode:"]')).toHaveCount(0);
        const stream = await request.post(`/api/v1/agents/${agent.id}/stream`, {
          headers,
          data: { type: "playwright", port: 9222 },
        });
        expect(stream.status()).toBe(409);
        expect((await stream.json()).error).toContain(
          "unavailable for runner sessions"
        );
      } else {
        const action = session.getByTestId("ide-launch-button");
        await action.scrollIntoViewIfNeeded();
        await expect(action).toBeInViewport({ ratio: 0.8 });
        await expect(action).toHaveAttribute(
          "href",
          /^vscode:\/\/file\/(private\/)?tmp$/
        );
      }
      await screenshot("ide");
      if (remote)
        await session
          .getByTestId("sidebar-shell")
          .getByTitle("Close sidebar")
          .click();

      let panel = await openTerminal(session);
      const open = await session.evaluate(
        (id) => sessionStorage.getItem(`dispatch:human-terminal:${id}`),
        agent.id
      );
      expect(open).toBeTruthy();
      await expect.poll(() => resize).toBeTruthy();
      const input = session.getByLabel("Host terminal").locator("textarea");
      const type = async (command: string) => {
        await input.pressSequentially(command);
        await input.press("Enter");
      };
      await type(
        remote
          ? `cat marker.txt; stty size; printf 'PTY_PID_%s\\n' $$; printf 'PTY_UID_%s\\n' "$(id -u)"`
          : "stty size; printf 'PTY_PID_%s\\n' $$"
      );
      if (remote) {
        await expect(panel.getByText(target, { exact: true })).toBeVisible();
        await expect.poll(() => output).toContain(expectedMarker);
        await expect.poll(() => output).toContain("PTY_UID_1500");
      }
      const initialSize = resize!;
      await expect
        .poll(() => output)
        .toContain(`${initialSize.rows} ${initialSize.cols}`);
      await expect.poll(() => /PTY_PID_(\d+)/.test(output)).toBe(true);
      const pid = /PTY_PID_(\d+)/.exec(output)![1];
      await screenshot("connected");

      output = "";
      await session.reload({ waitUntil: "domcontentloaded" });
      panel = await openTerminal(session);
      expect(
        await session.evaluate(
          (id) => sessionStorage.getItem(`dispatch:human-terminal:${id}`),
          agent.id
        )
      ).toBe(open);
      await expect.poll(() => output).toContain(`PTY_PID_${pid}`);
      await type("printf 'RESUMED_%s\\n' $$");
      await expect.poll(() => output).toContain(`RESUMED_${pid}`);
      await panel.getByRole("button", { name: "End terminal" }).click();
      await expect(
        panel.getByRole("button", { name: "New terminal" })
      ).toBeEnabled();
      if (remote) {
        await expect
          .poll(() => guestOk(guestName, `test -d /proc/${pid}`))
          .toBe(false);
      }
      await screenshot("ended");
    } finally {
      await context.close();
      await request.post(ideSettings, { headers, data: previousIdes });
    }
  });
}
