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
import { expect, test, type Page } from "@playwright/test";
import {
  authHeaders,
  trackAgent,
  cleanupE2EAgents,
  clickAgentRow,
  createAgentViaAPI,
  loadApp,
} from "./helpers";

async function checkChildStartupThread(
  page: Page,
  label: string,
  detail: string
) {
  const card = page.getByTestId("chat-compact-launch").first();
  const panel = page.locator('[data-testid="chat-thread-panel"]:visible');
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(card.getByTestId("chat-launch-startup")).toHaveCount(0);
    await expect(card).not.toContainText(detail);
    const note = card.getByTestId(
      width === 390 ? "launch-open-thread-mobile" : "launch-startup-note"
    );
    await expect(note).toContainText(label);
    await note.click();
    const progress = panel.getByTestId("chat-launch-startup");
    await expect(progress).toBeVisible();
    await progress.getByTestId("harness-activity-summary").click();
    await progress.getByRole("button", { name: /, failed$/ }).click();
    await expect(progress.getByTestId("harness-plain")).toContainText(detail);
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await expect(panel).not.toBeVisible();
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(note).toContainText(label);
  }
}

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
        `setTimeout(() => { ${fail ? "console.error('launch-install-fixture-failed: ' + 'Long dependency diagnostic with package registry and workspace context. '.repeat(8) + ' diagnostic-tail-visible-on-touch'); process.exit(1);" : "require('node:fs').writeFileSync('deps-installed.txt', require('launch-local-dependency'));"} }, 2000);\n`
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
        if (scope === "root") {
          await progress.getByTestId("harness-activity-summary").click();
          await expect(
            progress
              .getByTestId("harness-step")
              .filter({ hasText: "installing dependencies" })
          ).toBeVisible();
        } else {
          await expect(progress).toHaveCount(0);
          await expect(card).toContainText("Launched");
          await expect(card).not.toContainText("Launching");
        }
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
        if (scope === "root") {
          await expect(
            progress.getByTestId("harness-activity-summary")
          ).toContainText(fail ? "Started with warnings" : "Started");
          await expect(progress.getByTestId("harness-step")).toHaveCount(4);
          await expect(progress.getByRole("listitem")).toHaveText([
            /creating git worktree/,
            /copying local config/,
            /installing dependencies/,
            /starting/,
          ]);
        }
        expect(readFileSync(path.join(worktree!, ".env"), "utf8")).toContain(
          "LAUNCH_CONFIG=copied"
        );
        expect(
          existsSync(
            path.join(worktree!, "node_modules/launch-local-dependency")
          )
        ).toBe(true);
        if (fail) {
          if (scope === "root") {
            await expect(progress).toContainText(
              "launch-install-fixture-failed"
            );
            await expect(
              progress.getByLabel("installing dependencies, failed", {
                exact: true,
              })
            ).toBeVisible();
            await page.setViewportSize({ width: 390, height: 844 });
            const diagnosticStep = progress.getByRole("button", {
              name: "installing dependencies, failed",
              exact: true,
            });
            await diagnosticStep.click();
            await expect(diagnosticStep).toHaveAttribute(
              "aria-expanded",
              "true"
            );
            await expect(
              progress.getByTestId("harness-plain").locator("pre")
            ).toContainText("diagnostic-tail-visible-on-touch");
            await expect(
              progress.getByTestId("harness-plain").locator("pre")
            ).toContainText(
              "Long dependency diagnostic with package registry and workspace context."
            );
            expect(
              await page.evaluate(
                () => document.documentElement.scrollWidth <= innerWidth
              )
            ).toBe(true);
            await diagnosticStep.click();
            await expect(diagnosticStep).toHaveAttribute(
              "aria-expanded",
              "false"
            );
            await expect(progress.getByTestId("harness-plain")).toHaveCount(0);
          }
        } else {
          expect(
            readFileSync(path.join(worktree!, "deps-installed.txt"), "utf8")
          ).toBe("installed");
          if (scope === "root")
            await expect(progress).toContainText("npm install completed");
        }
        if (scope === "child") {
          if (fail) {
            await checkChildStartupThread(
              page,
              "Started with warnings",
              "launch-install-fixture-failed"
            );
            await page.setViewportSize({ width: 1280, height: 900 });
          }
          await expect(progress).toHaveCount(0);
          await card.getByTestId("launch-open-thread").click();
          await expect(page.getByTestId("chat-thread-panel")).toContainText(
            "Validate managed worktree preparation."
          );
          await expect(
            page
              .getByTestId("chat-thread-panel")
              .getByTestId("chat-launch-startup")
          ).toHaveCount(fail ? 1 : 0);
          await expect(page.getByTestId("chat-thread-panel")).not.toContainText(
            "Launching"
          );
          await page
            .getByRole("button", { name: "Close", exact: true })
            .click();
          await expect(page.getByTestId("chat-thread-panel")).not.toBeVisible();
        } else {
          await expect(card).toContainText(
            "Validate managed worktree preparation."
          );
          await progress.getByTestId("harness-activity-summary").click();
          await expect(
            progress.getByTestId("harness-activity-summary")
          ).toHaveAttribute("aria-expanded", "false");
          await progress.getByTestId("harness-activity-summary").click();
          await page.reload({ waitUntil: "domcontentloaded" });
          await expect(
            page
              .getByTestId("chat-launch-card")
              .getByTestId("chat-launch-startup")
          ).toContainText(fail ? "Started with warnings" : "Started");
        }
      } finally {
        if (worktree) rmSync(worktree, { recursive: true, force: true });
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
}

for (const scope of ["root", "child"] as const) {
  test(`${scope} launch records and persists a failed worktree phase`, async ({
    page,
    request,
  }) => {
    const repo = mkdtempSync(
      path.join(os.tmpdir(), "dispatch-launch-worktree-error-")
    );
    try {
      execFileSync("git", ["init", "-b", "main"], {
        cwd: repo,
        stdio: "ignore",
      });
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
      const parent =
        scope === "child" ? await createAgentViaAPI(request) : null;
      const response = await request.post("/api/v1/agents", {
        headers: authHeaders(),
        data: {
          ...(parent ? { parentAgentId: parent.id } : {}),
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
      await clickAgentRow(page, parent?.id ?? agent.id);
      if (scope === "child") {
        await checkChildStartupThread(
          page,
          "Launch error",
          "Worktree creation failed"
        );
      } else {
        const progress = page
          .getByTestId(
            scope === "root" ? "chat-launch-card" : "chat-compact-launch"
          )
          .getByTestId("chat-launch-startup");
        await expect(progress).toContainText("failed");
        await progress.getByTestId("harness-activity-summary").click();
        await expect(progress).toContainText("Worktree creation failed");
        await expect(
          progress.getByLabel("creating git worktree, failed", { exact: true })
        ).toBeVisible();
        await expect(progress.locator('[aria-label$=", running"]')).toHaveCount(
          0
        );
        await page.reload({ waitUntil: "domcontentloaded" });
        await expect(progress).toContainText("failed");
        await progress.getByTestId("harness-activity-summary").click();
        await expect(
          progress.getByLabel("creating git worktree, failed", { exact: true })
        ).toBeVisible();
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
}
