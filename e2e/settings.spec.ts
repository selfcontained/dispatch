import { test, expect } from "@playwright/test";
import {
  createAgentViaAPI,
  loadApp,
  setEnabledAgentTypesViaAPI,
} from "./helpers";

test.describe("Settings pane", () => {
  test.afterEach(async ({ request }) => {
    await setEnabledAgentTypesViaAPI(request, ["codex", "claude", "opencode"]);
    await request.post("/api/v1/notifications/settings", {
      headers: {
        Authorization: `Bearer ${process.env.AUTH_TOKEN ?? "dev-token"}`,
      },
      data: {
        webNotifyEnabled: false,
        webNotifyEvents: ["done", "waiting_user", "blocked"],
      },
    });
    await request.post("/api/v1/app/settings/cross-repo-messaging", {
      headers: {
        Authorization: `Bearer ${process.env.AUTH_TOKEN ?? "dev-token"}`,
      },
      data: { enabled: false },
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
    const generalNav = sidebar.getByText("General");
    await expect(generalNav).toBeVisible();

    // Navigate back to agents to close settings
    await page.getByTestId("agents-button").click();

    // Settings nav should no longer be visible (back to agents view)
    await expect(generalNav).not.toBeVisible({ timeout: 3_000 });
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
      "resource-card-agent-processes"
    );
    await expect(agentProcessesCard).toBeVisible();
    await expect(
      agentProcessesCard.getByText("0 B", { exact: true })
    ).toHaveCount(0);
    await expect(dashboard.getByText(/load \/ \d+ CPUs/)).toBeVisible();
    await expect(dashboard.getByText("Connected browsers")).toBeVisible();
    await expect(dashboard.getByText("Active terminal views")).toBeVisible();
    await expect(dashboard.getByText("Git refreshes active")).toBeVisible();
    await expect(
      dashboard.getByText(/host load uses the right load axis/i)
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
    await expect(page.getByRole("option", { name: "OpenCode" })).toBeVisible();
    await expect(
      page.getByRole("option", { name: "Claude" })
    ).not.toBeVisible();
  });

  test("cross-repo messaging toggle defaults off and persists to the server", async ({
    page,
    request,
  }) => {
    await loadApp(page);

    await page.getByTestId("settings-button").click();
    await page
      .getByTestId("sidebar-shell")
      .getByText("Agents", { exact: true })
      .click();

    const toggle = page.getByTestId("cross-repo-messaging-toggle");
    await toggle.scrollIntoViewIfNeeded();
    await expect(toggle).not.toBeChecked();

    await toggle.check();
    await expect(toggle).toBeChecked();

    // The local toggle is mirrored to the server, which enforces the boundary.
    await expect
      .poll(async () => {
        const res = await request.get(
          "/api/v1/app/settings/cross-repo-messaging",
          {
            headers: {
              Authorization: `Bearer ${process.env.AUTH_TOKEN ?? "dev-token"}`,
            },
          }
        );
        return (await res.json()).enabled;
      })
      .toBe(true);
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
