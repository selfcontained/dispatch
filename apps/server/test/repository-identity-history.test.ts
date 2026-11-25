import Fastify from "fastify";
import { beforeAll, afterAll, beforeEach, expect, it } from "vitest";
import { setupTestDb, teardownTestDb } from "./db/setup.js";
import { registerActivityHistoryRoutes } from "../src/routes/activity/history-routes.js";

let pool: Awaited<ReturnType<typeof setupTestDb>>;
const app = Fastify();
beforeAll(async () => {
  pool = await setupTestDb();
  await pool.query(`CREATE TABLE agents (
    id text PRIMARY KEY, parent_agent_id text, launch_cwd text, git_context jsonb, cwd text,
    created_at timestamptz, runner_id text DEFAULT 'local', project_id text,
    runner_repository jsonb, runner_worktree_owner text
  ); CREATE TABLE projects (id text PRIMARY KEY, repo_root text, repository text)`);
  await registerActivityHistoryRoutes(app, { pool } as never);
});
afterAll(async () => {
  await app.close();
  await teardownTestDb();
});
beforeEach(async () => {
  await pool.query("TRUNCATE agents, projects");
});

// Pinned before implementation; main uses this exact folder precedence and
// usage/latest/path ordering. Local projects do not override launch folders.
it("pins main local grouping, response bytes, search and limit", async () => {
  await pool.query(`INSERT INTO projects VALUES ('p', '/different/root', 'https://example.com/different');
    INSERT INTO agents (id, launch_cwd, git_context, cwd, created_at, project_id) VALUES
    ('a', '/work/alpha', '{"repoRoot":"/repo"}', '/checkout', '2026-01-01T00:00:00Z', 'p'),
    ('b', '/work/alpha', null, '/other', '2026-01-02T00:00:00Z', null),
    ('c', null, '{"repoRoot":"/work/beta"}', '/checkout', '2026-01-03T00:00:00Z', null),
    ('d', null, null, '/work/gamma', '2026-01-04T00:00:00Z', null)`);
  const expected = {
    projects: ["/work/alpha", "/work/gamma", "/work/beta"],
    projectOptions: [
      {
        path: "/work/alpha",
        usageCount: 2,
        latestCreatedAt: "2026-01-02T00:00:00.000Z",
        iconUrl: "/api/v1/agents/b/repo-icon",
      },
      {
        path: "/work/gamma",
        usageCount: 1,
        latestCreatedAt: "2026-01-04T00:00:00.000Z",
        iconUrl: "/api/v1/agents/d/repo-icon",
      },
      {
        path: "/work/beta",
        usageCount: 1,
        latestCreatedAt: "2026-01-03T00:00:00.000Z",
        iconUrl: "/api/v1/agents/c/repo-icon",
      },
    ],
  };
  expect((await app.inject("/api/v1/history/projects")).body).toBe(
    JSON.stringify(expected)
  );
  expect((await app.inject("/api/v1/history/projects?limit=1")).json()).toEqual(
    {
      projects: expected.projects.slice(0, 1),
      projectOptions: expected.projectOptions.slice(0, 1),
    }
  );
  expect(
    (await app.inject("/api/v1/history/projects?search=BETA")).json()
  ).toEqual({
    projects: expected.projects.slice(2),
    projectOptions: expected.projectOptions.slice(2),
  });
});
