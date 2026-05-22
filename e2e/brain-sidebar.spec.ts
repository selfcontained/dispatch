import { expect, test, type Page } from "@playwright/test";
import { Pool } from "pg";

import { cleanupE2EAgents, createAgentViaAPI, loadApp } from "./helpers";

const AUTH_HEADER = {
  Authorization: `Bearer ${process.env.AUTH_TOKEN ?? "dev-token"}`,
};

const REPO_ROOT = "/tmp/e2e-brain-test";

async function seedBrainDataViaDB(agentId: string): Promise<void> {
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
        `UPDATE agents SET git_context = $2::jsonb WHERE id = $1`,
        [agentId, JSON.stringify({ repoRoot: REPO_ROOT, branch: "main" })]
      );

      await client.query(
        `INSERT INTO brain_objects (repo_root, collection, name, value, revision, created_by_agent_id, updated_by_agent_id)
         VALUES ($1, 'config', 'settings', '{"theme":"dark"}'::jsonb, 1, $2, $2),
                ($1, 'state', 'cursor', '{"pos":42}'::jsonb, 1, $2, $2)`,
        [REPO_ROOT, agentId]
      );

      await client.query(
        `INSERT INTO brain_lists (repo_root, collection, name, revision, created_by_agent_id, updated_by_agent_id)
         VALUES ($1, 'state', 'backlog', 1, $2, $2)`,
        [REPO_ROOT, agentId]
      );
      await client.query(
        `INSERT INTO brain_list_items (repo_root, collection, name, item_index, value)
         VALUES ($1, 'state', 'backlog', 0, '{"id":"a"}'::jsonb),
                ($1, 'state', 'backlog', 1, '{"id":"b"}'::jsonb)`,
        [REPO_ROOT]
      );

      await client.query(
        `INSERT INTO brain_events (id, repo_root, collection, kind, subject, tags, value, agent_id)
         VALUES (gen_random_uuid(), $1, 'reviews', 'assessment', 'ux-review', ARRAY['noise'], '{"score":0.8}'::jsonb, $2),
                (gen_random_uuid(), $1, 'reviews', 'decision', NULL, ARRAY[]::text[], '{"action":"approve"}'::jsonb, $2)`,
        [REPO_ROOT, agentId]
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

async function cleanupBrainDataViaDB(): Promise<void> {
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

async function openMediaSidebarForAgent(
  page: Page,
  agent: { id: string; name: string }
) {
  await page.getByTestId(`agent-row-${agent.id}`).click();
  const toggle = page.getByTestId("toggle-media-sidebar");
  await expect(toggle).toBeVisible();
  await toggle.click();
}

test.describe("Brain sidebar tab", () => {
  test.afterAll(async ({ request }) => {
    await cleanupBrainDataViaDB();
    await cleanupE2EAgents(request);
  });

  test("shows brain data in sidebar tab", async ({ page, request }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-agent-brain-${Date.now()}`,
      cwd: "/tmp",
    });

    await seedBrainDataViaDB(agent.id);

    await loadApp(page);
    await openMediaSidebarForAgent(page, agent);

    const mediaSidebar = page.getByTestId("media-sidebar");
    await expect(mediaSidebar).toBeVisible();

    await mediaSidebar.getByRole("button", { name: "Brain" }).click();

    await expect(mediaSidebar.getByText("Objects")).toBeVisible({
      timeout: 10_000,
    });
    await expect(mediaSidebar.getByText("Lists")).toBeVisible();
    await expect(mediaSidebar.getByText("Events")).toBeVisible();

    await expect(mediaSidebar.getByText("settings")).toBeVisible();
    await expect(mediaSidebar.getByText("cursor")).toBeVisible();

    await expect(mediaSidebar.getByText("backlog")).toBeVisible();
    await expect(mediaSidebar.getByText("2 items")).toBeVisible();

    await expect(mediaSidebar.getByText("assessment")).toBeVisible();
    await expect(mediaSidebar.getByText("decision")).toBeVisible();
    await expect(mediaSidebar.getByText("ux-review")).toBeVisible();
    await expect(mediaSidebar.getByText("noise")).toBeVisible();
  });

  test("shows empty state when agent has no brain data", async ({
    page,
    request,
  }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-agent-brain-empty-${Date.now()}`,
      cwd: "/tmp",
    });

    await loadApp(page);
    await openMediaSidebarForAgent(page, agent);

    const mediaSidebar = page.getByTestId("media-sidebar");
    await mediaSidebar.getByRole("button", { name: "Brain" }).click();

    await expect(
      mediaSidebar.getByText(/brain context available|brain data yet/i)
    ).toBeVisible({ timeout: 10_000 });
  });
});

test.describe("Brain API", () => {
  let agentId: string;

  test.beforeAll(async ({ request }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-agent-brain-api-${Date.now()}`,
      cwd: "/tmp",
    });
    agentId = agent.id;
    await seedBrainDataViaDB(agentId);
  });

  test.afterAll(async ({ request }) => {
    await cleanupBrainDataViaDB();
    await cleanupE2EAgents(request);
  });

  test("GET /api/v1/brain/projects lists projects", async ({ request }) => {
    const res = await request.get("/api/v1/brain/projects", {
      headers: AUTH_HEADER,
    });
    expect(res.ok()).toBeTruthy();
    const body = (await res.json()) as Array<{
      repoRoot: string;
      objectCount: number;
    }>;
    const project = body.find((p) => p.repoRoot === REPO_ROOT);
    expect(project).toBeDefined();
    expect(project!.objectCount).toBeGreaterThanOrEqual(2);
  });

  test("GET /api/v1/brain/collections returns summaries", async ({
    request,
  }) => {
    const res = await request.get(
      `/api/v1/brain/collections?repoRoot=${encodeURIComponent(REPO_ROOT)}`,
      { headers: AUTH_HEADER }
    );
    expect(res.ok()).toBeTruthy();
    const body = (await res.json()) as Array<{ collection: string }>;
    const collections = body.map((c) => c.collection);
    expect(collections).toContain("config");
    expect(collections).toContain("state");
    expect(collections).toContain("reviews");
  });

  test("GET /api/v1/brain/collections returns 400 without repoRoot", async ({
    request,
  }) => {
    const res = await request.get("/api/v1/brain/collections", {
      headers: AUTH_HEADER,
    });
    expect(res.status()).toBe(400);
  });

  test("GET /api/v1/brain/objects lists objects", async ({ request }) => {
    const res = await request.get(
      `/api/v1/brain/objects?repoRoot=${encodeURIComponent(REPO_ROOT)}`,
      { headers: AUTH_HEADER }
    );
    expect(res.ok()).toBeTruthy();
    const body = (await res.json()) as Array<{ name: string }>;
    expect(body.length).toBeGreaterThanOrEqual(2);
  });

  test("GET /api/v1/brain/objects/:collection/:name gets a single object", async ({
    request,
  }) => {
    const res = await request.get(
      `/api/v1/brain/objects/config/settings?repoRoot=${encodeURIComponent(REPO_ROOT)}`,
      { headers: AUTH_HEADER }
    );
    expect(res.ok()).toBeTruthy();
    const body = (await res.json()) as { name: string; value: unknown };
    expect(body.name).toBe("settings");
    expect(body.value).toEqual({ theme: "dark" });
  });

  test("GET /api/v1/brain/lists lists with item counts", async ({
    request,
  }) => {
    const res = await request.get(
      `/api/v1/brain/lists?repoRoot=${encodeURIComponent(REPO_ROOT)}`,
      { headers: AUTH_HEADER }
    );
    expect(res.ok()).toBeTruthy();
    const body = (await res.json()) as Array<{
      name: string;
      itemCount: number;
    }>;
    const backlog = body.find((l) => l.name === "backlog");
    expect(backlog).toBeDefined();
    expect(backlog!.itemCount).toBe(2);
  });

  test("GET /api/v1/brain/events lists events", async ({ request }) => {
    const res = await request.get(
      `/api/v1/brain/events?repoRoot=${encodeURIComponent(REPO_ROOT)}`,
      { headers: AUTH_HEADER }
    );
    expect(res.ok()).toBeTruthy();
    const body = (await res.json()) as Array<{ kind: string }>;
    expect(body.length).toBeGreaterThanOrEqual(2);
  });

  test("GET /api/v1/brain/agent-activity/:agentId returns activity", async ({
    request,
  }) => {
    const res = await request.get(
      `/api/v1/brain/agent-activity/${agentId}?repoRoot=${encodeURIComponent(REPO_ROOT)}`,
      { headers: AUTH_HEADER }
    );
    expect(res.ok()).toBeTruthy();
    const body = (await res.json()) as {
      objects: Array<{ name: string }>;
      lists: Array<{ name: string }>;
      events: Array<{ kind: string }>;
    };
    expect(body.objects.length).toBeGreaterThanOrEqual(2);
    expect(body.lists.length).toBeGreaterThanOrEqual(1);
    expect(body.events.length).toBeGreaterThanOrEqual(2);
  });

  test("GET /api/v1/brain/agent-activity/:agentId returns 400 without repoRoot", async ({
    request,
  }) => {
    const res = await request.get(`/api/v1/brain/agent-activity/${agentId}`, {
      headers: AUTH_HEADER,
    });
    expect(res.status()).toBe(400);
  });
});
