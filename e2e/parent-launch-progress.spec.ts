import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  authHeaders,
  trackAgent,
  cleanupE2EAgents,
  clickAgentRow,
  createAgentViaAPI,
  loadApp,
} from "./helpers";

test.afterEach(async ({ request }) => {
  await cleanupE2EAgents(request);
});

for (const scope of ["root", "child"] as const) {
  for (const fail of [false, true]) {
    test(`${scope} launch reports real dependency install ${fail ? "failure" : "completion"}`, async ({
      page,
      request,
    }) => {
      const root = mkdtempSync(path.join(os.tmpdir(), "dispatch-launch-deps-"));
      const repo = path.join(root, "repo");
      mkdirSync(repo);
      mkdirSync(path.join(repo, "dependency"));
      writeFileSync(
        path.join(repo, "dependency/package.json"),
        JSON.stringify({
          name: "launch-local-dependency",
          version: "1.0.0",
          main: "index.js",
        })
      );
      writeFileSync(
        path.join(repo, "dependency/index.js"),
        "module.exports = 'installed';\n"
      );
      writeFileSync(
        path.join(repo, "package.json"),
        JSON.stringify({
          name: "launch-fixture",
          private: true,
          dependencies: { "launch-local-dependency": "file:dependency" },
          scripts: { postinstall: "node install.cjs" },
        })
      );
      writeFileSync(
        path.join(repo, "install.cjs"),
        `setTimeout(() => { ${fail ? "console.error('launch-install-fixture-failed'); process.exit(1);" : "require('node:fs').writeFileSync('deps-installed.txt', require('launch-local-dependency'));"} }, 2000);\n`
      );
      writeFileSync(
        path.join(repo, ".gitignore"),
        "node_modules\ndeps-installed.txt\n.env\n"
      );
      execFileSync(
        "npm",
        [
          "install",
          "--package-lock-only",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
        ],
        { cwd: repo, stdio: "ignore" }
      );
      execFileSync("git", ["init", "-b", "main"], {
        cwd: repo,
        stdio: "ignore",
      });
      execFileSync("git", ["add", "."], { cwd: repo });
      execFileSync(
        "git",
        [
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.com",
          "commit",
          "-m",
          "fixture",
        ],
        { cwd: repo, stdio: "ignore" }
      );
      writeFileSync(path.join(repo, ".env"), "LAUNCH_CONFIG=copied\n");
      let worktree: string | null = null;
      try {
        const parent =
          scope === "child" ? await createAgentViaAPI(request) : null;
        if (parent) {
          await loadApp(page);
          await clickAgentRow(page, parent.id);
        }
        const response = await request.post("/api/v1/agents", {
          headers: authHeaders(),
          data: {
            name: `e2e-agent-${scope}-deps-${Date.now()}`,
            type: "codex",
            ...(parent ? { parentAgentId: parent.id } : {}),
            cwd: repo,
            useWorktree: true,
            initialPrompt: "Validate managed worktree preparation.",
          },
        });
        expect(response.status()).toBe(201);
        let child = (await response.json()).agent;
        trackAgent(child.id);
        if (!parent) {
          await loadApp(page);
          await clickAgentRow(page, child.id);
        }
        const card = page.getByTestId(
          scope === "root" ? "chat-launch-card" : "chat-compact-launch"
        );
        const progress = card.getByTestId("chat-launch-startup");
        await expect(progress).toContainText(
          "Installing dependencies · In progress"
        );
        await expect
          .poll(
            async () => {
              child = (
                await (
                  await request.get(`/api/v1/agents/${child.id}`, {
                    headers: authHeaders(),
                  })
                ).json()
              ).agent;
              return child.status;
            },
            { timeout: 30_000 }
          )
          .toBe("running");
        worktree = child.worktreePath;
        expect(child.status).toBe("running");
        expect(worktree).toBeTruthy();
        await expect(progress).toContainText(
          fail ? "Started with warnings" : "Started"
        );
        await expect(progress.locator("li")).toHaveCount(4);
        expect(
          await progress
            .locator("li")
            .evaluateAll((rows) =>
              rows.map((row) => row.getAttribute("data-startup-phase"))
            )
        ).toEqual(["worktree", "env", "deps", "session"]);
        expect(readFileSync(path.join(worktree!, ".env"), "utf8")).toContain(
          "LAUNCH_CONFIG=copied"
        );
        expect(
          existsSync(
            path.join(worktree!, "node_modules/launch-local-dependency")
          )
        ).toBe(true);
        if (fail) {
          await expect(progress).toContainText("launch-install-fixture-failed");
          await expect(
            progress.locator('[data-startup-phase="deps"]')
          ).toHaveAttribute("data-startup-status", "failed");
        } else {
          expect(
            readFileSync(path.join(worktree!, "deps-installed.txt"), "utf8")
          ).toBe("installed");
          await expect(progress).toContainText("npm install completed");
        }
        if (scope === "child") {
          await card.getByTestId("launch-open-thread").click();
          await expect(page.getByTestId("chat-thread-panel")).toContainText(
            "Validate managed worktree preparation."
          );
          await page
            .getByRole("button", { name: "Close", exact: true })
            .click();
          await expect(page.getByTestId("chat-thread-panel")).not.toBeVisible();
        } else {
          await expect(card).toContainText(
            "Validate managed worktree preparation."
          );
          await page.reload({ waitUntil: "domcontentloaded" });
          await expect(
            page
              .getByTestId("chat-launch-card")
              .getByTestId("chat-launch-startup")
          ).toContainText(
            fail ? "Started with warnings" : "npm install completed"
          );
        }
      } finally {
        if (worktree) rmSync(worktree, { recursive: true, force: true });
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
}

test("root launch records and persists a failed worktree phase", async ({
  page,
  request,
}) => {
  const repo = mkdtempSync(
    path.join(os.tmpdir(), "dispatch-launch-worktree-error-")
  );
  try {
    execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
    writeFileSync(path.join(repo, "README.md"), "fixture");
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "-m",
        "fixture",
      ],
      { cwd: repo, stdio: "ignore" }
    );
    const response = await request.post("/api/v1/agents", {
      headers: authHeaders(),
      data: {
        name: `e2e-agent-worktree-error-${Date.now()}`,
        type: "codex",
        cwd: repo,
        useWorktree: true,
        worktreeBranch: "main",
      },
    });
    expect(response.status()).toBe(201);
    const { agent } = await response.json();
    trackAgent(agent.id);
    await expect
      .poll(
        async () =>
          (
            await (
              await request.get(`/api/v1/agents/${agent.id}`, {
                headers: authHeaders(),
              })
            ).json()
          ).agent.status
      )
      .toBe("stopped");
    await loadApp(page);
    await clickAgentRow(page, agent.id);
    const progress = page
      .getByTestId("chat-launch-card")
      .getByTestId("chat-launch-startup");
    await expect(progress).toContainText("Startup failed");
    await expect(progress).toContainText("Worktree creation failed");
    await expect(
      progress.locator('[data-startup-phase="worktree"]')
    ).toHaveAttribute("data-startup-status", "failed");
    await expect(
      progress.locator('[data-startup-status="running"]')
    ).toHaveCount(0);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(progress).toContainText("Startup failed");
    await expect(
      progress.locator('[data-startup-phase="worktree"]')
    ).toHaveAttribute("data-startup-status", "failed");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
