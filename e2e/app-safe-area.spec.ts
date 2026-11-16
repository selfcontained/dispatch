import { expect, test, type Locator } from "@playwright/test";
import { loadApp } from "./helpers";

// The browser owns the safe viewport. Nonzero env() values must not cause
// another inset around normal app flow. Chromium cannot prove native iOS
// status-bar rendering; keep that limitation separate from geometry checks.
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
  test(`app uses the browser viewport on ${device.name}`, async ({
    browser,
  }) => {
    const phone = device.name.startsWith("iPhone");
    const context = await browser.newContext({
      viewport: { width: device.width, height: device.height },
      ...(phone
        ? {
            userAgent:
              "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1",
          }
        : {}),
    });
    const page = await context.newPage();
    const insets = phone ? { top: 0, bottom: 0, left: 0, right: 0 } : device;
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
      expect(box!.y).toBeGreaterThanOrEqual(insets.top);
      expect(box!.x).toBeGreaterThanOrEqual(insets.left);
      expect(box!.y + box!.height).toBeLessThanOrEqual(
        device.height - insets.bottom
      );
      expect(box!.x + box!.width).toBeLessThanOrEqual(
        device.width - insets.right
      );
    };
    try {
      await loadApp(page);
      const viewport = page.locator('meta[name="viewport"]');
      if (phone)
        await expect(viewport).not.toHaveAttribute(
          "content",
          /viewport-fit=cover/
        );
      else
        await expect(viewport).toHaveAttribute("content", /viewport-fit=cover/);
      await expect(
        page.locator('meta[name="apple-mobile-web-app-status-bar-style"]')
      ).toHaveAttribute("content", phone ? "black" : "black-translucent");
      expect(
        await page.locator("#root").evaluate((root) => {
          const style = getComputedStyle(root);
          return [
            style.paddingTop,
            style.paddingRight,
            style.paddingBottom,
            style.paddingLeft,
          ];
        })
      ).toEqual(
        [insets.top, insets.right, insets.bottom, insets.left].map(
          (value) => `${value}px`
        )
      );
      // The top inset band #root pads around is covered by an opaque fixed
      // strip in the theme background, so iPadOS extends that color there
      // instead of drawing its soft edge blur over the headers and toasts.
      const strip = page.locator("#safe-area-top");
      const stripStyle = await strip.evaluate((el) => {
        const style = getComputedStyle(el);
        const probe = document.createElement("div");
        probe.style.color = "hsl(var(--background))";
        document.body.append(probe);
        const theme = getComputedStyle(probe).color;
        probe.remove();
        const box = el.getBoundingClientRect();
        return {
          position: style.position,
          background: style.backgroundColor,
          theme,
          box: [box.top, box.left, box.width, box.height],
        };
      });
      expect(stripStyle.position).toBe("fixed");
      expect(stripStyle.background).toBe(stripStyle.theme);
      // Zero height without a top inset; hidden on iPhone, where Safari
      // owns the safe viewport.
      expect(stripStyle.box).toEqual(
        phone ? [0, 0, 0, 0] : [0, 0, device.width, insets.top]
      );
      await page.getByTitle("Close sidebar", { exact: true }).first().click();
      const open = page.getByTitle("Open sidebar", { exact: true });
      await insideFrame(open);
      await insideFrame(page.getByTitle("Chat options", { exact: true }));
      const composer = page.getByTestId("chat-composer-input");
      await insideFrame(composer);
      // The collapsed empty composer should reach the bottom of the usable
      // viewport, with only its normal 8px pane + 8px composer spacing.
      if (device.width < 768) {
        const composerBox = await composer.boundingBox();
        expect(
          device.height - composerBox!.y - composerBox!.height
        ).toBeLessThanOrEqual(24);
      }
      const pane = await page.getByTestId("chat-pane").boundingBox();
      expect(
        device.height - insets.bottom - pane!.y - pane!.height
      ).toBeLessThanOrEqual(8);
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
      await context.close();
    }
  });
}
