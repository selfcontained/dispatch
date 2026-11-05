import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  test,
  expect,
  type Page,
  type APIRequestContext,
} from "@playwright/test";
import { cleanupE2EAgents, createAgentViaAPI, loadApp } from "./helpers";

const authHeader = {
  Authorization: `Bearer ${process.env.AUTH_TOKEN ?? "dev-token"}`,
};

/** Create a minimal git repo in /tmp with one commit and a local origin, returning the repo path. */
function createTestRepo(suffix: string): string {
  const barePath = `/tmp/dispatch-e2e-bare-${suffix}`;
  const repoPath = `/tmp/dispatch-e2e-repo-${suffix}`;
  rmSync(barePath, { recursive: true, force: true });
  rmSync(repoPath, { recursive: true, force: true });

  // Create a bare repo to act as "origin"
  mkdirSync(barePath, { recursive: true });
  execSync("git init --bare -b main", { cwd: barePath, stdio: "ignore" });

  // Clone it as the working repo
  execSync(`git clone "${barePath}" "${repoPath}"`, { stdio: "ignore" });
  execSync(
    'git config user.email "test@test.com" && git config user.name "Test"',
    {
      cwd: repoPath,
      stdio: "ignore",
    }
  );
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
    const output = execSync("git worktree list --porcelain", {
      cwd: repoPath,
      encoding: "utf-8",
    });
    for (const line of output.split("\n")) {
      if (line.startsWith("worktree ") && !line.includes(repoPath)) {
        const wtPath = line.replace("worktree ", "").trim();
        try {
          execSync(`git worktree remove --force "${wtPath}"`, {
            cwd: repoPath,
            stdio: "ignore",
          });
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

/** Unmount query owners, then drain the server's nonblocking catalog refresh. */
async function closeRepoConsumers(
  page: Page,
  request: APIRequestContext,
  repoPath: string
): Promise<void> {
  await page.goto("about:blank");
  await expect
    .poll(async () => {
      const response = await request.get(
        `/api/v1/personas?${new URLSearchParams({ cwd: repoPath, type: "task" })}`,
        { headers: authHeader }
      );
      expect(response.ok(), await response.text()).toBeTruthy();
      const catalog = await response.json();
      expect(typeof catalog.refreshing).toBe("boolean");
      if (!catalog.refreshing) {
        // The local origin must have published its catalog before removal.
        expect(catalog.updatedAt).toEqual(expect.any(Number));
      }
      return catalog.refreshing;
    })
    .toBe(false);
}

test.describe("Safe worktree archive", () => {
  let repoPath: string;
  test.beforeEach(() => {
    repoPath = createTestRepo(`${process.pid}-${Date.now()}`);
  });
  test.afterEach(async ({ page, request }) => {
    await cleanupE2EAgents(request);
    await closeRepoConsumers(page, request, repoPath);
    cleanupTestRepo(repoPath);
  });
  test("delete dialog shows worktree choice when agent has unmerged commits", async ({
    page,
    request,
  }, testInfo) => {
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

    await page.getByTestId(`agent-expand-toggle-${agent.id}`).click();
    await page.getByTestId(`agent-archive-${agent.id}`).click();

    // First step: standard archive confirmation
    await expect(page.getByTestId("delete-agent-confirm")).toBeVisible({
      timeout: 3_000,
    });
    await page.getByTestId("delete-agent-confirm").click();

    // Second step: worktree choice dialog should appear
    await expect(
      page.getByText("Worktree Has Outstanding Changes")
    ).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId("delete-agent-keep-worktree")).toBeVisible();
    await expect(page.getByTestId("delete-agent-force-worktree")).toBeVisible();

    // Choose "Leave worktree"
    const wtPath = agent.worktreePath!;
    await page.getByTestId("delete-agent-keep-worktree").click();

    // Agent should be removed from sidebar
    await expect(agentCard).not.toBeVisible({ timeout: 5_000 });

    // But worktree should still exist
    expect(existsSync(wtPath)).toBe(true);

    await testInfo.attach("worktree retained", {
      body: await page.screenshot(),
      contentType: "image/png",
    });

    // Clean up manually
    execSync(`git -C "${repoPath}" worktree remove --force "${wtPath}"`, {
      stdio: "ignore",
    });
  });
});
