import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authHeaders, cleanupE2EAgents, trackAgent } from "../helpers";
import {
  agentInfo,
  enrollViaUi,
  guest,
  guestOk,
  marker,
  runnerRow,
  repositoryProject,
  state,
} from "./harness";

test.use({
  actionTimeout: 10_000,
  launchOptions: { args: ["--disable-external-intent-requests"] },
});

test.afterAll(async ({ request }) => cleanupE2EAgents(request));

async function openTerminal(page: Page) {
  const tab = page.getByTestId("sidebar-tab-terminal");
  await expect(page.getByTestId("chat-pane")).toBeVisible();
  const box = await tab.boundingBox();
  if (!box || box.x >= page.viewportSize()!.width)
    await page.getByTestId("toggle-drawer").click();
  await tab.click();
  const panel = page.getByRole("region", { name: "Terminal", exact: true });
  // Runner opens can wait for checkout resolution and a worker acknowledgement.
  await expect(
    panel.getByRole("status").filter({ hasText: /^Connected$/ })
  ).toHaveText("Connected", {
    timeout: 25_000,
  });
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
    const projectId =
      lane === "managed"
        ? await repositoryProject(request, guestName)
        : undefined;
    const created = await request.post("/api/v1/agents", {
      headers,
      data: {
        name: `e2e-${lane}-terminal`,
        type: "codex",
        useWorktree: false,
        projectId,
        cwd: runner
          ? `runner://${runner}/${lane === "managed" ? "@session" : state.workspace}`
          : "/tmp",
      },
    });
    expect(created.ok(), await created.text()).toBe(true);
    const { agent } = await created.json();
    trackAgent(agent.id);
    const context = await browser.newContext({
      viewport: remote
        ? { width: 390, height: 844 }
        : { width: 1440, height: 900 },
      deviceScaleFactor: 2,
    });
    let nativeFixture: string | undefined;
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
      } else if (lane === "native") {
        nativeFixture = await mkdtemp(
          join(tmpdir(), "dispatch-native-terminal-")
        );
        target = await realpath(nativeFixture);
        expectedMarker = `native-marker-${agent.id}`;
        await writeFile(join(target, "marker.txt"), expectedMarker + "\n");
      }
      if (lane !== "runner") {
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
      let submitted = "";
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
          if (message.type === "input") submitted += message.data;
        });
      });

      await session.goto(`/agents/${agent.id}`, {
        waitUntil: "domcontentloaded",
      });
      const expand = session.getByTestId(`agent-expand-toggle-${agent.id}`);
      await expect(session.getByTestId("chat-pane")).toBeVisible();
      const openSidebar = session.getByRole("button", {
        name: "Open sidebar",
        exact: true,
      });
      if (await openSidebar.isVisible()) await openSidebar.click();
      await expect(expand).toHaveAttribute("aria-expanded", "true");
      await session.getByTestId(`agent-more-${agent.id}`).click();
      const action = session.getByTestId("agent-action-ide-vscode");
      await action.scrollIntoViewIfNeeded();
      await expect(action).toBeInViewport({ ratio: 0.8 });
      // Main's menu performs navigation rather than rendering an anchor.
      const cdp = await session.context().newCDPSession(session);
      await cdp.send("Page.enable");
      let ideUrl: string | undefined;
      cdp.on("Page.frameRequestedNavigation", ({ url }) => {
        if (url.startsWith("vscode:")) ideUrl = url;
      });
      await action.click();
      await expect.poll(() => ideUrl).toBe(`vscode://file${target}`);
      await cdp.detach();
      if (remote) {
        const stream = await request.post(`/api/v1/agents/${agent.id}/stream`, {
          headers,
          data: { type: "playwright", port: 9222 },
        });
        expect(stream.status()).toBe(409);
        expect((await stream.json()).error).toContain(
          "unavailable for runner sessions"
        );
      }
      await screenshot("ide");
      if (remote)
        await session
          .getByTestId("sidebar-shell")
          .getByRole("button", { name: "Close", exact: true })
          .click();

      let panel = await openTerminal(session);
      const open = await session.evaluate(
        (id) => sessionStorage.getItem(`dispatch:human-terminal:${id}`),
        agent.id
      );
      expect(open).toBeTruthy();
      await expect.poll(() => resize).toBeTruthy();
      const type = async (command: string) => {
        const from = submitted.length;
        if (remote) {
          await session
            .getByRole("button", { name: "Open text input" })
            .click();
          await session
            .getByRole("textbox", { name: "Terminal input text" })
            .fill(command);
          await session
            .getByRole("button", { name: "Submit", exact: true })
            .click();
        } else {
          const input = session.getByLabel("Host terminal").locator("textarea");
          await input.pressSequentially(command);
          await input.press("Enter");
        }
        await expect.poll(() => submitted.slice(from)).toContain(command);
      };
      await type(
        remote
          ? `cat marker.txt; stty size; printf 'PTY_PID_%s\\n' $$; printf 'PTY_UID_%s\\n' "$(id -u)"`
          : "cat marker.txt; stty size; printf 'PTY_PID_%s\\n' $$"
      );
      await expect(panel.getByText(target, { exact: true })).toBeVisible();
      await expect.poll(() => output).toContain(expectedMarker);
      if (remote) await expect.poll(() => output).toContain("PTY_UID_1500");
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
      if (nativeFixture)
        await rm(nativeFixture, { recursive: true, force: true });
      await request.post(ideSettings, { headers, data: previousIdes });
      if (projectId)
        await request.delete(`/api/v1/projects/${projectId}`, { headers });
    }
  });
}
