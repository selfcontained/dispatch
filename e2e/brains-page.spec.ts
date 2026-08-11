import { expect, test, type Page } from "@playwright/test";
import { Pool } from "pg";

import { loadApp } from "./helpers";

const REPO_ROOT = "/tmp/e2e-brains-page-test";
const AGENT_ID = "e2e-brains-page-agent";

async function seedBrainData(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required to seed brain data.");
  }

  const pool = new Pool({ connectionString, max: 1 });
  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      await client.query(
        `INSERT INTO brain_objects (repo_root, collection, name, value, revision, created_by_agent_id, updated_by_agent_id)
         VALUES ($1, 'config', 'app-settings', '{"theme":"dark","lang":"en"}'::jsonb, 1, $2, $2),
                ($1, 'state', 'build-status', '{"passing":true}'::jsonb, 1, $2, $2),
                ($1, 'config', 'deploy-targets', '{"prod":"us-east-1"}'::jsonb, 1, $2, $2)
         ON CONFLICT (repo_root, collection, name) DO NOTHING`,
        [REPO_ROOT, AGENT_ID]
      );

      await client.query(
        `INSERT INTO brain_lists (repo_root, collection, name, revision, created_by_agent_id, updated_by_agent_id)
         VALUES ($1, 'state', 'task-queue', 1, $2, $2)
         ON CONFLICT (repo_root, collection, name) DO NOTHING`,
        [REPO_ROOT, AGENT_ID]
      );
      await client.query(
        `INSERT INTO brain_list_items (repo_root, collection, name, item_index, value)
         VALUES ($1, 'state', 'task-queue', 0, '{"task":"lint"}'::jsonb),
                ($1, 'state', 'task-queue', 1, '{"task":"test"}'::jsonb),
                ($1, 'state', 'task-queue', 2, '{"task":"deploy"}'::jsonb)
         ON CONFLICT (repo_root, collection, name, item_index) DO NOTHING`,
        [REPO_ROOT]
      );

      await client.query(
        `INSERT INTO brain_events (id, repo_root, collection, kind, subject, tags, value, agent_id)
         VALUES (gen_random_uuid(), $1, 'ci', 'build', 'main', ARRAY['passing'], '{"duration":42}'::jsonb, $2),
                (gen_random_uuid(), $1, 'ci', 'deploy', 'staging', ARRAY[]::text[], '{"env":"staging"}'::jsonb, $2)`,
        [REPO_ROOT, AGENT_ID]
      );

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

async function cleanupBrainData(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) return;

  const pool = new Pool({ connectionString, max: 1 });
  try {
    await pool.query("DELETE FROM brain_list_items WHERE repo_root = $1", [
      REPO_ROOT,
    ]);
    await pool.query("DELETE FROM brain_lists WHERE repo_root = $1", [
      REPO_ROOT,
    ]);
    await pool.query("DELETE FROM brain_objects WHERE repo_root = $1", [
      REPO_ROOT,
    ]);
    await pool.query("DELETE FROM brain_events WHERE repo_root = $1", [
      REPO_ROOT,
    ]);
  } finally {
    await pool.end();
  }
}

async function navigateToBrains(page: Page): Promise<void> {
  await loadApp(page);
  await page.getByTestId("automations-button").click();
  await expect(page).toHaveURL(/\/automations/, { timeout: 5_000 });
  const projectsLoaded = page.waitForResponse(
    (resp) =>
      resp.url().includes("/api/v1/brain/projects") && resp.status() === 200,
    { timeout: 15_000 }
  );
  await page.getByRole("button", { name: "Brains" }).click();
  await expect(page).toHaveURL(/\/automations\/brains/, { timeout: 5_000 });
  await projectsLoaded;
}

function projectRow(page: Page) {
  return page.getByRole("button", { name: /e2e-brains-page-test/ }).first();
}

test.describe("Automations Brains page", () => {
  test.beforeAll(async () => {
    await seedBrainData();
  });

  test.afterAll(async () => {
    await cleanupBrainData();
  });

  test("navigates to Brains tab and shows project list", async ({ page }) => {
    await loadApp(page);

    await page.getByTestId("automations-button").click();
    await expect(page).toHaveURL(/\/automations/);

    const brainsTab = page.getByRole("button", { name: "Brains" });
    await expect(brainsTab).toBeVisible({ timeout: 5_000 });
    await brainsTab.click();
    await expect(page).toHaveURL(/\/automations\/brains/);

    await expect(projectRow(page)).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("Brain Explorer")).toBeVisible();
  });

  test("selects a project and shows collections", async ({ page }) => {
    await navigateToBrains(page);

    await expect(projectRow(page)).toBeVisible({ timeout: 10_000 });
    await projectRow(page).click();

    await expect(
      page.getByRole("button", { name: "All", exact: true })
    ).toBeVisible({
      timeout: 5_000,
    });

    await expect(page.getByText("Objects")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("Lists")).toBeVisible();
    await expect(page.getByText("Events")).toBeVisible();

    await expect(page.getByText("app-settings")).toBeVisible();
    await expect(page.getByText("build-status")).toBeVisible();
  });

  test("filters by collection", async ({ page }) => {
    await navigateToBrains(page);

    await expect(projectRow(page)).toBeVisible({ timeout: 10_000 });
    await projectRow(page).click();

    await expect(page.getByText("app-settings")).toBeVisible({
      timeout: 5_000,
    });
    await page.screenshot({
      path: "/tmp/dispatch-brain-delete-controls-project.png",
      fullPage: true,
      scale: "device",
    });

    const configPill = page.getByRole("button", { name: "config" });
    await expect(configPill).toBeVisible({ timeout: 5_000 });
    await configPill.click();

    await expect(page.getByText("app-settings")).toBeVisible();
    await expect(page.getByText("deploy-targets")).toBeVisible();
    await expect(page.getByText("build-status")).not.toBeVisible();
  });

  test("search filters brain data", async ({ page }) => {
    await navigateToBrains(page);

    await expect(projectRow(page)).toBeVisible({ timeout: 10_000 });
    await projectRow(page).click();

    await expect(page.getByText("app-settings")).toBeVisible({
      timeout: 5_000,
    });

    const searchInput = page.getByPlaceholder("Filter...");
    await searchInput.fill("deploy");

    await expect(page.getByText("deploy-targets")).toBeVisible();
    await expect(
      page.getByText("app-settings", { exact: true })
    ).not.toBeVisible();
  });

  test("shows list items inline", async ({ page }) => {
    await navigateToBrains(page);

    await expect(projectRow(page)).toBeVisible({ timeout: 10_000 });
    await projectRow(page).click();

    await expect(page.getByText("app-settings")).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText("task-queue")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("3 items")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("lint")).toBeVisible({ timeout: 5_000 });
  });

  test("deletes objects, events, and a collection after confirmation", async ({
    page,
  }) => {
    await navigateToBrains(page);
    await projectRow(page).click();
    await expect(page.getByText("app-settings")).toBeVisible({
      timeout: 5_000,
    });

    await page
      .getByRole("button", { name: "Delete object app-settings" })
      .click();
    await expect(
      page.getByRole("heading", { name: "Delete app-settings?" })
    ).toBeVisible();
    await page.screenshot({
      path: "/tmp/dispatch-brain-delete-confirmation.png",
      scale: "device",
    });
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(
      page.getByRole("heading", { name: "Delete app-settings?" })
    ).not.toBeVisible();
    await expect(page.getByText("app-settings")).toBeVisible();

    await page
      .getByRole("button", { name: "Delete object app-settings" })
      .click();
    await page.getByRole("button", { name: "Delete permanently" }).click();
    await expect(
      page.getByText("app-settings", { exact: true })
    ).not.toBeVisible();

    await page.getByRole("button", { name: "Delete event build" }).click();
    await expect(
      page.getByRole("heading", { name: "Delete build event?" })
    ).toBeVisible();
    await page.screenshot({
      path: "/tmp/dispatch-brain-event-delete-confirmation.png",
      scale: "device",
    });
    await page.getByRole("button", { name: "Delete permanently" }).click();
    await expect(
      page.getByRole("button", { name: "Delete event build" })
    ).not.toBeVisible();

    await page.getByRole("button", { name: "Delete list task-queue" }).click();
    await expect(
      page.getByRole("heading", { name: "Delete task-queue?" })
    ).toBeVisible();
    await page.screenshot({
      path: "/tmp/dispatch-brain-list-delete-confirmation.png",
      scale: "device",
    });
    await page.getByRole("button", { name: "Delete permanently" }).click();
    await expect(
      page.getByText("task-queue", { exact: true })
    ).not.toBeVisible();

    await page.getByRole("button", { name: "config" }).click();
    await page.screenshot({
      path: "/tmp/dispatch-brain-delete-controls-collection.png",
      fullPage: true,
      scale: "device",
    });
    await page.getByRole("button", { name: "Clear collection" }).click();
    await expect(
      page.getByRole("heading", { name: "Clear config?" })
    ).toBeVisible();
    await page.screenshot({
      path: "/tmp/dispatch-brain-collection-delete-confirmation.png",
      scale: "device",
    });
    await page.getByRole("button", { name: "Delete permanently" }).click();
    await expect(page).toHaveURL(/\/automations\/brains\/[^/]+$/);
    await expect(page.getByText("build-status")).toBeVisible();

    await page.getByRole("button", { name: "Clear project" }).click();
    await expect(
      page.getByRole("heading", { name: "Clear this project?" })
    ).toBeVisible();
    await page.screenshot({
      path: "/tmp/dispatch-brain-project-delete-confirmation.png",
      scale: "device",
    });
    await page.getByRole("button", { name: "Delete permanently" }).click();
    await expect(page).toHaveURL(/\/automations\/brains$/);
  });
});
