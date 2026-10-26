import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  authHeaders,
  cleanupE2EAgents,
  clickAgentRow,
  createAgentViaAPI,
  deleteAgentViaAPI,
  trackAgent,
} from "./helpers";

test.use({ deviceScaleFactor: 2 });

for (const mobile of [false, true]) {
  test(`last agent chat restores by scope on ${mobile ? "mobile" : "desktop"}`, async ({
    page,
    request,
  }) => {
    test.setTimeout(90_000);
    const roots: string[] = [];
    const projects: { id: string; name: string }[] = [];
    const headers = authHeaders();
    const screenshot = `/tmp/dispatch-agent-memory-${mobile ? "mobile" : "desktop"}.png`;
    async function sidebar() {
      if (
        mobile &&
        (await page.getByTitle("Open sidebar", { exact: true }).isVisible())
      )
        await page.getByTitle("Open sidebar", { exact: true }).click();
    }
    async function section(name: string) {
      await sidebar();
      await page.getByTestId(`${name}-button`).click();
    }
    async function choose(name: string) {
      await sidebar();
      await page.getByRole("button", { name: "Filter by project" }).click();
      await page.getByRole("menuitem", { name, exact: true }).click();
    }
    async function selected(id: string) {
      await expect(page).toHaveURL(new RegExp(`/agents/${id}(\\?|$)`));
      await expect(page.getByTestId("chat-composer-input")).toBeVisible();
    }
    async function empty() {
      await expect(page.getByTestId("chat-empty")).toBeVisible();
      expect(new URL(page.url()).pathname).toBe("/agents");
    }
    async function memory(scope: string | null) {
      return page.evaluate(
        (scope) =>
          localStorage.getItem(
            `dispatch:lastAgentId:${scope === null ? "all" : `project:${scope}`}`
          ),
        scope
      );
    }
    try {
      for (const label of ["Alpha", "Beta"]) {
        const root = mkdtempSync(join(tmpdir(), "dispatch-memory-"));
        roots.push(root);
        execFileSync("git", ["init", root]);
        const response = await request.post("/api/v1/projects", {
          headers,
          data: {
            name: `${label}-${Date.now()}`,
            repoRoot: root,
            color: "#9575ed",
          },
        });
        expect(response.ok(), await response.text()).toBeTruthy();
        projects.push(await response.json());
      }
      async function projectAgent(projectId: string, name: string) {
        const response = await request.post("/api/v1/agents", {
          headers,
          data: { projectId, name, type: "codex", useWorktree: false },
        });
        expect(response.ok(), await response.text()).toBeTruthy();
        const { agent } = await response.json();
        trackAgent(agent.id);
        return agent as { id: string; name: string };
      }
      const a = await projectAgent(projects[0]!.id, "e2e-memory-alpha");
      const explicit = await projectAgent(
        projects[0]!.id,
        "e2e-memory-explicit"
      );
      const b = await projectAgent(projects[1]!.id, "e2e-memory-beta");
      const all = await createAgentViaAPI(request, { name: "e2e-memory-all" });
      await page.setViewportSize(
        mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }
      );
      await page.goto(`/agents?project=${projects[0]!.id}`, {
        waitUntil: "domcontentloaded",
      });
      if (mobile) {
        // Bare Agents opens the list after the initial agent query resolves.
        // Wait for that concrete state rather than racing its auto-open effect.
        await expect(
          page.getByRole("dialog", { name: "Navigation sidebar" })
        ).toHaveClass(/translate-x-0/);
      }
      await clickAgentRow(page, a.id);
      await selected(a.id);
      await expect
        .poll(() => memory(projects[0]!.id))
        .toBe(JSON.stringify(a.id));
      await section("tasks");
      await expect(page).toHaveURL(/\/tasks\?/);
      await section("agents");
      await selected(a.id);
      if (mobile)
        await expect(
          page.getByTitle("Open sidebar", { exact: true })
        ).toBeVisible();

      await page.screenshot({ path: screenshot });
      await test.info().attach("section-restored-chat", {
        path: screenshot,
        contentType: "image/png",
      });

      // A return always lands on plain chat, even after a tab/deep link.
      for (const tab of ["files", "changes"]) {
        await page.goto(
          `/agents/${a.id}/${tab}?project=${projects[0]!.id}${mobile ? "" : "&thread=missing"}`,
          { waitUntil: "domcontentloaded" }
        );
        await section("settings");
        await expect(page).toHaveURL(/\/settings$/);
        await section("agents");
        await selected(a.id);
        expect(new URL(page.url()).pathname).toBe(`/agents/${a.id}`);
        expect(new URL(page.url()).searchParams.has("thread")).toBe(false);
      }
      await page.reload({ waitUntil: "domcontentloaded" });
      await selected(a.id);
      await section("tasks");
      // A browser history command can run before React commits the click's
      // navigation. Observe the entry we intend to go back from first.
      await expect(page).toHaveURL(/\/tasks\?/);
      await page.goBack();
      await selected(a.id);
      await page.goForward();
      await expect(page).toHaveURL(/\/tasks\?/);
      await section("agents");
      await selected(a.id);

      await choose(projects[1]!.name);
      await empty(); // PR #1307 immediate clearing, without auto-restoration.
      await clickAgentRow(page, b.id);
      await selected(b.id);
      await expect
        .poll(() => memory(projects[1]!.id))
        .toBe(JSON.stringify(b.id));
      await choose("All projects");
      await sidebar();
      await clickAgentRow(page, all.id);
      await selected(all.id);
      await expect.poll(() => memory(null)).toBe(JSON.stringify(all.id));
      await choose(projects[0]!.name);
      await empty();
      await section("tasks");
      await section("agents");
      await selected(a.id);
      // A→All keeps the current URL but must preserve All's own memory.
      await choose("All projects");
      await expect.poll(() => memory(null)).toBe(JSON.stringify(all.id));
      await section("settings");
      await section("agents");
      await selected(all.id);
      await choose(projects[1]!.name);
      await empty();
      await section("tasks");
      await section("agents");
      await selected(b.id);

      // Clicking the selected row is the existing explicit Close action.
      await sidebar();
      await clickAgentRow(page, b.id);
      await empty();
      await expect.poll(() => memory(projects[1]!.id)).toBe("null");
      await section("tasks");
      await section("agents");
      await empty();
      // Close the mobile list to show the empty pane in the evidence.
      if (mobile) {
        const navigationSheet = page.getByRole("dialog", {
          name: "Navigation sidebar",
        });
        await navigationSheet
          .getByTitle("Close sidebar", { exact: true })
          .click();
        await expect(navigationSheet).not.toBeInViewport();
      }
      const emptyScreenshot = screenshot.replace(".png", "-empty.png");
      await page.screenshot({ path: emptyScreenshot });
      await test.info().attach("explicit-empty", {
        path: emptyScreenshot,
        contentType: "image/png",
      });
      await sidebar();
      await clickAgentRow(page, b.id);
      await selected(b.id);
      await section("settings");
      await deleteAgentViaAPI(request, b.id);
      // Reload on another section proves persisted stale IDs are checked
      // against the live list before any pane can open.
      await page.reload({ waitUntil: "domcontentloaded" });
      await section("agents");
      await empty();
      await expect.poll(() => memory(projects[1]!.id)).toBe("null");

      // Bare mounts stay detached; an explicit different URL wins over memory.
      await page.goto(`/agents?project=${projects[0]!.id}`, {
        waitUntil: "domcontentloaded",
      });
      await empty();
      await page.reload({ waitUntil: "domcontentloaded" });
      await empty();
      await page.goto(`/agents/${explicit.id}?project=${projects[0]!.id}`, {
        waitUntil: "domcontentloaded",
      });
      await selected(explicit.id);
      await expect
        .poll(() => memory(projects[0]!.id))
        .toBe(JSON.stringify(explicit.id));
      await section("settings");
      await section("agents");
      await selected(explicit.id);
    } finally {
      await cleanupE2EAgents(request);
      for (const project of projects)
        await request.delete(`/api/v1/projects/${project.id}`, { headers });
      for (const root of roots) rmSync(root, { recursive: true, force: true });
    }
  });
}
