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
    runner_repository jsonb, runner_worktree_owner text,
    name text DEFAULT 'fixture', type text DEFAULT 'codex', status text DEFAULT 'done',
    deleted_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
    worktree_path text, worktree_branch text, persona text, role text
  ); CREATE TABLE projects (id text PRIMARY KEY, repo_root text, repository text); CREATE TABLE agent_token_usage (agent_id text, input_tokens bigint, cache_creation_tokens bigint, cache_read_tokens bigint, output_tokens bigint)`);
  await registerActivityHistoryRoutes(app, {
    pool,
    parseActivityQuery: () => ({}),
    timeRangeClause: () => ({ clause: "", params: [] }),
    escapeLike: (s: string) => s,
  } as never);
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

it("agrees with TypeScript identities for stored rows, including borrowed repositories", async () => {
  const {
    HISTORY_IDENTITY_SQL,
    identityKey,
    projectKey,
    repositoryRecord,
    sessionRepositoryKey,
  } = await import("../src/runners/repository-identity.js");
  const { placementForRunner } = await import("../src/runners/placement.js");
  const cases = [
    {
      id: "local-folder",
      runner: "local",
      launch: "/work/a",
      root: "/repo",
      cwd: "/checkout",
      project: null,
      repository: null,
    },
    {
      id: "local-root",
      runner: "local",
      launch: null,
      root: "/repo",
      cwd: "/checkout",
      project: null,
      repository: null,
    },
    {
      id: "project-folder",
      runner: "fixture",
      launch: "runner://fixture/@session",
      root: null,
      cwd: "runner://fixture/@session",
      project: { repoRoot: "/work/a", repository: "https://example.com/a" },
      repository: null,
    },
    {
      id: "project-repo",
      runner: "fixture",
      launch: "runner://fixture/@session",
      root: null,
      cwd: "runner://fixture/@session",
      project: { repoRoot: null, repository: "https://example.com/b" },
      repository: null,
    },
    {
      id: "repository",
      runner: "fixture",
      launch: "runner://fixture/@session",
      root: null,
      cwd: "runner://fixture/@session",
      project: null,
      repository: "https://EXAMPLE.com:443/org/../repo.git",
    },
    {
      id: "neither",
      runner: "fixture",
      launch: "runner://fixture/@session",
      root: null,
      cwd: "runner://fixture/@session",
      project: null,
      repository: null,
    },
  ];
  for (const row of cases) {
    const placement = placementForRunner(row.runner);
    if (row.project)
      await pool.query("INSERT INTO projects VALUES ($1,$2,$3)", [
        row.id,
        row.project.repoRoot,
        row.project.repository,
      ]);
    await pool.query(
      `INSERT INTO agents (id,runner_id,launch_cwd,git_context,cwd,project_id,runner_repository,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,'2026-01-01T00:00:00Z')`,
      [
        row.id,
        row.runner,
        row.launch,
        row.root ? { repoRoot: row.root } : null,
        row.cwd,
        row.project ? row.id : null,
        repositoryRecord(
          placement,
          row.repository ? { url: row.repository } : null
        ),
      ]
    );
    const expected =
      identityKey(placement, row.launch ?? row.root ?? row.cwd) ??
      (row.project
        ? projectKey(row.project)
        : sessionRepositoryKey(row.repository));
    const actual = await pool.query(
      `SELECT ${HISTORY_IDENTITY_SQL} AS key FROM agents a WHERE id=$1`,
      [row.id]
    );
    expect(actual.rows[0].key).toBe(expected);
  }
  await pool.query(
    `INSERT INTO agents (id,runner_id,cwd,runner_worktree_owner,created_at) VALUES ('borrowed','fixture','runner://fixture/@borrowed','repository','2026-01-02T00:00:00Z')`
  );
  const borrowed = await pool.query(
    `SELECT ${HISTORY_IDENTITY_SQL} AS key FROM agents a WHERE id='borrowed'`
  );
  expect(borrowed.rows[0].key).toBe("https://example.com/repo");
  const response = (await app.inject("/api/v1/history/projects")).json();
  expect(response.projects).toEqual([
    "https://example.com/repo",
    "/work/a",
    "/repo",
    "https://example.com/b",
  ]);
  expect(JSON.stringify(response)).not.toContain("runner://");
  expect(
    (
      await app.inject("/api/v1/history/projects?search=EXAMPLE.COM&limit=1")
    ).json().projects
  ).toEqual(["https://example.com/repo"]);
});

it("filters runner projects and keeps local folders separate in agent pagination", async () => {
  await pool.query(`INSERT INTO projects VALUES ('p1',null,'https://example.com/alpha'),('p2',null,'https://example.com/beta');
    INSERT INTO agents (id,cwd,launch_cwd,runner_id,project_id,created_at) VALUES
    ('a','runner://fixture/@session','runner://fixture/@session','fixture','p1','2026-01-01T00:00:00Z'),
    ('b','runner://fixture/@session','runner://fixture/@session','fixture','p2','2026-01-02T00:00:00Z'),
    ('c','/work/local','/work/local','local','p1','2026-01-03T00:00:00Z')`);
  await pool.query("UPDATE agents SET updated_at=created_at");
  const remote = (
    await app.inject(
      "/api/v1/history/agents?project=https://example.com/alpha&limit=1"
    )
  ).json();
  expect(remote.total, JSON.stringify(remote)).toBe(1);
  expect(remote.agents[0].project).toBe("https://example.com/alpha");
  expect(remote.agents.map((a: { id: string }) => a.id)).toEqual(["a"]);
  const local = (
    await app.inject("/api/v1/history/agents?project=/work/local")
  ).json();
  expect(local.total).toBe(1);
  expect(local.agents[0]).not.toHaveProperty("project");
  expect(local.agents[0]).not.toHaveProperty("historyRunner");
  expect(local.agents[0]).not.toHaveProperty("historyProject");
  expect(local.agents.map((a: { id: string }) => a.id)).toEqual(["c"]);
});
