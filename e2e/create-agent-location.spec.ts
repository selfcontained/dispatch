import { expect, test } from "@playwright/test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadApp } from "./helpers";

// Project data is controlled here; actual launch payloads are asserted before
// returning an intentional error so this preference test never starts agents.
test("launch location recalls both modes and selected project across navigation and reload", async ({
  page,
}) => {
  let projects = [
    {
      id: "location-a",
      name: "Location A",
      repoRoot: "/tmp",
      updatedAt: "2026-10-01",
    },
    {
      id: "location-b",
      name: "Location B",
      repoRoot: "/",
      updatedAt: "2026-10-01",
    },
  ];
  await page.route("**/api/v1/projects", async (route) => {
    await route.fulfill({ json: projects });
  });
  await loadApp(page);
  await page.goto("/agents?project=location-a", {
    waitUntil: "domcontentloaded",
  });
  const open = async () => page.getByTestId("create-agent-button").click();
  const location = page.getByTestId("project-location");
  await open();
  await expect(
    location.getByRole("button", { name: "Project", exact: true })
  ).toHaveAttribute("aria-pressed", "true");
  await location.getByRole("button", { name: "Choose project" }).click();
  await page.getByRole("menuitem").filter({ hasText: "Location B" }).click();
  await page.getByTestId("create-agent-cancel").click();
  // A concrete sidebar scope wins on each opening; remembered location is
  // the fallback specifically in All projects.
  await page.goto("/agents?project=", { waitUntil: "domcontentloaded" });
  await open();
  await expect(
    location.getByRole("button", { name: "Choose project" })
  ).toContainText("Location B");
  await page.reload({ waitUntil: "domcontentloaded" });
  await open();
  await expect(
    location.getByRole("button", { name: "Choose project" })
  ).toContainText("Location B");
  await location.getByRole("button", { name: "Folder", exact: true }).click();
  await expect(page.getByTestId("create-agent-cwd")).toBeVisible();
  await page.getByTestId("create-agent-cancel").click();
  await page.goto("/agents?project=", {
    waitUntil: "domcontentloaded",
  });
  await open();
  await expect(
    location.getByRole("button", { name: "Folder", exact: true })
  ).toHaveAttribute("aria-pressed", "true");
  await page.reload({ waitUntil: "domcontentloaded" });
  await open();
  await expect(
    location.getByRole("button", { name: "Folder", exact: true })
  ).toHaveAttribute("aria-pressed", "true");
  await location.getByRole("button", { name: "Project", exact: true }).click();
  await expect(
    location.getByRole("button", { name: "Choose project" })
  ).toContainText("Location B");
  await page.getByTestId("create-agent-cancel").click();
  projects = projects.slice(0, 1);
  await page.reload({ waitUntil: "domcontentloaded" });
  await open();
  await expect(
    location.getByRole("button", { name: "Folder", exact: true })
  ).toHaveAttribute("aria-pressed", "true");
  let payload: Record<string, unknown> | undefined;
  await page.route("**/api/v1/agents", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    payload = route.request().postDataJSON();
    await route.fulfill({
      status: 400,
      json: { error: "Preference payload captured" },
    });
  });
  await page.getByTestId("create-agent-submit").click();
  await expect.poll(() => payload).toBeTruthy();
  expect(payload).not.toHaveProperty("projectId");
  expect(payload).toHaveProperty("cwd");
});

for (const mobile of [false, true]) {
  test(`Create follows sidebar project on ${mobile ? "mobile" : "desktop"} and permits a manual override`, async ({
    page,
  }) => {
    const projects = [
      {
        id: "sidebar-create-a",
        name: "Sidebar Create A",
        repoRoot: "/tmp",
        updatedAt: "2026-10-01",
      },
      {
        id: "sidebar-create-b",
        name: "Sidebar Create B",
        repoRoot: "/",
        updatedAt: "2026-10-01",
      },
    ];
    await page.route("**/api/v1/projects", (route) =>
      route.fulfill({ json: projects })
    );
    // This test must remain inert even if a mistaken interaction hits Submit.
    let launches = 0;
    await page.route("**/api/v1/agents", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      launches++;
      await route.fulfill({
        status: 400,
        json: { error: "No launches in sidebar Create regression" },
      });
    });
    await page.addInitScript(() => {
      localStorage.setItem(
        "dispatch:createAgentLocation",
        JSON.stringify({ mode: "project", projectId: "sidebar-create-b" })
      );
      localStorage.setItem("dispatch:lastUsedAgentCwd", "/viewed/c");
    });
    await page.setViewportSize(
      mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }
    );
    await page.goto("/agents?project=", { waitUntil: "domcontentloaded" });
    async function sidebar() {
      if (!mobile) return;
      const sheet = page.getByRole("dialog", { name: "Navigation sidebar" });
      const open = page.getByTitle("Open sidebar", { exact: true });
      const close = sheet
        .and(page.locator(".translate-x-0"))
        .getByTitle("Close sidebar", { exact: true });
      await expect(open.or(close)).toBeVisible();
      if (await open.isVisible()) await open.click();
      await expect(sheet).toBeInViewport({ ratio: 1 });
    }
    async function chooseSidebar(name: string) {
      await sidebar();
      await page.getByRole("button", { name: "Filter by project" }).click();
      await page.getByRole("menuitem", { name, exact: true }).click();
    }
    async function openCreate() {
      await sidebar();
      await page.getByTestId("create-agent-button").click();
      await expect(
        page.getByRole("dialog", { name: "Create Agent" })
      ).toBeVisible();
    }
    const location = page.getByTestId("project-location");
    async function selected(index: number) {
      await expect(
        location.getByRole("button", { name: "Choose project" })
      ).toContainText(projects[index]!.name);
      await expect(
        location.getByTitle(projects[index]!.repoRoot, { exact: true })
      ).toBeVisible();
      await expect(page.getByTestId("create-agent-cwd")).toHaveValue(
        projects[index]!.repoRoot
      );
    }
    await chooseSidebar(projects[0]!.name);
    await openCreate();
    await selected(0);
    await page.getByTestId("create-agent-cancel").click();
    await chooseSidebar(projects[1]!.name);
    await openCreate();
    await selected(1);
    await location.getByRole("button", { name: "Choose project" }).click();
    await page
      .getByRole("menuitem")
      .filter({ hasText: projects[0]!.name })
      .click();
    await selected(0);
    const screenshot = join(
      await mkdtemp(join(tmpdir(), "dispatch-sidebar-create-")),
      `${mobile ? "mobile" : "desktop"}.png`
    );
    await page.screenshot({ path: screenshot });
    await test.info().attach("sidebar-create-manual-override", {
      path: screenshot,
      contentType: "image/png",
    });
    await page.getByTestId("create-agent-cancel").click();
    expect(launches).toBe(0);
  });
}
