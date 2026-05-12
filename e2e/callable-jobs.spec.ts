import { test, expect } from "@playwright/test";
import { execSync } from "child_process";
import { mkdirSync } from "fs";
import { tmpdir, platform } from "os";
import { join } from "path";
import { loadApp, cleanupE2EAgents } from "./helpers";

const MOD_KEY = platform() === "darwin" ? "Meta" : "Control";

const AUTH_HEADER = {
  Authorization: `Bearer ${process.env.AUTH_TOKEN ?? "dev-token"}`,
};
const HEADERS = { ...AUTH_HEADER, "Content-Type": "application/json" };

function initGitRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execSync(
    "git init -b main && git commit --allow-empty -m init && git remote add origin .",
    { cwd: dir, stdio: "ignore" }
  );
}

test.describe("Callable templates — Cmd+K launch lifecycle", () => {
  const templateDir = join(tmpdir(), `dispatch-e2e-callable-${Date.now()}`);
  initGitRepo(templateDir);
  const templateName = `e2e-callable-${Date.now()}`;
  let templateId: string | null = null;

  test.afterEach(async ({ request }) => {
    const listRes = await request.get("/api/v1/agents", {
      headers: AUTH_HEADER,
    });
    const { agents } = (await listRes.json()) as {
      agents: Array<{ id: string; name: string; status: string }>;
    };
    for (const agent of agents) {
      if (agent.name.startsWith("e2e-callable-")) {
        if (agent.status !== "stopped") {
          await request.post(`/api/v1/agents/${agent.id}/stop`, {
            headers: AUTH_HEADER,
          });
        }
        await request.delete(
          `/api/v1/agents/${agent.id}?force=true&cleanupWorktree=force`,
          { headers: AUTH_HEADER }
        );
      }
    }

    if (templateId) {
      await request.delete(`/api/v1/templates/${templateId}`, {
        headers: AUTH_HEADER,
      });
      templateId = null;
    }

    await cleanupE2EAgents(request);
  });

  test("launching a callable template from Cmd+K shows agent in sidebar and navigates to it", async ({
    page,
    request,
  }) => {
    // 1. Create a callable template via API
    const createRes = await request.post("/api/v1/templates", {
      headers: HEADERS,
      data: {
        name: templateName,
        directory: templateDir,
        prompt: "Say hello and stop.",
        callable: true,
        allowMedia: false,
        agentType: "claude",
        useWorktree: true,
      },
    });
    expect(createRes.ok()).toBeTruthy();
    const created = (await createRes.json()) as { id: string };
    templateId = created.id;

    // 2. Load the app
    await loadApp(page);

    // 3. Open Cmd+K palette
    await page.keyboard.press(`${MOD_KEY}+k`);
    const palette = page.getByRole("dialog", { name: "Command palette" });
    await expect(palette).toBeVisible({ timeout: 3_000 });

    // 4. Type the template name to filter
    const input = palette.getByRole("combobox");
    await input.pressSequentially("e2e-callable", { delay: 30 });

    // 5. Verify only the template shows (Commands group hidden)
    await expect(palette.getByText(templateName)).toBeVisible();
    await expect(palette.getByText("Commands")).not.toBeVisible();

    // 6. Press Enter to open the launch form
    await page.keyboard.press("Enter");

    // 7. Launch dialog appears with agent type override controls
    await expect(palette).not.toBeVisible({ timeout: 3_000 });
    const launchDialog = page.getByRole("dialog", { name: templateName });
    await expect(launchDialog).toBeVisible({ timeout: 3_000 });
    const agentTypeField = launchDialog.getByRole("combobox");
    await expect(agentTypeField).toContainText("Claude");
    await agentTypeField.click();
    await page.getByRole("option", { name: "Codex" }).click();
    await expect(agentTypeField).toContainText("Codex");
    const launchButton = launchDialog.getByRole("button", { name: "Launch" });

    // 8. Launch the template with the override applied
    await launchButton.click();

    // 9. Verify URL navigated to the new agent (worktree setup adds latency)
    await expect(page).toHaveURL(/\/agents\/agt_/, { timeout: 30_000 });

    // 10. Wait for the specific launched agent card to appear as a top-level
    // sidebar entry. Scope to the scroll region so we don't match duplicated
    // descendant markup outside the owning list item.
    const agentId = page.url().match(/\/agents\/(agt_[a-f0-9]{12})/)?.[1];
    expect(agentId).toBeTruthy();
    const sidebarScroll = page.getByTestId("agent-sidebar-scroll");
    const launchedAgentCard = sidebarScroll.locator(
      `:scope > [data-testid="agent-card-${agentId}"]`
    );
    await expect(launchedAgentCard).toHaveCount(1, { timeout: 10_000 });
    await expect(launchedAgentCard).toBeVisible({
      timeout: 10_000,
    });

    // 11. Verify the launch respected the selected override.
    const listRes = await request.get("/api/v1/agents", {
      headers: AUTH_HEADER,
    });
    const { agents } = (await listRes.json()) as {
      agents: Array<{ id: string; type: string }>;
    };
    expect(agents.find((agent) => agent.id === agentId)?.type).toBe("codex");
  });

  test("no-arg callable template still supports fast Enter-to-launch from Cmd+K", async ({
    page,
  }) => {
    const createRes = await page.request.post("/api/v1/templates", {
      headers: HEADERS,
      data: {
        name: templateName,
        directory: templateDir,
        prompt: "Say hello and stop.",
        callable: true,
        allowMedia: false,
        agentType: "claude",
        useWorktree: false,
      },
    });
    expect(createRes.ok()).toBeTruthy();
    const created = (await createRes.json()) as { id: string };
    templateId = created.id;

    await loadApp(page);
    await page.keyboard.press(`${MOD_KEY}+k`);
    const palette = page.getByRole("dialog", { name: "Command palette" });
    await expect(palette).toBeVisible({ timeout: 3_000 });
    await palette.getByRole("combobox").pressSequentially("e2e-callable", {
      delay: 30,
    });

    await page.keyboard.press("Enter");
    const launchDialog = page.getByRole("dialog", { name: templateName });
    await expect(launchDialog).toBeVisible({ timeout: 3_000 });

    await launchDialog.getByRole("button", { name: "Launch" }).click();
    await expect(page).toHaveURL(/\/agents\/agt_/, { timeout: 30_000 });
  });
});
