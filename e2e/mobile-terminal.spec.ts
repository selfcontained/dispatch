import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { authHeaders, createAgentViaAPI } from "./helpers";

test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });

test("mobile terminal pastes exact text and sends shortcuts over its socket", async ({
  page,
  request,
}) => {
  const agent = await createAgentViaAPI(request, { cwd: "/tmp" });
  const inputs: string[] = [];
  const screenshots =
    process.env.DISPATCH_FILES_DIR ?? "/tmp/dispatch-mobile-terminal";
  mkdirSync(screenshots, { recursive: true });
  page.on("websocket", (socket) => {
    if (!socket.url().includes("/human-terminals/")) return;
    socket.on("framesent", ({ payload }) => {
      if (typeof payload !== "string") return;
      const message = JSON.parse(payload);
      if (message.type === "input") inputs.push(message.data);
    });
  });
  try {
    await page.goto(`/agents/${agent.id}`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("toggle-drawer").click();
    await page.getByTestId("sidebar-tab-terminal").click();
    const panel = page.getByRole("region", { name: "Terminal", exact: true });
    // Production-like isolated E2E requires password setup; dev previews permit
    // an isolated per-browser terminal owner without changing global auth.
    const status = await Promise.race([
      panel
        .getByRole("button", { name: "Set password", exact: true })
        .waitFor()
        .then(() => "setup"),
      panel
        .getByRole("status")
        .filter({ hasText: /^Connected$/ })
        .waitFor()
        .then(() => "ready"),
    ]);
    if (status === "setup") {
      await panel
        .getByLabel("Password", { exact: true })
        .fill("mobile-terminal-e2e-password");
      await panel
        .getByLabel("Confirm password")
        .fill("mobile-terminal-e2e-password");
      await panel
        .getByRole("button", { name: "Set password", exact: true })
        .click();
    }
    await expect(panel.getByRole("status")).toHaveText("Connected");
    await page.screenshot({
      path: join(screenshots, "mobile-terminal-toolbar.png"),
    });
    await panel.getByRole("button", { name: "Paste / type" }).click();
    const textarea = page.getByRole("textbox", { name: "Terminal input text" });
    await expect(textarea).toBeFocused();
    const raw = `printf 'mobile-raw-marker'`;
    // Use a real clipboard paste on loopback; it exercises native textarea paste
    // without adding any app-level clipboard interception.
    await page
      .context()
      .grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.evaluate((text) => navigator.clipboard.writeText(text), raw);
    await textarea.press(
      process.platform === "darwin" ? "Meta+V" : "Control+V"
    );
    await expect(textarea).toHaveValue(raw);
    await page.screenshot({
      path: join(screenshots, "mobile-terminal-composer.png"),
    });
    await page.getByRole("button", { name: "Send Raw", exact: true }).click();
    await expect.poll(() => inputs).toEqual([raw]);
    await expect(
      page.getByRole("dialog", { name: "Terminal input" })
    ).toBeHidden();
    await panel
      .getByRole("button", { name: "Send Enter", exact: true })
      .click();
    await expect.poll(() => inputs).toEqual([raw, "\r"]);
    await panel.getByRole("button", { name: "Paste / type" }).click();
    await expect(textarea).toHaveValue("");
    const command = "echo mobile-enter-marker";
    await textarea.fill(command);
    await page
      .getByRole("button", { name: "Send + Enter", exact: true })
      .click();
    await expect.poll(() => inputs).toEqual([raw, "\r", command + "\r"]);
    await page.screenshot({
      path: join(screenshots, "mobile-terminal-sent.png"),
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(
      panel.getByRole("button", { name: "Paste / type" })
    ).toBeHidden();
    // Crossing the breakpoint remounts the drawer shell; reopen its terminal.
    if (await page.getByTestId("toggle-drawer").isVisible())
      await page.getByTestId("toggle-drawer").click();
    await page.getByTestId("sidebar-tab-terminal").click();
    await expect(panel.getByRole("status")).toHaveText("Connected");
    await expect(panel.getByLabel("Host terminal")).toBeVisible();
    await page.screenshot({
      path: join(screenshots, "desktop-terminal-unchanged.png"),
    });
    await panel.getByRole("button", { name: "End terminal" }).click();
    await expect(panel.getByRole("status")).toHaveText("Ended");
  } finally {
    await request.delete(`/api/v1/agents/${agent.id}`, {
      headers: authHeaders(),
    });
    await page.context().close();
  }
});
