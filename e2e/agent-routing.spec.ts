import { expect, test } from "@playwright/test";
import { cleanupE2EAgents, createAgentViaAPI } from "./helpers";

async function waitForAppShell(
  page: import("@playwright/test").Page,
  agentName?: string
): Promise<void> {
  await page.getByTestId("agent-sidebar").waitFor({ state: "visible" });
  await page.getByTestId("terminal-pane").waitFor({ state: "visible" });
  if (agentName) {
    await page
      .getByTestId("agent-sidebar")
      .getByText(agentName)
      .first()
      .waitFor({ state: "visible" });
  }
}

test.describe("Agent routing", () => {
  test.afterEach(async ({ request }) => {
    await cleanupE2EAgents(request);
  });

  test("deep-linking to an agent route auto-attaches that agent", async ({
    page,
    request,
  }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-agent-${Date.now()}`,
    });

    await page.goto(`/agents/${agent.id}`, { waitUntil: "domcontentloaded" });
    await waitForAppShell(page, agent.name);

    await expect(page).toHaveURL(new RegExp(`/agents/${agent.id}$`));
    await expect(page.getByTestId("current-session-name")).toContainText(
      agent.name
    );
    await expect(page.getByTestId("terminal-inert-state")).toBeVisible();
  });

  test("browser back returns to the same agent session after visiting settings", async ({
    page,
    request,
  }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-agent-${Date.now()}`,
    });

    await page.goto(`/agents/${agent.id}`, { waitUntil: "domcontentloaded" });
    await waitForAppShell(page, agent.name);
    await expect(page.getByTestId("terminal-inert-state")).toBeVisible();

    await page.getByTestId("settings-button").click();
    await expect(page).toHaveURL(/\/settings$/);

    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/agents/${agent.id}$`));
    await expect(page.getByTestId("current-session-name")).toContainText(
      agent.name
    );
    await expect(page.getByTestId("terminal-inert-state")).toBeVisible();
  });

  test("invalid feedback and review routes normalize back to the agent route", async ({
    page,
    request,
  }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-agent-${Date.now()}`,
    });

    await page.goto(`/agents/${agent.id}/feedback/not-a-number`, {
      waitUntil: "domcontentloaded",
    });
    await waitForAppShell(page, agent.name);
    await expect(page).toHaveURL(new RegExp(`/agents/${agent.id}$`));

    await page.goto(`/agents/${agent.id}/review/not-a-real-agent`, {
      waitUntil: "domcontentloaded",
    });
    await waitForAppShell(page, agent.name);
    await expect(page).toHaveURL(new RegExp(`/agents/${agent.id}$`));
  });

  test("base agents route stays detached until the URL selects an agent", async ({
    page,
  }) => {
    await page.goto("/agents", { waitUntil: "domcontentloaded" });
    await waitForAppShell(page);

    await expect(page).toHaveURL(/\/agents$/);
    await expect(page.getByTestId("terminal-empty-state")).toBeVisible();
  });

  test("missing numeric feedback items show an explicit not found state", async ({
    page,
    request,
  }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-agent-${Date.now()}`,
    });

    await page.goto(`/agents/${agent.id}/feedback/99999`, {
      waitUntil: "domcontentloaded",
    });
    await waitForAppShell(page, agent.name);

    await expect(page).toHaveURL(
      new RegExp(`/agents/${agent.id}/feedback/99999$`)
    );
    await expect(page.getByTestId("feedback-item-not-found")).toBeVisible();
  });
});
