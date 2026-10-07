import { execSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { test, expect } from "@playwright/test";
import {
  cleanupE2EAgents,
  clickAgentRow,
  createAgentViaAPI,
  loadApp,
  trackAgent,
} from "./helpers";

const authHeader = {
  Authorization: `Bearer ${process.env.AUTH_TOKEN ?? "dev-token"}`,
};

function createTestRepo(suffix: string): string {
  const barePath = `/tmp/dispatch-e2e-bare-${suffix}`;
  const repoPath = `/tmp/dispatch-e2e-repo-${suffix}`;
  rmSync(barePath, { recursive: true, force: true });
  rmSync(repoPath, { recursive: true, force: true });

  mkdirSync(barePath, { recursive: true });
  execSync("git init --bare -b main", { cwd: barePath, stdio: "ignore" });
  execSync(`git clone "${barePath}" "${repoPath}"`, { stdio: "ignore" });
  execSync(
    'git config user.email "test@test.com" && git config user.name "Test"',
    {
      cwd: repoPath,
      stdio: "ignore",
    }
  );
  writeFileSync(`${repoPath}/README.md`, "# test\n");
  execSync("git add -A && git commit -m 'initial' && git push origin main", {
    cwd: repoPath,
    stdio: "ignore",
  });

  return repoPath;
}

function cleanupTestRepo(repoPath: string): void {
  const barePath = repoPath.replace("-repo-", "-bare-");
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
    // Repo may already be gone.
  }

  rmSync(repoPath, { recursive: true, force: true });
  rmSync(barePath, { recursive: true, force: true });
}

test.describe("Agent base branch", () => {
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

  test("POST /api/v1/agents persists baseBranch", async ({ request }) => {
    const res = await request.post("/api/v1/agents", {
      headers: authHeader,
      data: { cwd: "/tmp", baseBranch: "feature/foo", useWorktree: false },
    });
    const body = (await res.json()) as {
      agent: { id: string; baseBranch: string | null };
    };
    trackAgent(body.agent.id);
    expect(body.agent.baseBranch).toBe("feature/foo");
  });

  test("POST /api/v1/agents defaults baseBranch to null", async ({
    request,
  }) => {
    const res = await request.post("/api/v1/agents", {
      headers: authHeader,
      data: { cwd: "/tmp", useWorktree: false },
    });
    const body = (await res.json()) as {
      agent: { id: string; baseBranch: string | null };
    };
    trackAgent(body.agent.id);
    expect(body.agent.baseBranch).toBeNull();
  });

  test("sidebar details show main when a worktree agent has no baseBranch", async ({
    page,
    request,
  }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-agent-${Date.now()}`,
      cwd: repoPath,
      useWorktree: true,
    });

    await loadApp(page);

    const agentCard = page.getByTestId(`agent-card-${agent.id}`);
    await expect(agentCard).toBeVisible({ timeout: 5_000 });

    await clickAgentRow(page, agent.id);

    await expect(agentCard.getByText("main", { exact: true })).toBeVisible({
      timeout: 10_000,
    });
    const visibleBranchSuffix = agent.worktreeBranch!.split("/").at(-1)!;
    await expect(
      agentCard.getByText(visibleBranchSuffix, { exact: true })
    ).toBeVisible();
  });
});
