import { test, expect } from "@playwright/test";
import { createAgentViaAPI, loadApp, setAgentRoleViaDB } from "./helpers";

test.describe("Assisted update launch", () => {
  test("redirects to the assisted update agent and shows sidebar treatment", async ({
    page,
    request,
  }) => {
    const agent = await createAgentViaAPI(request, {
      name: `update-v9.9.9-${Date.now()}`,
      type: "codex",
      cwd: process.cwd(),
      useWorktree: false,
    });
    await setAgentRoleViaDB(agent.id, "assisted_update");

    await page.route("**/api/v1/release/info", async (route) => {
      await route.fulfill({
        json: {
          currentTag: "v1.0.0",
          channel: "stable",
          isAdmin: true,
          latestTag: "v9.9.9",
          updateAvailable: true,
          latestRelease: {
            tag: "v9.9.9",
            publishedAt: new Date().toISOString(),
            url: "https://example.com/releases/v9.9.9",
          },
          unreleasedCount: 0,
          commits: [],
          refMissing: false,
        },
      });
    });

    await page.route("**/api/v1/release/update-assisted", async (route) => {
      await route.fulfill({
        status: 201,
        json: {
          agent: {
            id: agent.id,
          },
        },
      });
    });

    await loadApp(page);

    await page.getByTestId("settings-button").click();
    await page
      .getByTestId("sidebar-shell")
      .getByText("Updates", { exact: true })
      .click();
    await page.getByRole("button", { name: "Check for updates" }).click();
    await page.getByTestId("assisted-update-button").click();

    await expect(page).toHaveURL(new RegExp(`/agents/${agent.id}$`));

    const agentCard = page.getByTestId(`agent-card-${agent.id}`);
    await expect(agentCard).toBeVisible();
    await expect(
      agentCard.getByTitle("Agent-assisted Dispatch update")
    ).toBeVisible();
  });
});
