import { expect, test, type Locator } from "@playwright/test";
import { loadApp } from "./helpers";

// Chromium's real env() override catches layout underneath device chrome.
// Native installed Safari still needs a device smoke check.
for (const device of [
  {
    name: "iPhone portrait",
    width: 390,
    height: 844,
    top: 59,
    bottom: 34,
    left: 0,
    right: 0,
  },
  {
    name: "iPad portrait",
    width: 820,
    height: 1180,
    top: 24,
    bottom: 20,
    left: 0,
    right: 0,
  },
  {
    name: "iPhone landscape",
    width: 844,
    height: 390,
    top: 0,
    bottom: 21,
    left: 59,
    right: 59,
  },
  {
    name: "desktop",
    width: 1440,
    height: 900,
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
  },
]) {
  test(`app navigation stays in the safe frame on ${device.name}`, async ({
    page,
  }) => {
    await page.setViewportSize(device);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setSafeAreaInsetsOverride", {
      insets: {
        top: device.top,
        bottom: device.bottom,
        left: device.left,
        right: device.right,
      },
    });
    const insideFrame = async (control: Locator) => {
      await expect(control).toBeVisible();
      const box = await control.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.y).toBeGreaterThanOrEqual(device.top);
      expect(box!.x).toBeGreaterThanOrEqual(device.left);
      expect(box!.y + box!.height).toBeLessThanOrEqual(
        device.height - device.bottom
      );
      expect(box!.x + box!.width).toBeLessThanOrEqual(
        device.width - device.right
      );
    };
    try {
      await loadApp(page);
      await page.getByTitle("Close sidebar", { exact: true }).first().click();
      const open = page.getByTitle("Open sidebar", { exact: true });
      await insideFrame(open);
      await insideFrame(page.getByTitle("Chat options", { exact: true }));
      const composer = page.getByTestId("chat-composer-input");
      await insideFrame(composer);
      await open.click();
      await page.getByTestId("settings-button").click();
      await expect(page).toHaveURL(/\/settings/);
      // Navigation remains reachable after leaving chat, including after reload.
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(
        page.getByRole("textbox", { name: "Instance name", exact: true })
      ).toBeVisible();
      const close = page.getByTitle("Close sidebar", { exact: true }).first();
      if (device.width >= 768) await close.click();
      await insideFrame(open);
      await open.click();
      await page.getByTestId("agents-button").click();
      await expect(page).toHaveURL(/\/agents/);
    } finally {
      await cdp.detach();
    }
  });
}
