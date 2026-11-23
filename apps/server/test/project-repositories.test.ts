import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { inferProjectRepository } from "../src/agents/remote/repository.js";
import { runMigrations } from "../src/db/migrate.js";
import { matchingProjects } from "../src/projects/matching.js";
import { backfillProjectRepositories } from "../src/projects/repository-backfill.js";
import { ProjectStore } from "../src/projects/store.js";
import { registerProjectRoutes } from "../src/routes/projects.js";
import { registerSystemRoutes } from "../src/routes/system.js";
import { getTestDatabaseUrl, setupTestDb, teardownTestDb } from "./db/setup.js";

const directories: string[] = [];
const repository = "https://example.com/owner/repo";
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, stdio: "pipe" });

async function checkout(...origins: string[]) {
  const cwd = await mkdtemp(join(tmpdir(), "dispatch-project-repo-"));
  directories.push(cwd);
  git(cwd, "init", "--quiet");
  for (const url of origins)
    git(cwd, "config", "--local", "--add", "remote.origin.url", url);
  git(cwd, "config", "--local", "remote.upstream.url", repository);
  return cwd;
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

it.each([
  { origins: ["git@EXAMPLE.COM:owner/repo.git"], expected: repository },
  { origins: ["ssh://git@example.com/owner/repo.git"], expected: repository },
  { origins: ["https://EXAMPLE.COM/owner/repo.git/"], expected: repository },
  { origins: ["https://example.com/owner/repo/"], expected: repository },
  {
    origins: ["https://user:password@example.com/owner/repo.git"],
    expected: repository,
  },
  {
    origins: ["https://example.com/fork/repo"],
    expected: "https://example.com/fork/repo",
  },
  { origins: ["http://example.com/owner/repo"], expected: null },
  { origins: [], expected: null },
  { origins: [repository, repository], expected: null },
])(
  "identifies a checkout from origin only (%#)",
  async ({ origins, expected }) => {
    expect(await inferProjectRepository(await checkout(...origins))).toBe(
      expected
    );
  }
);

it("sends a repository target for runner branches", async () => {
  const app = Fastify();
  const runnerBranches = vi.fn(async () => ({ branches: ["main"] }));
  try {
    await registerSystemRoutes(app, { runnerBranches } as Parameters<
      typeof registerSystemRoutes
    >[1]);
    const query = new URLSearchParams({
      runnerId: "example",
      repository: repository + ".git/",
    });
    const response = await app.inject(`/api/v1/git/branches?${query}`);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ branches: ["main"] });
    expect(runnerBranches).toHaveBeenCalledWith("example", { repository });
    query.set("cwd", "/controller");
    const mixed = await app.inject(`/api/v1/git/branches?${query}`);
    expect(mixed.statusCode).toBe(400);
    expect(runnerBranches).toHaveBeenCalledTimes(1);
  } finally {
    await app.close();
  }
});

async function migrate(pool: Pool, count?: number) {
  await runMigrations({ databaseUrl: getTestDatabaseUrl(), count });
  return pool;
}

async function legacyProject(
  pool: Pool,
  id: string,
  root: string,
  year: number
) {
  await pool.query(
    `INSERT INTO projects (id, name, repo_root, color, icon_override, created_at)
     VALUES ($1, $1, $2, $4, $1 || '-icon', make_date($3, 1, 1))`,
    [id, root, year, id === "old" ? "#112233" : "#445566"]
  );
}

it.each([52, 65])(
  "upgrades schema after %i migrations and accepts main's inserts",
  async (count) => {
    const pool = await setupTestDb();
    try {
      await migrate(pool, count);
      await legacyProject(pool, "before", await checkout(), 2024);
      const read = async (id: string) =>
        (
          await pool.query(
            "SELECT to_jsonb(p) AS row FROM projects p WHERE id=$1",
            [id]
          )
        ).rows[0].row;
      const before = await read("before");
      await migrate(pool);
      expect(await read("before")).toEqual({
        ...before,
        repository: null,
        extra_roots: [],
      });
      await legacyProject(pool, "after", await checkout(), 2025);
      expect(await read("after")).toMatchObject({
        repository: null,
        extra_roots: [],
      });
    } finally {
      await teardownTestDb();
    }
  }
);

it("creates from a folder or a repository alone, refuses duplicates, and reads the stored origin", async () => {
  const pool = await setupTestDb();
  const app = Fastify();
  try {
    await migrate(pool);
    await registerProjectRoutes(app, {
      pool,
      publishUiEvent: vi.fn(),
      taskService: {
        taskIdsForProject: vi.fn(),
        cleanupProjectAttachments: vi.fn(),
      },
    });
    const create = (target: { repoRoot?: string; repository?: string }) =>
      app.inject({
        method: "POST",
        url: "/api/v1/projects",
        payload: { name: "Example", color: "#123456", ...target },
      });
    const repoRoot = await checkout("git@EXAMPLE.COM:owner/repo.git");
    const folder = await create({ repoRoot });
    expect(folder.statusCode).toBe(200);
    const id = folder.json().id;
    git(
      repoRoot,
      "config",
      "--local",
      "remote.origin.url",
      "https://example.com/changed/repo"
    );
    expect(
      (await app.inject(`/api/v1/projects/${id}/repository`)).json()
    ).toEqual({ url: repository });
    for (const target of [
      { repoRoot: await checkout(repository + "/") },
      { repository: repository + ".git" },
    ]) {
      const duplicate = await create(target);
      expect(duplicate.statusCode).toBe(409);
      expect(duplicate.json()).toEqual({
        error: "This repository already has a project.",
      });
    }
    const remote = await create({
      repository: "https://EXAMPLE.COM/fork/repo.git/",
    });
    expect(remote.statusCode).toBe(200);
    expect(remote.json().repoRoot).toBeNull();
    const store = new ProjectStore(pool);
    expect(await store.getRepository(remote.json().id)).toEqual({
      url: "https://example.com/fork/repo",
    });
    const local = await create({ repoRoot: await checkout() });
    expect(local.statusCode).toBe(200);
    expect(await store.getRepository(local.json().id)).toEqual({ url: null });
  } finally {
    await app.close();
    await teardownTestDb();
  }
});

it("merges into the oldest project and preserves non-colliding project data", async () => {
  const pool = await setupTestDb();
  try {
    await migrate(pool);
    const old = await checkout();
    const newer = await checkout(repository);
    const other = await checkout("https://example.com/other/repo");
    await legacyProject(pool, "old", old, 2022);
    await legacyProject(pool, "new", newer, 2023);
    await legacyProject(pool, "other", other, 2024);
    const otherRow = async () =>
      (
        await pool.query(
          "SELECT to_jsonb(p) - 'repository' AS row FROM projects p WHERE id = 'other'"
        )
      ).rows[0].row;
    const before = await otherRow();
    await pool.query(`
      UPDATE projects SET repository = '${repository}' WHERE id = 'new';
      INSERT INTO agents (id, name, status, cwd, project_id)
      VALUES ('a', 'A', 'idle', '/a', 'new'), ('b', 'B', 'idle', '/b', 'new');
      INSERT INTO templates (id, name, directory, project_id, location)
      VALUES ('template', 'Template', '/b', 'new', '{"runner":"remote","projectId":"new"}');
      INSERT INTO jobs (id, name, directory, template_id, location)
      VALUES ('job', 'Job', '/b', 'template', '{"runner":"remote","projectId":"new"}');
      INSERT INTO blocks (id, stream_id, author_kind) VALUES (gen_random_uuid(), 'b', 'user');
      INSERT INTO message_shares (id, source_id, sharer_id, recipient_id, project_id, notification_id, snapshot)
      SELECT gen_random_uuid(), gen_random_uuid(), 'a', 'b', 'new', id, '{}' FROM blocks WHERE stream_id = 'b';
      INSERT INTO task_columns (id, project_id, key, name, position, is_done, capacity, trigger)
      VALUES ('old-do', 'old', 'do', 'Do', 4, false, 2, NULL),
             ('new-do', 'new', 'do', 'Discard', 0, true, 1, '{"templateId":"template"}'),
             ('new-review', 'new', 'review', 'Review', 1, true, 3, '{"templateId":"template"}'),
             ('other-do', 'other', 'do', 'Untouched', 0, false, NULL, NULL);
      INSERT INTO tasks (id, project_id, column_id, title, position, created_by_kind)
      VALUES ('task', 'new', 'new-do', 'Task', 0, 'user'),
             ('review', 'new', 'new-review', 'Review', 0, 'user');
      INSERT INTO task_agents (task_id, agent_id, role, column_id)
      VALUES ('task', 'a', 'trigger', 'new-do');
      INSERT INTO task_labels (id, project_id, name, color)
      VALUES ('old-label', 'old', 'Bug', 'red'), ('new-label', 'new', 'BUG', 'green'),
             ('new-unique', 'new', 'Review', 'blue'), ('other-label', 'other', 'bug', 'gray');
      INSERT INTO task_label_assignments VALUES
       ('task', 'new-label'), ('task', 'old-label'), ('task', 'new-unique'), ('review', 'new-label');
      INSERT INTO task_board_watches (project_id, agent_id)
      VALUES ('old', 'a'), ('new', 'a'), ('new', 'b'), ('other', 'a');
    `);
    const errors = vi.fn();
    await backfillProjectRepositories(pool, errors);
    expect(errors).not.toHaveBeenCalled();
    // An unresolved older checkout is retried after it comes online.
    expect(await new ProjectStore(pool).getRepository("old")).toEqual({
      url: null,
    });
    git(
      old,
      "config",
      "--local",
      "remote.origin.url",
      "git@example.com:owner/repo.git"
    );
    await backfillProjectRepositories(pool, errors);
    expect(errors).not.toHaveBeenCalled();
    const rows = async (sql: string) => (await pool.query(sql)).rows;
    const projects = await rows(
      "SELECT id, name, color, icon_override, repository, extra_roots FROM projects ORDER BY id"
    );
    expect(projects).toEqual([
      {
        id: "old",
        name: "old",
        color: "#112233",
        icon_override: "old-icon",
        repository,
        extra_roots: [newer],
      },
      {
        id: "other",
        name: "other",
        color: "#445566",
        icon_override: "other-icon",
        repository: "https://example.com/other/repo",
        extra_roots: [],
      },
    ]);
    expect(await otherRow()).toEqual(before);
    const roots = await new ProjectStore(pool).listRoots();
    for (const folder of [old, newer])
      expect((await matchingProjects(folder, roots)).map((p) => p.id)).toEqual([
        "old",
      ]);
    for (const table of ["agents", "templates", "tasks", "message_shares"])
      expect(await rows(`SELECT DISTINCT project_id FROM ${table}`)).toEqual([
        { project_id: "old" },
      ]);
    for (const table of ["templates", "jobs"])
      expect(
        await rows(`SELECT location->>'projectId' AS project FROM ${table}`)
      ).toEqual([{ project: "old" }]);
    expect(
      await rows(
        "SELECT id, project_id, name, position, is_done, capacity, trigger FROM task_columns ORDER BY id"
      )
    ).toEqual([
      {
        id: "new-review",
        project_id: "old",
        name: "Review",
        position: 5,
        is_done: true,
        capacity: 3,
        trigger: { templateId: "template" },
      },
      {
        id: "old-do",
        project_id: "old",
        name: "Do",
        position: 4,
        is_done: false,
        capacity: 2,
        trigger: null,
      },
      {
        id: "other-do",
        project_id: "other",
        name: "Untouched",
        position: 0,
        is_done: false,
        capacity: null,
        trigger: null,
      },
    ]);
    expect(await rows("SELECT id, column_id FROM tasks ORDER BY id")).toEqual([
      { id: "review", column_id: "new-review" },
      { id: "task", column_id: "old-do" },
    ]);
    expect(await rows("SELECT column_id FROM task_agents")).toEqual([
      { column_id: "old-do" },
    ]);
    expect(
      await rows("SELECT id, project_id, color FROM task_labels ORDER BY id")
    ).toEqual([
      { id: "new-unique", project_id: "old", color: "blue" },
      { id: "old-label", project_id: "old", color: "red" },
      { id: "other-label", project_id: "other", color: "gray" },
    ]);
    expect(
      await rows(
        "SELECT * FROM task_label_assignments ORDER BY task_id, label_id"
      )
    ).toEqual([
      { task_id: "review", label_id: "old-label" },
      { task_id: "task", label_id: "new-unique" },
      { task_id: "task", label_id: "old-label" },
    ]);
    expect(
      await rows(
        "SELECT id::int, project_id, agent_id FROM task_board_watches ORDER BY id"
      )
    ).toEqual([
      { id: 1, project_id: "old", agent_id: "a" },
      { id: 3, project_id: "old", agent_id: "b" },
      { id: 4, project_id: "other", agent_id: "a" },
    ]);
  } finally {
    await teardownTestDb();
  }
});
