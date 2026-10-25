import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { authHeaders, createAgentViaAPI } from "./helpers";

const TEST_PASSWORD = "mobile-terminal-e2e-password";

test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });

test("mobile terminal pastes exact text and sends shortcuts over its socket", async ({
  page,
  request,
}) => {
  const auth = await request.get("/api/v1/auth/status");
  if ((await auth.json()).passwordSet) {
    // The standalone API fixture also starts fresh on retry.
    const login = await request.post("/api/v1/auth/login", {
      data: { password: TEST_PASSWORD },
    });
    expect(login.ok()).toBe(true);
  }
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
    const login = page.getByTestId("login-password");
    const drawerToggle = page.getByTestId("toggle-drawer");
    // Retries get a fresh browser context but retain the server's password.
    // Wait for either authenticated UI or login before choosing the path.
    await Promise.race([login.waitFor(), drawerToggle.waitFor()]);
    if (await login.isVisible()) {
      await login.fill(TEST_PASSWORD);
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await expect(login).toBeHidden();
      await page.goto(`/agents/${agent.id}`, { waitUntil: "domcontentloaded" });
    }
    await drawerToggle.click();
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
      await panel.getByLabel("Password", { exact: true }).fill(TEST_PASSWORD);
      await panel.getByLabel("Confirm password").fill(TEST_PASSWORD);
      await panel
        .getByRole("button", { name: "Set password", exact: true })
        .click();
    }
    await expect(panel.getByRole("status")).toHaveText("Connected");
    await page.screenshot({
      path: join(screenshots, "mobile-terminal-toolbar.png"),
    });
    await panel.getByRole("button", { name: "Open text input" }).click();
    const textarea = page.getByRole("textbox", { name: "Terminal input text" });
    await expect(textarea).toBeFocused();
    const suffix = `submit-${Date.now()}`;
    const marker = `mobile-${suffix}`;
    const command = `printf 'mobile-%s\\n' '${suffix}'`;
    // Use a real clipboard paste on loopback; it exercises native textarea paste
    // without adding any app-level clipboard interception.
    await page
      .context()
      .grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.evaluate((text) => navigator.clipboard.writeText(text), command);
    await textarea.press(
      process.platform === "darwin" ? "Meta+V" : "Control+V"
    );
    await expect(textarea).toHaveValue(command);
    await page.screenshot({
      path: join(screenshots, "mobile-terminal-composer.png"),
    });
    await page.getByRole("button", { name: "Submit", exact: true }).click();
    await expect.poll(() => inputs).toEqual([command + "\r"]);
    await expect(
      page.getByRole("dialog", { name: "Terminal input" })
    ).toBeHidden();
    await expect(panel.locator(".xterm-rows")).toContainText(marker);
    await panel
      .getByRole("button", { name: "Send Enter", exact: true })
      .click();
    await expect.poll(() => inputs).toEqual([command + "\r", "\r"]);
    await panel.getByRole("button", { name: "Open text input" }).click();
    await expect(textarea).toHaveValue("");
    await page.getByRole("button", { name: "Submit", exact: true }).click();
    await expect(
      page.getByRole("dialog", { name: "Terminal input" })
    ).toBeHidden();
    await expect.poll(() => inputs).toEqual([command + "\r", "\r"]);
    await page.screenshot({
      path: join(screenshots, "mobile-terminal-sent.png"),
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(
      panel.getByRole("button", { name: "Open text input" })
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
