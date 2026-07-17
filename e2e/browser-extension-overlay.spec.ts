import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page } from "@playwright/test";

// The Safari feedback overlay is a plain content script, so it can be
// exercised headlessly: a fixture page, a stubbed extension messaging bridge
// on window.browser, and the built IIFE injected the way the background's
// scripting.executeScript would.

const overlayBundlePath = resolve(
  import.meta.dirname,
  "../apps/browser-extension/dist/safari/unpacked/feedback-overlay.js"
);

const fixtureHtml = `<!doctype html>
<html>
  <head><title>Overlay fixture</title></head>
  <body>
    <main id="app">
      <section id="hero">
        <h1 id="headline">Fixture page</h1>
        <div class="card" id="card">
          <button id="target-button" onclick="window.__clicks = (window.__clicks ?? 0) + 1">
            Click me
          </button>
        </div>
      </section>
    </main>
  </body>
</html>`;

test.use({ hasTouch: true });

test.beforeAll(() => {
  if (!existsSync(overlayBundlePath)) {
    execSync("pnpm --filter @dispatch/browser-extension build:safari", {
      cwd: resolve(import.meta.dirname, ".."),
      stdio: "inherit",
    });
  }
});

async function openFixture(page: Page): Promise<void> {
  await page.route("**/overlay-fixture", (route) =>
    route.fulfill({ contentType: "text/html", body: fixtureHtml })
  );
  await page.addInitScript(() => {
    const sent: unknown[] = [];
    const win = window as typeof window & {
      __sentMessages: unknown[];
      __failNextSubmission: boolean;
      browser: unknown;
    };
    win.__sentMessages = sent;
    win.__failNextSubmission = false;
    win.browser = {
      runtime: {
        sendMessage: (message: { type: string }) => {
          sent.push(message);
          switch (message.type) {
            case "overlay:init":
              return Promise.resolve({
                ok: true,
                data: {
                  connected: true,
                  baseUrl: "http://dispatch.test",
                  agents: [
                    { id: "agent-1", name: "fix-navbar", status: "running" },
                    {
                      id: "agent-2",
                      name: "refactor-auth",
                      status: "running",
                      repoName: "dispatch",
                    },
                  ],
                  selectedAgentId: "agent-2",
                },
              });
            case "submission:create":
              if (win.__failNextSubmission) {
                win.__failNextSubmission = false;
                return Promise.resolve({
                  ok: false,
                  error: "Dispatch is unreachable.",
                });
              }
              return Promise.resolve({
                ok: true,
                data: { status: "delivered" },
              });
            default:
              return Promise.resolve({ ok: true, data: {} });
          }
        },
      },
    };
  });
  await page.goto("/overlay-fixture");
}

async function injectOverlay(page: Page): Promise<void> {
  await page.addScriptTag({
    content: readFileSync(overlayBundlePath, "utf8"),
  });
}

function shadow(page: Page) {
  return page.locator("[data-dispatch-feedback-host]");
}

test.describe("Safari feedback overlay", () => {
  test("tap, refine, comment, and send with a stable retry id", async ({
    page,
  }) => {
    await openFixture(page);
    await injectOverlay(page);

    const host = shadow(page);
    await expect(host).toHaveCount(1);
    await expect(page.getByText("Tap an element to select it")).toBeVisible();

    // Aiming blocks page interaction: a tap selects instead of clicking.
    await page.locator("#target-button").tap();
    await expect(page.getByRole("button", { name: "Use ✓" })).toBeVisible();
    expect(
      await page.evaluate(() => (window as { __clicks?: number }).__clicks)
    ).toBeUndefined();

    const selector = host.locator(".toolbar-selector");
    await expect(selector).toContainText("#target-button");

    // Refine: up to the card, back down to the button.
    await page.getByRole("button", { name: "‹ Parent" }).click();
    await expect(selector).toContainText("#card");
    await page.getByRole("button", { name: "Child ›" }).click();
    await expect(selector).toContainText("#target-button");
    await page.getByRole("button", { name: "‹ Parent" }).click();

    // Confirm: the card appears with agents from overlay:init.
    await page.getByRole("button", { name: "Use ✓" }).click();
    const agentSelect = host.locator("select");
    await expect(agentSelect).toBeVisible();
    await expect(agentSelect).toHaveValue("agent-2");

    // The aiming block is released: page clicks work again.
    await page.locator("#target-button").click();
    expect(
      await page.evaluate(() => (window as { __clicks?: number }).__clicks)
    ).toBe(1);

    await host.locator("textarea").fill("Make this button purple");
    await page.evaluate(() => {
      (window as { __failNextSubmission?: boolean }).__failNextSubmission =
        true;
    });
    await page.getByRole("button", { name: "Send" }).click();
    await expect(host.locator(".card-error")).toContainText(
      "Dispatch is unreachable."
    );
    await page.getByRole("button", { name: "Send" }).click();
    await expect(host).toHaveCount(0);

    const messages = await page.evaluate(
      () => (window as { __sentMessages?: unknown[] }).__sentMessages ?? []
    );
    const submissions = messages.filter(
      (
        message
      ): message is {
        clientSubmissionId: string;
        selection: { element: { selector: string } };
      } => (message as { type?: string }).type === "submission:create"
    );
    expect(submissions).toHaveLength(2);
    expect(submissions[0].clientSubmissionId).toBe(
      submissions[1].clientSubmissionId
    );
    expect(submissions[0].selection.element.selector).toContain("#card");
    expect(
      messages.some(
        (message) =>
          (message as { type?: string; reason?: string }).type ===
            "overlay:closed" &&
          (message as { reason?: string }).reason === "submitted"
      )
    ).toBe(true);
    expect(
      await page.evaluate(() => typeof window.__dispatchElementPickerCleanup)
    ).toBe("undefined");
  });

  test("cancel tears the overlay down without submitting", async ({ page }) => {
    await openFixture(page);
    await injectOverlay(page);

    await page.locator("#headline").tap();
    await page.getByRole("button", { name: "Cancel selection" }).click();
    await expect(shadow(page)).toHaveCount(0);

    const messages = await page.evaluate(
      () => (window as { __sentMessages?: unknown[] }).__sentMessages ?? []
    );
    expect(
      messages.some(
        (message) =>
          (message as { type?: string; reason?: string }).type ===
            "overlay:closed" &&
          (message as { reason?: string }).reason === "cancelled"
      )
    ).toBe(true);
    expect(
      messages.some(
        (message) => (message as { type?: string }).type === "submission:create"
      )
    ).toBe(false);
  });

  test("re-injection replaces a previous overlay instance", async ({
    page,
  }) => {
    await openFixture(page);
    await injectOverlay(page);
    await injectOverlay(page);
    await expect(shadow(page)).toHaveCount(1);
  });
});
