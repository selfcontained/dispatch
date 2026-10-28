import { test, expect } from "@playwright/test";
import { loadApp } from "./helpers";
test.use({ deviceScaleFactor: 2 });
for (const viewport of [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test(`engine updates show success, failure and manual installs (${viewport.name})`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    let version = "1.0.0";
    const engines = () => [
      {
        id: "codex",
        label: "Codex",
        installed: true,
        path: "/home/user/npm/bin/codex",
        version,
        install: "npm i -g @openai/codex",
        update: {
          realPath:
            "/home/user/npm/lib/node_modules/@openai/codex/bin/codex.js",
          source: "npm",
          canUpdate: true,
          reason: "Verified user-owned installation.",
          command:
            "npm install --global --prefix /home/user/npm @openai/codex@latest",
          latestVersion: "2.0.0",
          latestPending: false,
          available: version === "1.0.0",
        },
      },
      {
        id: "claude",
        label: "Claude Code",
        installed: true,
        path: "/usr/local/bin/claude",
        version: "2.0.0",
        install: "npm i -g @anthropic-ai/claude-code",
        update: {
          source: "unknown",
          canUpdate: false,
          reason: "Manual update required.",
          command: "claude update",
          latestVersion: null,
          latestPending: false,
        },
      },
      {
        id: "opencode",
        label: "OpenCode",
        installed: false,
        path: null,
        version: null,
        install: "npm i -g opencode-ai",
      },
    ];
    await page.route("**/api/v1/system/engines", (route) =>
      route.fulfill({ json: { engines: engines(), canManage: true } })
    );
    let fail = false;
    let releaseUpdate: (() => void) | undefined;
    await page.route("**/api/v1/system/engines/codex/update", async (route) => {
      expect(route.request().method()).toBe("POST");
      if (!fail) {
        await new Promise<void>((resolve) => {
          releaseUpdate = resolve;
        });
        version = "2.0.0";
      }
      await route.fulfill({
        json: {
          success: !fail,
          output: fail
            ? "Permission denied by package manager"
            : "Installed selected CLI",
          engine: engines()[0],
        },
      });
    });
    await loadApp(page);
    await page.goto("/settings/updates", { waitUntil: "domcontentloaded" });
    const codex = page.getByRole("region", { name: "Codex", exact: true });
    await expect(
      codex.getByText("Update available: 1.0.0 → 2.0.0")
    ).toBeVisible();
    await expect(
      codex.getByText("/home/user/npm/bin/codex", { exact: true })
    ).toBeVisible();
    await codex
      .getByRole("button", { name: "Update Codex", exact: true })
      .click();
    await expect(
      codex.getByRole("button", { name: "Updating…", exact: true })
    ).toBeDisabled();
    await expect.poll(() => releaseUpdate !== undefined).toBe(true);
    releaseUpdate!();
    await expect(codex.getByRole("status")).toContainText(
      "Update completed · Installed: 2.0.0"
    );
    await expect(codex.getByRole("status")).toContainText(
      "Installed selected CLI"
    );
    await codex.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `/tmp/engine-updates-${viewport.name}-success.png`,
      fullPage: true,
    });
    fail = true;
    await codex
      .getByRole("button", { name: "Update Codex", exact: true })
      .click();
    await expect(codex.getByRole("status")).toContainText("Update failed");
    await expect(codex.getByRole("status")).toContainText(
      "Permission denied by package manager"
    );
    const manual = page.getByRole("region", {
      name: "Claude Code",
      exact: true,
    });
    await expect(
      manual.getByRole("button", { name: "Update Claude Code" })
    ).toHaveCount(0);
    await expect(
      manual.getByText("claude update", { exact: true })
    ).toBeVisible();
    const missing = page.getByRole("region", { name: "OpenCode", exact: true });
    await expect(missing).toContainText("Not installed");
    await expect(
      missing.getByRole("button", { name: "Copy command" })
    ).toBeVisible();
    await missing.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `/tmp/engine-updates-${viewport.name}.png`,
      fullPage: true,
    });
  });
}
