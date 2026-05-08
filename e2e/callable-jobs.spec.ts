import { test, expect } from "@playwright/test";
import { execSync } from "child_process";
import { mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadApp, cleanupE2EAgents } from "./helpers";

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

test.describe("Callable jobs — Cmd+K launch lifecycle", () => {
  const jobDir = join(tmpdir(), `dispatch-e2e-callable-${Date.now()}`);
  initGitRepo(jobDir);
  const jobName = `e2e-callable-${Date.now()}`;

  test.afterEach(async ({ request }) => {
    // Clean up any agents spawned by the job
    const listRes = await request.get("/api/v1/agents", {
      headers: AUTH_HEADER,
    });
    const { agents } = (await listRes.json()) as {
      agents: Array<{ id: string; name: string; status: string }>;
    };
    for (const agent of agents) {
      if (agent.name.startsWith("job-e2e-callable-")) {
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

    // Clean up the job (need to clear active runs first)
    await request.delete("/api/v1/jobs", {
      headers: HEADERS,
      data: { name: jobName, directory: jobDir },
    });

    await cleanupE2EAgents(request);
  });

  test("launching a callable job from Cmd+K shows agent in sidebar and navigates to it", async ({
    page,
    request,
  }) => {
    // 1. Create a callable job via API
    const createRes = await request.post("/api/v1/jobs", {
      headers: HEADERS,
      data: {
        name: jobName,
        directory: jobDir,
        prompt: "Say hello and call job_complete.",
        callable: true,
        agentType: "claude",
        autoArchive: true,
        useWorktree: true,
      },
    });
    expect(createRes.ok()).toBeTruthy();

    // 2. Load the app
    await loadApp(page);

    // 3. Open Cmd+K palette
    await page.keyboard.press("Meta+k");
    const palette = page.getByRole("dialog", { name: "Command palette" });
    await expect(palette).toBeVisible({ timeout: 3_000 });

    // 4. Type the job name to filter
    const input = palette.getByRole("combobox");
    await input.pressSequentially("e2e-callable", { delay: 30 });

    // 5. Verify only the job shows (Commands group hidden)
    await expect(palette.getByText(jobName)).toBeVisible();
    await expect(palette.getByText("Commands")).not.toBeVisible();

    // 6. Press Enter to launch
    await page.keyboard.press("Enter");

    // 7. Palette should close
    await expect(palette).not.toBeVisible({ timeout: 3_000 });

    // 8. Wait for the agent to appear in the sidebar (via SSE, no refresh)
    const sidebar = page.getByTestId("agent-sidebar");
    await expect(
      sidebar.getByText(new RegExp(`job-e2e-callable-`))
    ).toBeVisible({ timeout: 10_000 });

    // 9. Verify URL navigated to the new agent (worktree setup adds latency)
    await expect(page).toHaveURL(/\/agents\/agt_/, { timeout: 30_000 });
  });
});
