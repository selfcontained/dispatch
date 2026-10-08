import { test, expect } from "@playwright/test";
import { loadApp } from "./helpers";

test.use({ deviceScaleFactor: 2 });

for (const viewport of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test(`update waits visibly and reloads without an SSE disconnect (${viewport.name})`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    // Only replace the update stream. Leave the app's other live connections
    // intact, and deliberately never send an error on this connection.
    await page.addInitScript(() => {
      const NativeEventSource = window.EventSource;
      window.EventSource = class extends NativeEventSource {
        constructor(url: string | URL, options?: EventSourceInit) {
          if (!String(url).includes("/release/update/stream")) {
            super(url, options);
            return;
          }
          // A data URL cannot open a real SSE connection; suppress its error
          // so restart completion must come from the phase-driven status poll.
          super("data:text/event-stream,", options);
          this.addEventListener("error", (event) =>
            event.stopImmediatePropagation()
          );
          const send = (event: Event) => {
            this.onmessage?.call(
              this,
              new MessageEvent("message", {
                data: JSON.stringify((event as CustomEvent).detail),
              })
            );
          };
          window.addEventListener("test-release-event", send);
          this.close = () => {
            window.removeEventListener("test-release-event", send);
            NativeEventSource.prototype.close.call(this);
          };
          setTimeout(
            () =>
              send(
                new CustomEvent("test-release-event", {
                  detail: {
                    type: "snapshot",
                    job: sessionStorage.getItem("update-complete")
                      ? null
                      : {
                          jobType: "update",
                          versionType: null,
                          phase: "deploying",
                          startedAt: new Date().toISOString(),
                          tag: "v9.9.9",
                          log: [
                            "downloaded 144.5M",
                            "Recovery helper will verify the backup and trial the update before commit.",
                          ],
                          runUrl: null,
                          error: null,
                          progress: {
                            step: "validating-artifact",
                            label: "Preparing protected update",
                            detail:
                              "Verifying the artifact and backup before activation.",
                          },
                        },
                  },
                })
              ),
            100
          );
        }
      };
    });
    let ready = false;
    let checks = 0;
    await page.route("**/api/v1/release/status", async (route) => {
      checks++;
      await route.fulfill({
        json: { tag: ready ? "v9.9.9" : "v9.9.8", deployedAt: "today" },
      });
    });
    if (viewport.name === "mobile") {
      await page.goto("/settings/general", { waitUntil: "domcontentloaded" });
      await page.getByTitle("Open sidebar").click();
      await page
        .getByRole("dialog", { name: "Navigation sidebar" })
        .getByText("Updates", { exact: true })
        .click();
    } else {
      await loadApp(page);
      await page.getByTestId("settings-button").click();
      await page
        .getByTestId("sidebar-shell")
        .getByText("Updates", { exact: true })
        .click();
    }
    await expect(page.getByText("Preparing protected update")).toBeVisible();
    const readLayout = async () => {
      const panel = page.getByTestId("release-operation-panel");
      const step = page.getByTestId("release-current-step");
      const status = page.getByTestId("release-operation-status");
      return {
        panel: await panel.boundingBox(),
        step: await step.boundingBox(),
        status: await status.boundingBox(),
        log: await page
          .getByText("downloaded 144.5M", { exact: true })
          .locator("..")
          .boundingBox(),
      };
    };
    const initialLayout = await readLayout();
    await page.screenshot({
      path: `/tmp/dispatch-update-${viewport.name}-preparing.png`,
      fullPage: true,
    });
    await page.evaluate(() => {
      for (let i = 0; i < 40; i++) {
        window.dispatchEvent(
          new CustomEvent("test-release-event", {
            detail: { type: "log", line: `==> Update progress message ${i}` },
          })
        );
      }
    });
    await page.evaluate(() =>
      window.dispatchEvent(
        new CustomEvent("test-release-event", {
          detail: { type: "phase", phase: "restarting" },
        })
      )
    );
    await expect(
      page.getByText("Restarting and verifying Dispatch")
    ).toBeVisible();
    await expect(
      page.getByText("Waiting for Dispatch to restart...")
    ).toBeVisible();
    await expect(
      page.getByText(/Checking for the updated server… [1-9]\d*s elapsed/)
    ).toBeVisible();
    expect(await readLayout()).toEqual(initialLayout);
    await page.screenshot({
      path: `/tmp/dispatch-update-${viewport.name}-waiting.png`,
      fullPage: true,
    });
    await expect.poll(() => checks).toBeGreaterThan(1);
    await expect(
      page.getByText("Server responding; waiting for updated version", {
        exact: true,
      })
    ).toBeVisible();
    await page.evaluate(() => sessionStorage.setItem("update-complete", "yes"));
    ready = true;
    await expect(page.getByText("Updated to", { exact: false })).toBeVisible();
    expect(await readLayout()).toEqual(initialLayout);
    await page.screenshot({
      path: `/tmp/dispatch-update-${viewport.name}-complete.png`,
      fullPage: true,
    });
    await page.waitForEvent("domcontentloaded");
    await expect(page.getByText("Current version")).toBeVisible();
    await expect(
      page.getByText("Restarting and verifying Dispatch")
    ).toHaveCount(0);
  });
}
