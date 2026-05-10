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

    // 6. Press Enter to select the template
    await page.keyboard.press("Enter");

    // 7. Confirmation step appears
    await expect(palette.getByText("This will create a new agent")).toBeVisible(
      { timeout: 3_000 }
    );
    const launchOption = palette.getByRole("option", { name: "Launch" });
    await expect(launchOption).toBeVisible();

    // 8. Press Enter to confirm launch
    await page.keyboard.press("Enter");

    // 9. Palette should close
    await expect(palette).not.toBeVisible({ timeout: 3_000 });

    // 10. Wait for the agent to appear in the sidebar (via SSE, no refresh)
    const sidebar = page.getByTestId("agent-sidebar");
    await expect(sidebar.getByText(new RegExp(`e2e-callable-`))).toBeVisible({
      timeout: 10_000,
    });

    // 11. Verify URL navigated to the new agent (worktree setup adds latency)
    await expect(page).toHaveURL(/\/agents\/agt_/, { timeout: 30_000 });
  });
});
