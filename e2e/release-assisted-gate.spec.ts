import { test, expect } from "@playwright/test";
import { loadApp } from "./helpers";

const requiredInfoFixture = {
  currentTag: "v0.18.1",
  channel: "stable" as const,
  isAdmin: true,
  latestTag: "v0.19.0",
  updateAvailable: true,
  latestRelease: {
    tag: "v0.19.0",
    publishedAt: "2026-04-25T12:00:00Z",
    url: "https://github.com/selfcontained/dispatch/releases/tag/v0.19.0",
  },
  unreleasedCount: 0,
  commits: [],
  refMissing: false,
  assisted: {
    mode: "required",
    title: "Bun runtime migration",
    summary:
      "This release switches the runtime from Node to Bun and changes the systemd unit shape.",
    instructions:
      "1. Confirm the service stopped cleanly.\n2. Replace the runtime symlink.\n3. Restart and watch /api/v1/health.",
    requiredChecks: [
      "expected_runtime_artifact",
      "service_entrypoint",
      "service_restarted",
      "health_endpoint",
      "version_converged",
    ],
    rollbackGuidance:
      "If health does not return within 60s, restore the previous symlink and `launchctl kickstart -k`.",
    appliesFrom: "v0.18.0",
  },
  assistedRequired: true,
};

const recommendedInfoFixture = {
  ...requiredInfoFixture,
  assisted: {
    ...requiredInfoFixture.assisted,
    mode: "recommended",
    title: "Recommended assisted update",
  },
  assistedRequired: false,
};

test.describe("Release assisted-update gate", () => {
  test("renders the required-mode gate and hides the one-click button", async ({
    page,
  }) => {
    await page.route("**/api/v1/release/info", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(requiredInfoFixture),
      })
    );

    await loadApp(page);
    await page.getByTestId("settings-button").click();
    await page
      .locator("button", { hasText: /^Updates$/ })
      .first()
      .click();
    await page.getByText("Check for updates").click();

    // The required-mode gate must be visible…
    await expect(
      page.getByText("Assisted update required", { exact: true })
    ).toBeVisible();
    await expect(page.getByText("Bun runtime migration")).toBeVisible();
    await expect(
      page.getByText(/switches the runtime from Node to Bun/)
    ).toBeVisible();
    // …and the standard one-click "Update to vX.Y.Z" button must NOT be.
    await expect(
      page.getByRole("button", { name: /^Update to v0\.19\.0$/ })
    ).toHaveCount(0);
    // Required-checks list shows up.
    for (const check of [
      "expected_runtime_artifact",
      "service_entrypoint",
      "service_restarted",
      "health_endpoint",
      "version_converged",
    ]) {
      await expect(page.getByText(check)).toBeVisible();
    }

    const startButton = page.getByRole("button", {
      name: /Start assisted update to v0\.19\.0/,
    });
    await expect(startButton).toBeEnabled();
  });

  test("renders the recommended gate alongside the recommended copy", async ({
    page,
  }) => {
    await page.route("**/api/v1/release/info", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(recommendedInfoFixture),
      })
    );

    await loadApp(page);
    await page.getByTestId("settings-button").click();
    await page
      .locator("button", { hasText: /^Updates$/ })
      .first()
      .click();
    await page.getByText("Check for updates").click();

    await expect(
      page.getByText("Assisted update recommended", { exact: true })
    ).toBeVisible();
    // For recommended mode the gate is informational; it still hides the
    // standard one-click button by design (any release that publishes
    // metadata is opting into the assisted flow).
    await expect(
      page.getByRole("button", { name: /^Update to v0\.19\.0$/ })
    ).toHaveCount(0);
  });
});
