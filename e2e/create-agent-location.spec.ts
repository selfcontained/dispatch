import { expect, test } from "@playwright/test";
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
  await page.goto("/agents?project=location-a", {
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
