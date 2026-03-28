import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { test, expect } from "@playwright/test";
import { cleanupE2EAgents, createAgentViaAPI, deleteAgentViaAPI, getWorktreeStatusViaAPI, loadApp } from "./helpers";

const authHeader = { Authorization: `Bearer ${process.env.AUTH_TOKEN ?? "dev-token"}` };

/** Create a minimal git repo in /tmp with one commit and a local origin, returning the repo path. */
function createTestRepo(suffix: string): string {
  const barePath = `/tmp/dispatch-e2e-bare-${suffix}`;
  const repoPath = `/tmp/dispatch-e2e-repo-${suffix}`;
  rmSync(barePath, { recursive: true, force: true });
  rmSync(repoPath, { recursive: true, force: true });

  // Create a bare repo to act as "origin"
  mkdirSync(barePath, { recursive: true });
  execSync("git init --bare", { cwd: barePath, stdio: "ignore" });

  // Clone it as the working repo
  execSync(`git clone "${barePath}" "${repoPath}"`, { stdio: "ignore" });
  execSync('git config user.email "test@test.com" && git config user.name "Test"', {
    cwd: repoPath,
    stdio: "ignore",
  });
  writeFileSync(`${repoPath}/README.md`, "# test\n");
  writeFileSync(`${repoPath}/.gitignore`, ".env\n");
  execSync("git add -A && git commit -m 'initial' && git push origin main", {
    cwd: repoPath,
    stdio: "ignore",
  });
  return repoPath;
}

/** Remove a test repo, its bare origin, and any worktrees created from it. */
function cleanupTestRepo(repoPath: string): void {
  const barePath = repoPath.replace("-repo-", "-bare-");
  // Remove any worktrees git knows about (they'll be siblings)
  try {
    const output = execSync("git worktree list --porcelain", { cwd: repoPath, encoding: "utf-8" });
    for (const line of output.split("\n")) {
      if (line.startsWith("worktree ") && !line.includes(repoPath)) {
        const wtPath = line.replace("worktree ", "").trim();
        try {
          execSync(`git worktree remove --force "${wtPath}"`, { cwd: repoPath, stdio: "ignore" });
        } catch {
          rmSync(wtPath, { recursive: true, force: true });
        }
      }
    }
  } catch {
    // repo may already be gone
  }
  rmSync(repoPath, { recursive: true, force: true });
  rmSync(barePath, { recursive: true, force: true });
}

test.describe("Worktree", () => {
  test.afterEach(async ({ request }) => {
    await cleanupE2EAgents(request);
  });

  test("create dialog shows worktree checkbox defaulting to checked", async ({ page }) => {
    await loadApp(page);

    await page.getByTestId("create-agent-button").click();
    const form = page.getByTestId("create-agent-form");
    await expect(form).toBeVisible();

    // Worktree checkbox should exist and be checked by default
    const worktreeCheckbox = page.getByTestId("create-agent-worktree");
    await expect(worktreeCheckbox).toBeVisible();
    await expect(worktreeCheckbox).toHaveAttribute("aria-checked", "true");

    // "Create git worktree" label text should be visible
    await expect(form.getByText("Create git worktree")).toBeVisible();
  });

  test("worktree checkbox can be toggled off and on", async ({ page }) => {
    await loadApp(page);

    await page.getByTestId("create-agent-button").click();
    const form = page.getByTestId("create-agent-form");
    await expect(form).toBeVisible();

    const worktreeCheckbox = page.getByTestId("create-agent-worktree");
    await expect(worktreeCheckbox).toHaveAttribute("aria-checked", "true");

    // Toggle it off by clicking the label text (avoids double-toggle from label+button)
    await form.getByText("Create git worktree").click();
    await expect(worktreeCheckbox).toHaveAttribute("aria-checked", "false");

    // Toggle it back on
    await form.getByText("Create git worktree").click();
    await expect(worktreeCheckbox).toHaveAttribute("aria-checked", "true");
  });

  test("POST /api/v1/agents accepts useWorktree=false", async ({ request }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-agent-${Date.now()}`,
      useWorktree: false,
    });
    expect(agent.worktreePath).toBeNull();
  });

  test("POST /api/v1/agents validates useWorktree type", async ({ request }) => {
    const res = await request.post("/api/v1/agents", {
      headers: authHeader,
      data: { cwd: "/tmp", useWorktree: "not-a-boolean" },
    });
    expect(res.status()).toBe(400);

    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("useWorktree");
  });

  test("GET /api/v1/agents/:id/worktree-status returns status for agent without worktree", async ({ request }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-agent-${Date.now()}`,
      useWorktree: false,
    });

    const status = await getWorktreeStatusViaAPI(request, agent.id);
    expect(status.hasWorktree).toBe(false);
    expect(status.hasUnmergedCommits).toBe(false);
    expect(status.hasUncommittedChanges).toBe(false);
    expect(status.worktreePath).toBeNull();
    expect(status.branchName).toBeNull();
  });

  test("DELETE /api/v1/agents/:id accepts cleanupWorktree param", async ({ request }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-agent-${Date.now()}`,
      useWorktree: false,
    });

    // Agent is running in inert mode, so force-stop first
    await request.post(`/api/v1/agents/${agent.id}/stop`, {
      headers: authHeader,
      data: { force: true },
    });

    // Delete with cleanupWorktree=keep should succeed
    const res = await request.delete(`/api/v1/agents/${agent.id}?cleanupWorktree=keep`, {
      headers: authHeader,
    });
    expect(res.status()).toBe(204);
  });

  test("delete dialog shows standard confirmation for agent without worktree", async ({
    page,
    request,
  }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-agent-${Date.now()}`,
      useWorktree: false,
    });
    await loadApp(page);

    const sidebar = page.getByTestId("agent-sidebar");
    await expect(sidebar.getByText(agent.name)).toBeVisible({ timeout: 5_000 });

    // Open the overflow menu on the agent card
    const agentCard = page.getByTestId(`agent-card-${agent.id}`);
    await agentCard.locator('[data-agent-control="true"]').last().click();

    // Click "Delete agent" from the overflow menu
    await page.getByText("Delete agent").click();

    // Should show standard delete confirmation (not worktree choice)
    await expect(page.getByTestId("delete-agent-confirm")).toBeVisible({ timeout: 3_000 });
    await expect(page.getByText("permanently removes")).toBeVisible();

    // Confirm deletion
    await page.getByTestId("delete-agent-confirm").click();
    await expect(sidebar.getByText(agent.name)).not.toBeVisible({ timeout: 5_000 });
  });
});

test.describe("Worktree filesystem", () => {
  const testId = `${process.pid}-${Date.now()}`;
  let repoPath: string;

  test.beforeAll(() => {
    repoPath = createTestRepo(testId);
  });

  test.afterAll(() => {
    cleanupTestRepo(repoPath);
  });

  test.afterEach(async ({ request }) => {
    await cleanupE2EAgents(request);
  });

  test("creates a real worktree on the filesystem", async ({ request }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-agent-wt-${Date.now()}`,
      cwd: repoPath,
      useWorktree: true,
    });

    // Agent should have a worktree path set
    expect(agent.worktreePath).toBeTruthy();
    expect(agent.worktreePath).not.toBe(repoPath);

    // The worktree directory should exist on disk
    expect(existsSync(agent.worktreePath!)).toBe(true);

    // The worktree should be a git checkout
    const branch = execSync("git symbolic-ref --short HEAD", {
      cwd: agent.worktreePath!,
      encoding: "utf-8",
    }).trim();
    expect(branch).toContain(agent.id.replace("agt_", ""));

    // The agent's cwd should be the worktree, not the original repo
    const agentRes = await request.get(`/api/v1/agents/${agent.id}`, {
      headers: { Authorization: `Bearer ${process.env.AUTH_TOKEN ?? "dev-token"}` },
    });
    const { agent: fullAgent } = (await agentRes.json()) as { agent: { cwd: string } };
    expect(fullAgent.cwd).toBe(agent.worktreePath);
  });

  test("auto-generates branch name from agent id and name", async ({ request }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-agent-autobranch-${Date.now()}`,
      cwd: repoPath,
      useWorktree: true,
    });

    expect(agent.worktreeBranch).toBeTruthy();
    // Auto-generated format: <agentId>/<slugified-name>
    expect(agent.worktreeBranch).toContain(agent.id);
    expect(agent.worktreeBranch).toContain("e2e-agent-autobranch");

    // Branch should match what git reports
    const gitBranch = execSync("git symbolic-ref --short HEAD", {
      cwd: agent.worktreePath!,
      encoding: "utf-8",
    }).trim();
    expect(gitBranch).toBe(agent.worktreeBranch);
  });

  test("uses user-provided branch name when specified", async ({ request }) => {
    const customBranch = `custom/my-feature-${Date.now()}`;
    const agent = await createAgentViaAPI(request, {
      name: `e2e-agent-custombranch-${Date.now()}`,
      cwd: repoPath,
      useWorktree: true,
      worktreeBranch: customBranch,
    });

    expect(agent.worktreeBranch).toBe(customBranch);

    // Branch should match what git reports
    const gitBranch = execSync("git symbolic-ref --short HEAD", {
      cwd: agent.worktreePath!,
      encoding: "utf-8",
    }).trim();
    expect(gitBranch).toBe(customBranch);
  });

  test("copies .env into the worktree", async ({ request }) => {
    // Write a .env file in the repo
    writeFileSync(`${repoPath}/.env`, "SECRET_KEY=test123\nDB_URL=localhost\n");

    const agent = await createAgentViaAPI(request, {
      name: `e2e-agent-env-${Date.now()}`,
      cwd: repoPath,
      useWorktree: true,
    });

    expect(agent.worktreePath).toBeTruthy();

    // .env should have been copied to the worktree
    const envPath = `${agent.worktreePath}/.env`;
    expect(existsSync(envPath)).toBe(true);

    const content = readFileSync(envPath, "utf-8");
    expect(content).toContain("SECRET_KEY=test123");
    expect(content).toContain("DB_URL=localhost");
  });

  test("worktree-status reports no unmerged commits for clean worktree", async ({ request }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-agent-clean-${Date.now()}`,
      cwd: repoPath,
      useWorktree: true,
    });

    const status = await getWorktreeStatusViaAPI(request, agent.id);
    expect(status.hasWorktree).toBe(true);
    expect(status.hasUnmergedCommits).toBe(false);
    expect(status.hasUncommittedChanges).toBe(false);
    expect(status.branchName).toBeTruthy();
    expect(status.worktreePath).toBe(agent.worktreePath);
  });

  test("deleting agent with clean worktree removes it from disk", async ({ request }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-agent-delclean-${Date.now()}`,
      cwd: repoPath,
      useWorktree: true,
    });

    const wtPath = agent.worktreePath!;
    expect(existsSync(wtPath)).toBe(true);

    await deleteAgentViaAPI(request, agent.id, "auto");

    // Worktree should have been removed
    expect(existsSync(wtPath)).toBe(false);
  });

  test("worktree-status reports unmerged commits after local commit", async ({ request }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-agent-dirty-${Date.now()}`,
      cwd: repoPath,
      useWorktree: true,
    });

    // Make a commit in the worktree
    writeFileSync(`${agent.worktreePath}/new-file.txt`, "some work\n");
    execSync("git add -A && git commit -m 'unmerged work'", {
      cwd: agent.worktreePath!,
      stdio: "ignore",
    });

    const status = await getWorktreeStatusViaAPI(request, agent.id);
    expect(status.hasWorktree).toBe(true);
    expect(status.hasUnmergedCommits).toBe(true);
    expect(status.changedFiles).toContain("new-file.txt");
  });

  test("worktree-status reports uncommitted changes for modified files", async ({ request }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-agent-uncommitted-${Date.now()}`,
      cwd: repoPath,
      useWorktree: true,
    });

    // Create an unstaged file in the worktree (no commit)
    writeFileSync(`${agent.worktreePath}/uncommitted-file.txt`, "uncommitted work\n");

    const status = await getWorktreeStatusViaAPI(request, agent.id);
    expect(status.hasWorktree).toBe(true);
    expect(status.hasUnmergedCommits).toBe(false);
    expect(status.hasUncommittedChanges).toBe(true);
    expect(status.uncommittedFiles).toContain("?? uncommitted-file.txt");
  });

  test("deleting agent with uncommitted changes and cleanupWorktree=auto preserves worktree", async ({ request }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-agent-keepuncommitted-${Date.now()}`,
      cwd: repoPath,
      useWorktree: true,
    });

    writeFileSync(`${agent.worktreePath}/uncommitted-keep.txt`, "keep this\n");

    const wtPath = agent.worktreePath!;
    await deleteAgentViaAPI(request, agent.id, "auto");

    // Worktree should be preserved because it has uncommitted changes
    expect(existsSync(wtPath)).toBe(true);

    // Clean up manually
    execSync(`git -C "${repoPath}" worktree remove --force "${wtPath}"`, { stdio: "ignore" });
  });

  test("deleting agent with unmerged commits and cleanupWorktree=auto preserves worktree", async ({ request }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-agent-keepwt-${Date.now()}`,
      cwd: repoPath,
      useWorktree: true,
    });

    // Make a commit in the worktree
    writeFileSync(`${agent.worktreePath}/keep-file.txt`, "important work\n");
    execSync("git add -A && git commit -m 'keep this'", {
      cwd: agent.worktreePath!,
      stdio: "ignore",
    });

    const wtPath = agent.worktreePath!;
    await deleteAgentViaAPI(request, agent.id, "auto");

    // Worktree should be preserved because it has unmerged commits
    expect(existsSync(wtPath)).toBe(true);

    // Clean up manually
    execSync(`git -C "${repoPath}" worktree remove --force "${wtPath}"`, { stdio: "ignore" });
  });

  test("deleting agent with unmerged commits and cleanupWorktree=force removes worktree", async ({ request }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-agent-forcewt-${Date.now()}`,
      cwd: repoPath,
      useWorktree: true,
    });

    // Make a commit in the worktree
    writeFileSync(`${agent.worktreePath}/force-file.txt`, "will be deleted\n");
    execSync("git add -A && git commit -m 'force delete'", {
      cwd: agent.worktreePath!,
      stdio: "ignore",
    });

    const wtPath = agent.worktreePath!;
    await deleteAgentViaAPI(request, agent.id, "force");

    // Worktree should be gone despite having unmerged commits
    expect(existsSync(wtPath)).toBe(false);
  });

  test("delete dialog shows worktree choice when agent has unmerged commits", async ({
    page,
    request,
  }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-agent-uichoice-${Date.now()}`,
      cwd: repoPath,
      useWorktree: true,
    });

    // Make a commit in the worktree to create unmerged state
    writeFileSync(`${agent.worktreePath}/ui-file.txt`, "ui test work\n");
    execSync("git add -A && git commit -m 'ui test commit'", {
      cwd: agent.worktreePath!,
      stdio: "ignore",
    });

    await loadApp(page);

    const sidebar = page.getByTestId("agent-sidebar");
    const agentCard = page.getByTestId(`agent-card-${agent.id}`);
    await expect(agentCard).toBeVisible({ timeout: 5_000 });

    // Open the overflow menu and click Delete
    await agentCard.locator('[data-agent-control="true"]').last().click();
    await page.getByText("Delete agent").click();

    // First step: standard delete confirmation
    await expect(page.getByTestId("delete-agent-confirm")).toBeVisible({ timeout: 3_000 });
    await page.getByTestId("delete-agent-confirm").click();

    // Second step: worktree choice dialog should appear
    await expect(page.getByText("Worktree Has Outstanding Changes")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId("delete-agent-keep-worktree")).toBeVisible();
    await expect(page.getByTestId("delete-agent-force-worktree")).toBeVisible();

    // Choose "Leave worktree"
    const wtPath = agent.worktreePath!;
    await page.getByTestId("delete-agent-keep-worktree").click();

    // Agent should be removed from sidebar
    await expect(agentCard).not.toBeVisible({ timeout: 5_000 });

    // But worktree should still exist
    expect(existsSync(wtPath)).toBe(true);

    // Clean up manually
    execSync(`git -C "${repoPath}" worktree remove --force "${wtPath}"`, { stdio: "ignore" });
  });

  test("delete dialog force-delete worktree option removes it", async ({
    page,
    request,
  }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-agent-uiforce-${Date.now()}`,
      cwd: repoPath,
      useWorktree: true,
    });

    // Make a commit in the worktree
    writeFileSync(`${agent.worktreePath}/force-ui-file.txt`, "force ui test\n");
    execSync("git add -A && git commit -m 'force ui commit'", {
      cwd: agent.worktreePath!,
      stdio: "ignore",
    });

    await loadApp(page);

    const agentCard2 = page.getByTestId(`agent-card-${agent.id}`);
    await expect(agentCard2).toBeVisible({ timeout: 5_000 });

    // Open the overflow menu and click Delete
    await agentCard2.locator('[data-agent-control="true"]').last().click();
    await page.getByText("Delete agent").click();

    // First step: standard delete confirmation
    await expect(page.getByTestId("delete-agent-confirm")).toBeVisible({ timeout: 3_000 });
    await page.getByTestId("delete-agent-confirm").click();

    // Second step: worktree choice dialog
    await expect(page.getByText("Worktree Has Outstanding Changes")).toBeVisible({ timeout: 5_000 });

    // Choose "Delete worktree"
    const wtPath = agent.worktreePath!;
    await page.getByTestId("delete-agent-force-worktree").click();

    // Agent should be removed from sidebar
    await expect(agentCard2).not.toBeVisible({ timeout: 5_000 });

    // Worktree should be gone
    expect(existsSync(wtPath)).toBe(false);
  });
});

test.describe("Worktree location setting", () => {
  const testId = `loc-${process.pid}-${Date.now()}`;
  let repoPath: string;

  test.beforeAll(() => {
    repoPath = createTestRepo(testId);
  });

  test.afterAll(() => {
    cleanupTestRepo(repoPath);
  });

  test.afterEach(async ({ request }) => {
    // Reset to default
    await request.post("/api/v1/agents/settings", {
      headers: authHeader,
      data: { worktreeLocation: "sibling" },
    });
    await cleanupE2EAgents(request);
  });

  test("GET /api/v1/agents/settings returns default worktree location", async ({ request }) => {
    const res = await request.get("/api/v1/agents/settings", { headers: authHeader });
    expect(res.ok()).toBeTruthy();
    const body = (await res.json()) as { worktreeLocation: string };
    expect(body.worktreeLocation).toBe("sibling");
  });

  test("POST /api/v1/agents/settings persists worktree location", async ({ request }) => {
    const res = await request.post("/api/v1/agents/settings", {
      headers: authHeader,
      data: { worktreeLocation: "nested" },
    });
    expect(res.ok()).toBeTruthy();
    const body = (await res.json()) as { worktreeLocation: string };
    expect(body.worktreeLocation).toBe("nested");

    // Verify it persisted
    const getRes = await request.get("/api/v1/agents/settings", { headers: authHeader });
    const getBody = (await getRes.json()) as { worktreeLocation: string };
    expect(getBody.worktreeLocation).toBe("nested");
  });

  test("POST /api/v1/agents/settings validates worktree location", async ({ request }) => {
    const res = await request.post("/api/v1/agents/settings", {
      headers: authHeader,
      data: { worktreeLocation: "invalid" },
    });
    expect(res.status()).toBe(400);
  });

  test("sibling location creates worktree next to the repo", async ({ request }) => {
    await request.post("/api/v1/agents/settings", {
      headers: authHeader,
      data: { worktreeLocation: "sibling" },
    });

    const agent = await createAgentViaAPI(request, {
      name: `e2e-agent-sibling-${Date.now()}`,
      cwd: repoPath,
      useWorktree: true,
    });

    expect(agent.worktreePath).toBeTruthy();
    // Sibling: worktree is next to the repo, not inside it
    expect(agent.worktreePath!.startsWith(repoPath)).toBe(false);
    expect(existsSync(agent.worktreePath!)).toBe(true);
  });

  test("nested location creates worktree inside .dispatch/worktrees", async ({ request }) => {
    await request.post("/api/v1/agents/settings", {
      headers: authHeader,
      data: { worktreeLocation: "nested" },
    });

    const agent = await createAgentViaAPI(request, {
      name: `e2e-agent-nested-${Date.now()}`,
      cwd: repoPath,
      useWorktree: true,
    });

    expect(agent.worktreePath).toBeTruthy();
    // Nested: worktree is inside <repoPath>/.dispatch/worktrees/
    expect(agent.worktreePath!.startsWith(`${repoPath}/.dispatch/worktrees/`)).toBe(true);
    expect(existsSync(agent.worktreePath!)).toBe(true);
  });

  test("settings toggle is visible in the UI", async ({ page }) => {
    await loadApp(page);

    await page.getByTestId("settings-button").click();
    await page.getByRole("navigation").getByText("Agents", { exact: true }).click();

    await expect(page.getByText("Worktree location")).toBeVisible({ timeout: 3_000 });
    await expect(page.getByText("Sibling directories")).toBeVisible();
    await expect(page.getByText("Inside .dispatch/worktrees")).toBeVisible();
  });
});
