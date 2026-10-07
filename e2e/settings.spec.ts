import { test, expect } from "@playwright/test";
import {
  createAgentViaAPI,
  loadApp,
  setEnabledAgentTypesViaAPI,
} from "./helpers";

test.describe("Settings pane", () => {
  test.afterEach(async ({ request }) => {
    await setEnabledAgentTypesViaAPI(request, ["codex", "claude"]);
    await request.post("/api/v1/notifications/settings", {
      headers: {
        Authorization: `Bearer ${process.env.AUTH_TOKEN ?? "dev-token"}`,
      },
      data: {
        webNotifyEnabled: false,
        webNotifyEvents: ["done", "waiting_user", "blocked"],
      },
    });
    await request.post("/api/v1/system/resources/settings", {
      headers: {
        Authorization: `Bearer ${process.env.AUTH_TOKEN ?? "dev-token"}`,
      },
      data: { enabled: false },
    });
  });

  test("opens and closes the settings pane", async ({ page }) => {
    await loadApp(page);

    // Click the Settings button in the sidebar footer
    await page.getByTestId("settings-button").click();

    // Settings nav should appear in the sidebar with "General" nav item
    const sidebar = page.getByTestId("sidebar-shell");
    await expect(sidebar.getByText("Settings").first()).toBeVisible({
      timeout: 3_000,
    });
    await expect(page.getByTestId("stream-full-history")).toHaveCount(0);
    await expect(
      page.getByText("Always keep the whole history in the page")
    ).toHaveCount(0);
    const generalNav = sidebar.getByText("General");
    await expect(generalNav).toBeVisible();

    // Navigate back to agents to close settings
    await page.getByTestId("agents-button").click();

    // Settings nav should no longer be visible (back to agents view)
    await expect(generalNav).not.toBeVisible({ timeout: 3_000 });
  });

  test("groups workspace and security controls separately from agent behavior", async ({
    page,
  }) => {
    await loadApp(page);
    await page.getByTestId("settings-button").click();
    const nav = page.getByTestId("sidebar-shell").getByRole("navigation");
    await nav.getByRole("button", { name: "Agents", exact: true }).click();
    await expect(page.getByTestId("agent-type-toggle-claude")).toBeVisible();
    await expect(page.getByTestId("launch-guidance-trim-toggle")).toHaveCount(
      0
    );
    await expect(page.getByText("Worktree location")).toHaveCount(0);
    await nav.getByRole("button", { name: "Workspace", exact: true }).click();
    await expect(page).toHaveURL(/\/settings\/workspace$/);
    await expect(page.getByText("Worktree location")).toBeVisible();
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByText("Worktree location")).toBeVisible();
    await nav.getByRole("button", { name: "Security", exact: true }).click();
    await expect(page).toHaveURL(/\/settings\/security$/);
    await expect(
      page.getByRole("button", { name: "Set password", exact: true })
    ).toBeVisible();
  });

  test("shows version metadata in the Updates section", async ({ page }) => {
    await loadApp(page);

    await page.getByTestId("settings-button").click();
    await page
      .getByTestId("sidebar-shell")
      .getByText("Updates", { exact: true })
      .click();

    // Version info is displayed in the Updates section
    await expect(page.getByText("Current version")).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText("Release tag")).toBeVisible();
    await expect(page.getByText("Release channel")).toBeVisible();
  });

  test("reveals contextual browser extension setup and serves the package", async ({
    page,
    request,
  }) => {
    await loadApp(page);

    await page.getByTestId("settings-button").click();
    await page
      .getByTestId("sidebar-shell")
      .getByText("Connections", { exact: true })
      .click();

    await expect(page).toHaveURL(/\/settings\/connections$/);
    const download = page.getByRole("link", {
      name: "Download extension ZIP",
    });
    await expect(download).toHaveAttribute(
      "href",
      "/dispatch-browser-feedback.zip"
    );
    await expect(page.getByText("Finish setup in Chrome")).not.toBeVisible();

    await page.getByRole("button", { name: "Already downloaded?" }).click();
    await expect(page.getByText("Finish setup in Chrome")).toBeVisible();
    await expect(page.getByText("2. Load the folder")).toBeVisible();
    await expect(page.getByText("chrome://extensions")).toBeVisible();

    const packageResponse = await request.get("/dispatch-browser-feedback.zip");
    expect(packageResponse.ok()).toBe(true);
    expect((await packageResponse.body()).byteLength).toBeGreaterThan(10_000);
  });

  test("approves a browser extension pairing request", async ({
    page,
    request,
  }) => {
    const startResponse = await request.post(
      "/api/v1/auth/browser-extension/pairings",
      {
        data: { deviceName: "E2E Chrome" },
      }
    );
    expect(startResponse.ok()).toBe(true);
    const pairing = (await startResponse.json()) as {
      pairingId: string;
      pairingSecret: string;
      verificationPath: string;
    };

    await loadApp(page);
    await page.goto(pairing.verificationPath, {
      waitUntil: "domcontentloaded",
    });

    await expect(
      page.getByText("Chrome is requesting permission to connect")
    ).toBeVisible();
    await page.getByRole("button", { name: "Approve connection" }).click();
    await expect(page.getByText("Connection approved")).toBeVisible();

    const exchangeResponse = await request.post(
      `/api/v1/auth/browser-extension/pairings/${pairing.pairingId}/exchange`,
      {
        data: { pairingSecret: pairing.pairingSecret },
      }
    );
    expect(exchangeResponse.ok()).toBe(true);
    const exchange = (await exchangeResponse.json()) as {
      status: string;
      token?: string;
    };
    expect(exchange.status).toBe("approved");
    expect(exchange.token).toBeTruthy();
    await expect(page.getByText("Browser extension connected")).toBeVisible();
  });

  test("shows live service resources and expands subsystem details", async ({
    page,
  }) => {
    await loadApp(page);

    await page.getByTestId("settings-button").click();
    await page
      .getByTestId("sidebar-shell")
      .getByText("Resources", { exact: true })
      .click();

    const dashboard = page.getByTestId("service-resources-dashboard");
    await expect(dashboard).toBeVisible({ timeout: 10_000 });
    await expect(page).toHaveURL(/\/settings\/resources$/);
    const collectionToggle = dashboard.getByTestId(
      "resource-collection-toggle"
    );
    await expect(collectionToggle).not.toBeChecked();
    await expect(
      dashboard.getByTestId("resource-card-dispatch-cpu")
    ).toHaveCount(0);

    await collectionToggle.click();
    const confirmation = page.getByTestId("resource-collection-confirmation");
    await expect(confirmation).toBeVisible();
    await expect(
      confirmation.getByText("Start collecting resource metrics?")
    ).toBeVisible();
    await expect(
      confirmation.getByText(/sample service health and resource usage/i)
    ).toBeVisible();
    await confirmation.getByTestId("resource-collection-cancel").click();
    await expect(confirmation).not.toBeVisible();
    await expect(collectionToggle).not.toBeChecked();

    await page.route("/api/v1/system/resources/settings", async (route) => {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "Unable to update resource collection" }),
      });
    });
    await collectionToggle.click();
    await confirmation.getByTestId("resource-collection-confirm").click();
    await expect(confirmation.getByRole("alert")).toHaveText(
      "Unable to update resource collection"
    );
    await expect(
      confirmation.getByTestId("resource-collection-cancel")
    ).toBeEnabled();
    await expect(
      confirmation.getByTestId("resource-collection-confirm")
    ).toBeEnabled();
    await page.unroute("/api/v1/system/resources/settings");
    await confirmation.getByTestId("resource-collection-cancel").click();

    await collectionToggle.click();
    await confirmation.getByTestId("resource-collection-confirm").click();
    await expect(collectionToggle).toBeChecked();
    await expect(
      dashboard.getByTestId("resource-card-dispatch-cpu")
    ).toBeVisible({ timeout: 10_000 });
    await expect(dashboard.getByTestId("resource-card-database")).toBeVisible();
    const agentProcessesCard = dashboard.getByTestId(
      "resource-card-agent-process-memory"
    );
    await expect(agentProcessesCard).toBeVisible();
    await expect(
      agentProcessesCard.getByText("0 B", { exact: true })
    ).toHaveCount(0);
    await expect(dashboard.getByText(/load \/ \d+ CPUs/)).toBeVisible();
    await expect(dashboard.getByText("Connected browsers")).toBeVisible();
    await expect(
      dashboard.getByText("Active sessions (including children)")
    ).toBeVisible();
    await expect(dashboard.getByText("Git refreshes active")).toBeVisible();
    await expect(
      dashboard.getByText(/Host load uses the right axis/i)
    ).toBeVisible();
    await expect(
      dashboard.getByText(/History resets when Dispatch restarts/i)
    ).toBeVisible();
    await expect(
      dashboard.getByTestId("refresh-service-resources")
    ).toHaveCount(0);
    await expect(
      dashboard.getByText("Browser streams", { exact: true })
    ).toHaveCount(0);

    await expect(dashboard.getByTestId("artifact-storage")).toContainText(
      "Retained artifacts on disk"
    );
    const hostMemory = dashboard.getByTestId("host-memory-history");
    await expect(hostMemory).toContainText("% free");
    await expect(hostMemory.getByText("Free RAM", { exact: true })).toBeVisible(
      { timeout: 25_000 }
    );
    await expect(
      hostMemory.getByText("Total RAM", { exact: true })
    ).toBeVisible();
    const databaseRow = dashboard.getByTestId("subsystem-database");
    await expect(databaseRow.getByText("Active")).toBeVisible({
      timeout: 20_000,
    });
    await databaseRow.click();
    await expect(databaseRow).toHaveAttribute("aria-expanded", "true");
    await expect(dashboard.getByText("pool total")).toBeVisible();
    await expect(
      dashboard.getByTestId("subsystem-stat-trend-database-poolTotal")
    ).toBeVisible();

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(dashboard.getByTestId("resources-updated-at")).toBeVisible();

    await collectionToggle.click();
    await expect(
      confirmation.getByText("Stop collecting resource metrics?")
    ).toBeVisible();
    await expect(
      confirmation.getByText(
        /history currently held in memory will be cleared/i
      )
    ).toBeVisible();
    await confirmation.getByTestId("resource-collection-confirm").click();
    await expect(collectionToggle).not.toBeChecked();
    await expect(
      dashboard.getByTestId("resource-card-dispatch-cpu")
    ).toHaveCount(0);
  });

  test("agent type settings filter the create-agent dialog", async ({
    page,
  }) => {
    await loadApp(page);

    await page.getByTestId("settings-button").click();
    await page
      .getByTestId("sidebar-shell")
      .getByText("Agents", { exact: true })
      .click();

    const claudeToggle = page.getByTestId("agent-type-toggle-claude");
    await expect(claudeToggle).toBeChecked();
    await claudeToggle.uncheck();
    await expect(claudeToggle).not.toBeChecked();

    // Navigate back to agents to close settings
    await page.getByTestId("agents-button").click();

    await page.getByTestId("create-agent-button").click();
    const form = page.getByTestId("create-agent-form");
    await expect(form).toBeVisible();

    const typeTrigger = form.getByRole("combobox").first();
    await expect(typeTrigger).toContainText("Codex");
    await typeTrigger.click();

    await expect(page.getByRole("option", { name: "Codex" })).toBeVisible();
    await expect(
      page.getByRole("option", { name: "Claude" })
    ).not.toBeVisible();
  });

  test("single enabled agent type removes split buttons", async ({
    page,
    request,
  }) => {
    await setEnabledAgentTypesViaAPI(request, ["codex"]);
    const agent = await createAgentViaAPI(request, {
      type: "codex",
      cwd: process.cwd(),
    });

    await loadApp(page);

    await expect(page.getByTestId("create-agent-button")).toBeVisible();
    await expect(page.getByTestId("create-agent-type-dropdown")).toHaveCount(0);

    const agentCard = page.getByTestId(`agent-card-${agent.id}`);
    await expect(agentCard).toBeVisible();
    await agentCard.getByTestId(`agent-expand-toggle-${agent.id}`).click();

    await expect(agentCard.getByTestId("launch-reviewer-button")).toBeVisible();
    await expect(
      agentCard.getByTestId("launch-reviewer-type-dropdown")
    ).toHaveCount(0);
  });
});

test("personal avatar persists, uploads, handles errors and resets", async ({
  page,
}) => {
  await loadApp(page);
  await page.getByTestId("settings-button").click();
  const cat = page.getByRole("button", { name: "Use Cat avatar" });
  await cat.click();
  await expect(cat).toHaveAttribute("aria-pressed", "true");
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(cat).toHaveAttribute("aria-pressed", "true");
  const upload = page.getByTestId("user-avatar-upload");
  await upload.setInputFiles({
    name: "avatar.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=",
      "base64"
    ),
  });
  await page.getByRole("button", { name: "Save photo", exact: true }).click();
  const photo = page.getByTestId("user-avatar-preview").locator("img");
  await expect(photo).toBeVisible();
  await expect(photo).toHaveAttribute("src", /^data:image\/webp;base64,/);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(photo).toBeVisible();
  await upload.setInputFiles({
    name: "bad.svg",
    mimeType: "image/svg+xml",
    buffer: Buffer.from("<svg/>"),
  });
  await expect(page.getByRole("alert")).toContainText(
    "Choose a PNG, JPEG, WebP, HEIC or HEIF"
  );
  await expect(photo).toBeVisible();
  await page.getByRole("button", { name: "Reset avatar" }).click();
  await expect(
    page.getByRole("button", { name: "Use Person avatar" })
  ).toHaveAttribute("aria-pressed", "true");
  await page.route("**/api/v1/app/settings/user-avatar", async (route) => {
    if (route.request().method() === "PUT")
      await route.fulfill({ status: 500, json: { error: "Save failed" } });
    else await route.continue();
  });
  await cat.click();
  await expect(page.getByRole("alert")).toContainText("Save failed");
  await expect(
    page.getByRole("button", { name: "Use Person avatar" })
  ).toHaveAttribute("aria-pressed", "true");
});

test("avatar accepts large phone photos and HEIC, saves only a cropped thumbnail", async ({
  page,
}) => {
  await loadApp(page);
  await page.getByTestId("settings-button").click();
  const jpeg = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 8000;
    canvas.height = 6000;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "red";
    ctx.fillRect(0, 0, 8000, 6000);
    ctx.fillStyle = "#00ff00";
    ctx.fillRect(1000, 0, 6000, 6000);
    return canvas.toDataURL("image/jpeg", 0.9).split(",")[1]!;
  });
  // Trailing bytes make a valid JPEG larger than the previous 5 MB cap.
  const buffer = Buffer.concat([
    Buffer.from(jpeg, "base64"),
    Buffer.alloc(6 * 1024 * 1024),
  ]);
  const upload = page.getByTestId("user-avatar-upload");
  await upload.setInputFiles({
    name: "phone-photo.jpg",
    mimeType: "application/octet-stream",
    buffer,
  });
  await page.getByRole("button", { name: "Save photo", exact: true }).click();
  const photo = page.getByTestId("user-avatar-preview").locator("img");
  await expect(photo).toBeVisible();
  const result = await photo.evaluate(async (img: HTMLImageElement) => {
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 256;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    return {
      width: img.naturalWidth,
      height: img.naturalHeight,
      size: (img.src.length * 3) / 4,
      edge: Array.from(ctx.getImageData(0, 128, 1, 1).data),
    };
  });
  expect(result.width).toBe(256);
  expect(result.height).toBe(256);
  expect(result.size).toBeLessThan(100_000);
  expect(result.edge[1]).toBeGreaterThan(240);
  expect(result.edge[0]).toBeLessThan(15);
  const previousSrc = await photo.getAttribute("src");
  await upload.setInputFiles("e2e/fixtures/avatar.heic");
  await page.getByRole("button", { name: "Save photo", exact: true }).click();
  await expect(photo).not.toHaveAttribute("src", previousSrc!, {
    timeout: 30_000,
  });
  await expect(
    page.getByRole("status").filter({ hasText: "Avatar saved" })
  ).toBeVisible({ timeout: 30_000 });
  await expect(photo).toBeVisible();
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(photo).toBeVisible();
  await page.getByRole("button", { name: "Reset avatar" }).click();
  await expect(
    page.getByRole("button", { name: "Use Person avatar" })
  ).toHaveAttribute("aria-pressed", "true");
});

test("photo framing supports zoom, positioning, cancel and retry", async ({
  page,
}) => {
  await loadApp(page);
  await page.getByTestId("settings-button").click();
  const upload = page.getByTestId("user-avatar-upload");
  await upload.setInputFiles("e2e/fixtures/avatar.heic");
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Frame your photo")).toBeVisible();
  // The portal mounts after the parent: paint on canvas attachment, before interaction.
  await expect
    .poll(() =>
      page
        .getByTestId("avatar-crop-preview")
        .evaluate(
          (canvas: HTMLCanvasElement) =>
            canvas.getContext("2d")!.getImageData(128, 128, 1, 1).data[3]
        )
    )
    .toBe(255);
  const zoom = dialog.getByRole("slider", { name: "Photo zoom" });
  await zoom.focus();
  await zoom.press("End");
  await expect(zoom).toHaveAttribute("aria-valuenow", "3");
  const crop = page.getByTestId("avatar-crop-preview");
  const before = await crop.evaluate((canvas: HTMLCanvasElement) =>
    canvas.toDataURL()
  );
  await crop.focus();
  await crop.press("ArrowLeft");
  await expect
    .poll(() =>
      crop.evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL())
    )
    .not.toBe(before);
  await dialog.getByRole("button", { name: "Reset crop" }).click();
  await expect(zoom).toHaveAttribute("aria-valuenow", "1");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "Upload photo", exact: true })
  ).toBeFocused();
  await upload.setInputFiles("e2e/fixtures/avatar.heic");
  await dialog.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "Upload photo", exact: true })
  ).toBeFocused();
  await upload.setInputFiles("e2e/fixtures/avatar.heic");
  await page.route("**/api/v1/app/settings/user-avatar", async (route) => {
    if (route.request().method() === "PUT")
      await route.fulfill({
        status: 500,
        json: { error: "Temporary failure" },
      });
    else await route.continue();
  });
  await dialog.getByRole("button", { name: "Save photo", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Could not save");
  await expect(crop).toBeVisible();
  await page.unroute("**/api/v1/app/settings/user-avatar");
  await dialog.getByRole("button", { name: "Save photo", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "Upload photo", exact: true })
  ).toBeFocused();
  await expect(
    page.getByTestId("user-avatar-preview").locator("img")
  ).toBeVisible();
  await page.getByRole("button", { name: "Reset avatar" }).click();
});

test("crop actions fit a 320px screen", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 780 });
  await loadApp(page);
  await page.goto("/settings/general", { waitUntil: "domcontentloaded" });
  await page
    .getByTestId("user-avatar-upload")
    .setInputFiles("e2e/fixtures/avatar.heic");
  const dialog = page.getByRole("dialog", { name: "Frame your photo" });
  await expect(dialog).toBeVisible();
  const bounds = await dialog.boundingBox();
  for (const name of ["Reset crop", "Cancel", "Save photo"]) {
    const button = dialog.getByRole("button", { name, exact: true });
    const box = await button.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(bounds!.x);
    expect(box!.x + box!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width);
  }
  expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
    true
  );
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
});
