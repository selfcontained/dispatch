import { test, expect } from "@playwright/test";
import { loadApp, trackAgent, cleanupE2EAgents } from "./helpers";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

test.describe("Create agent dialog", () => {
  test("task persona sessions retain normal role and lifecycle controls", async ({
    page,
    request,
  }) => {
    const directory = mkdtempSync(
      path.join(os.tmpdir(), "dispatch-task-persona-e2e-")
    );
    const personas = path.join(directory, ".agents/personas");
    mkdirSync(personas, { recursive: true });
    writeFileSync(
      path.join(personas, "builder.md"),
      "---\ntype: task\nname: Builder\ndescription: Build tasks\n---\nImplement the task."
    );
    try {
      await loadApp(page);
      await page.getByTestId("create-agent-button").click();
      await page.getByTestId("create-agent-cwd").fill(directory);
      await page.getByTestId("create-agent-name").click();
      await page
        .getByRole("combobox", { name: "Persona", exact: true })
        .click();
      await page.getByRole("option", { name: "Builder", exact: true }).click();
      const response = page.waitForResponse(
        (r) =>
          r.url().endsWith("/api/v1/agents") && r.request().method() === "POST"
      );
      await page.getByTestId("create-agent-submit").click();
      const body = await (await response).json();
      const agent = body.agent;
      trackAgent(agent.id);
      expect(agent.role).toBe("standard");
      expect(agent.persona).toBe("builder");
      await page.getByTestId(`agent-expand-toggle-${agent.id}`).click();
      const card = page.getByTestId(`agent-card-${agent.id}`);
      await expect(
        card.getByRole("button", { name: "Archive", exact: true })
      ).toBeVisible();
      await expect(
        card.getByRole("button", { name: "Session details", exact: true })
      ).toBeVisible();
      await expect(
        page.getByTestId(`agent-prompt-rename-${agent.id}`)
      ).toBeVisible();
    } finally {
      await cleanupE2EAgents(request);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("personas follow the selected directory without setting the session name", async ({
    page,
  }) => {
    await page.route("**/api/v1/personas?*", async (route) => {
      const cwd = new URL(route.request().url()).searchParams.get("cwd");
      await route.fulfill({
        json: {
          personas:
            cwd === "/tmp"
              ? [
                  {
                    slug: "builder",
                    name: "Builder",
                    description: "Build focused changes.",
                  },
                ]
              : [],
        },
      });
    });
    await loadApp(page);
    await page.getByTestId("create-agent-button").click();
    const cwd = page.getByTestId("create-agent-cwd");
    const name = page.getByTestId("create-agent-name");
    const persona = page.getByRole("combobox", {
      name: "Persona",
      exact: true,
    });
    await cwd.fill("/tmp");
    await name.click();
    await persona.click();
    await page.getByRole("option", { name: "Builder", exact: true }).click();
    await expect(name).toHaveValue("");
    await cwd.fill("/");
    await name.click();
    await expect(persona).toContainText("None");
    await expect(name).toHaveValue("");
    await cwd.fill("/tmp");
    await name.click();
    await expect(persona).toContainText("Builder");
    await expect(name).toHaveValue("");
    await name.fill("My task");
    await persona.click();
    await page.getByRole("option", { name: "None", exact: true }).click();
    await expect(name).toHaveValue("My task");
    await persona.click();
    await page.getByRole("option", { name: "Builder", exact: true }).click();
    await expect(name).toHaveValue("My task");
    await page.getByTestId("create-agent-cancel").click();
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("create-agent-button").click();
    await cwd.fill("/tmp");
    await name.click();
    await expect(persona).toContainText("Builder");
    await expect(name).toHaveValue("");
  });

  test("full access defaults on and remembers an explicit off choice", async ({
    page,
  }) => {
    await loadApp(page);
    await page.getByTestId("create-agent-button").click();
    const fullAccess = page.getByRole("checkbox", {
      name: /Start in full access mode/,
    });
    await expect(fullAccess).toHaveAttribute("aria-checked", "true");
    await page.getByTestId("create-agent-cwd").fill("/tmp");
    // Close the directory suggestions so they can't cover the checkbox.
    await page.getByTestId("create-agent-name").click();
    await expect(fullAccess).toHaveAttribute("aria-checked", "true");
    await fullAccess.click();
    await expect(fullAccess).toHaveAttribute("aria-checked", "false");
    await page.getByTestId("create-agent-cancel").click();
    await page.getByTestId("create-agent-button").click();
    await page.getByTestId("create-agent-cwd").fill("/tmp");
    await expect(fullAccess).toHaveAttribute("aria-checked", "false");
  });

  test("defaults the working directory to a non-empty value", async ({
    page,
  }) => {
    await loadApp(page);

    await page.getByTestId("create-agent-button").click();
    const form = page.getByTestId("create-agent-form");
    await expect(form).toBeVisible();

    const cwdValue = await form.getByTestId("create-agent-cwd").inputValue();
    expect(cwdValue.length).toBeGreaterThan(0);
  });

  test("agent type dropdown opens and allows selection", async ({ page }) => {
    await loadApp(page);

    // Open the create dialog
    await page.getByTestId("create-agent-button").click();
    const form = page.getByTestId("create-agent-form");
    await expect(form).toBeVisible();

    // The type select should default to "Claude" (first alphabetically)
    const typeTrigger = form.getByRole("combobox").first();
    await expect(typeTrigger).toContainText("Claude");

    // Click to open the dropdown
    await typeTrigger.click();

    // The dropdown options should be visible
    const codexOption = page.getByRole("option", { name: "Codex" });
    await expect(codexOption).toBeVisible({ timeout: 3_000 });

    // Select "Codex"
    await codexOption.click();

    // The trigger should now show "Codex"
    await expect(typeTrigger).toContainText("Codex");

    // Close dialog
    await page.getByTestId("create-agent-cancel").click();
    await expect(form).not.toBeVisible({ timeout: 3_000 });
  });

  test("recent directories filter by typed project name or path", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem(
        "dispatch:cwdHistory",
        JSON.stringify(["/tmp/existing-project", "/home/user/projects/myapp"])
      );
    });

    await loadApp(page);

    await page.getByTestId("create-agent-button").click();
    const form = page.getByTestId("create-agent-form");
    await expect(form).toBeVisible();

    const cwdInput = form.getByTestId("create-agent-cwd");
    await cwdInput.fill("myapp");
    const recentOptions = form.getByTestId("create-agent-cwd-history-option");

    await expect(recentOptions).toHaveCount(1);
    await expect(recentOptions.first()).toContainText("myapp");
    await expect(cwdInput).toHaveValue("myapp");

    await cwdInput.press("ArrowDown");
    await expect(recentOptions.first()).toHaveAttribute(
      "data-selected",
      "true"
    );
    await cwdInput.press(" ");
    await expect(cwdInput).toHaveValue("myapp ");

    await cwdInput.fill("myapp");
    await expect(recentOptions.first()).toHaveAttribute(
      "data-selected",
      "true"
    );
    await cwdInput.press("Enter");
    await expect(cwdInput).toHaveValue("/home/user/projects/myapp");

    await cwdInput.fill("/tmp");
    await expect(
      recentOptions.filter({ hasText: "/tmp/existing-project" })
    ).toBeVisible();
  });

  test("selecting a directory closes the picker at mobile width", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(() => {
      window.localStorage.setItem(
        "dispatch:cwdHistory",
        JSON.stringify(["/tmp/mobile-project"])
      );
    });
    await loadApp(page);
    await page.getByTestId("create-agent-button").click();
    const input = page.getByTestId("create-agent-cwd");
    await input.click();
    const option = page
      .getByTestId("create-agent-cwd-history-option")
      .filter({ hasText: "/tmp/mobile-project" });
    await expect(option).toBeVisible();
    await option.click();
    await expect(input).toHaveValue("/tmp/mobile-project");
    await expect(
      page.getByTestId("create-agent-cwd-history-option")
    ).toHaveCount(0);
  });
});
