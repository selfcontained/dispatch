import { expect, test, type Locator } from "@playwright/test";
import {
  cleanupE2EAgents,
  createAgentViaAPI,
  loadApp,
  seedBlockViaDB,
} from "./helpers";

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
      // Empty mobile views keep the global header available, with navigation closed.
      if (device.width >= 768)
        await page.getByTitle("Close sidebar", { exact: true }).first().click();
      await insideFrame(
        page.getByRole("button", { name: "Notifications", exact: true })
      );
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

// Viewport-fixed drawers sit outside #root's padding, so each reserves the
// top inset itself. An installed iPad app can also draw its status bar over
// the page while reporting a 0px env() inset; there the app falls back to
// the 24px status bar (--safe-area-top in index.css).
for (const scenario of [
  { name: "reported 24px inset", reported: 24, installed: false },
  { name: "installed app reporting 0px", reported: 0, installed: true },
]) {
  test(`iPad drawers start below the status bar: ${scenario.name}`, async ({
    browser,
    request,
  }) => {
    const inset = 24;
    const width = 1180;
    const height = 820;
    const context = await browser.newContext({
      viewport: { width, height },
      ...(scenario.installed
        ? {
            userAgent:
              "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
          }
        : {}),
    });
    if (scenario.installed)
      await context.addInitScript(() =>
        Object.defineProperty(Navigator.prototype, "standalone", {
          configurable: true,
          get: () => true,
        })
      );
    const page = await context.newPage();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setSafeAreaInsetsOverride", {
      insets: { top: scenario.reported, bottom: 0, left: 0, right: 0 },
    });
    const belowInset = async (control: Locator) => {
      await expect(control).toBeVisible();
      const box = await control.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.y).toBeGreaterThanOrEqual(inset);
    };
    try {
      const agent = await createAgentViaAPI(request);
      const root = await seedBlockViaDB({
        streamId: agent.id,
        authorKind: "user",
        text: "Safe-area thread",
      });
      await page.goto(`/agents/${agent.id}?thread=${root}`, {
        waitUntil: "domcontentloaded",
      });
      expect(
        await page
          .locator("#safe-area-top")
          .evaluate((el) => el.getBoundingClientRect().height)
      ).toBe(inset);
      const drawer = page.getByTestId("thread-drawer");
      await expect(drawer).toBeVisible();
      await belowInset(drawer.getByTestId("drawer-title"));
      await belowInset(drawer.getByTestId("drawer-close"));
      await drawer.getByTestId("drawer-close").click();
      await expect(drawer).toHaveCount(0);

      await page
        .getByRole("button", { name: "Notifications", exact: true })
        .click();
      const sheet = page.getByRole("dialog");
      await expect(sheet).toBeVisible();
      await belowInset(sheet.getByRole("heading").first());
      await belowInset(sheet.getByRole("button", { name: "Close" }));
    } finally {
      await cdp.detach();
      await context.close();
      await cleanupE2EAgents(request);
    }
  });
}

// The 24px status-bar fallback applies only to an installed iPad app; every
// other browser keeps exactly the reported env() inset (0 here).
for (const client of [
  { name: "desktop", ua: undefined, standalone: false, expected: 0 },
  {
    name: "installed iPhone",
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
    standalone: true,
    expected: 0,
  },
  {
    name: "Android",
    ua: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
    standalone: false,
    expected: 0,
  },
  {
    name: "iPad Safari tab",
    ua: "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    standalone: false,
    expected: 0,
  },
  {
    name: "installed iPad",
    ua: "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
    standalone: true,
    expected: 24,
  },
]) {
  test(`status-bar fallback on ${client.name} is ${client.expected}px`, async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: 1024, height: 768 },
      ...(client.ua ? { userAgent: client.ua } : {}),
    });
    if (client.standalone)
      await context.addInitScript(() =>
        Object.defineProperty(Navigator.prototype, "standalone", {
          configurable: true,
          get: () => true,
        })
      );
    const page = await context.newPage();
    try {
      await loadApp(page);
      const probe = () =>
        page.evaluate(() => {
          const el = document.createElement("div");
          el.style.cssText =
            "position:fixed;top:0;padding-top:var(--safe-area-top)";
          document.body.append(el);
          const top = parseFloat(getComputedStyle(el).paddingTop);
          el.remove();
          return top;
        });
      expect(await probe()).toBe(client.expected);
      // Same in either orientation.
      await page.setViewportSize({ width: 768, height: 1024 });
      expect(await probe()).toBe(client.expected);
    } finally {
      await context.close();
    }
  });
}
