import Fastify from "fastify";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { registerProjectRoutes } from "../src/routes/projects.js";
import type { TaskService } from "../src/tasks/service.js";
import { runTestMigrations, setupTestDb, teardownTestDb } from "./db/setup.js";

let pool: Pool;
let app: ReturnType<typeof Fastify>;
let root: string;

beforeAll(async () => {
  pool = await setupTestDb();
  await runTestMigrations();
  root = mkdtempSync(path.join(tmpdir(), "dispatch-project-icon-"));
  app = Fastify();
  await registerProjectRoutes(app, {
    pool,
    taskService: {} as TaskService,
    publishUiEvent: () => {},
  });
});

afterAll(async () => {
  await app.close();
  rmSync(root, { recursive: true, force: true });
  await teardownTestDb();
});

async function project(repoRoot: string): Promise<string> {
  return (
    await pool.query<{ id: string }>(
      `INSERT INTO projects (id, name, repo_root, color) VALUES (gen_random_uuid(), $1, $2, '#336699') RETURNING id`,
      [path.basename(repoRoot), repoRoot]
    )
  ).rows[0]!.id;
}

const icon = (id: string) =>
  app.inject({ method: "GET", url: `/api/v1/projects/${id}/icon?v=1` });

describe("GET /api/v1/projects/:id/icon", () => {
  it("answers 204 with no body for a project without an icon", async () => {
    for (const repoRoot of [root, "runner://rnr_icon/@session"]) {
      const res = await icon(await project(repoRoot));
      expect(res.statusCode).toBe(204);
      expect(res.body).toBe("");
    }
  });

  it("serves a repository icon and 404s an unknown project", async () => {
    const repo = mkdtempSync(path.join(root, "repo-"));
    writeFileSync(path.join(repo, "favicon.svg"), "<svg/>");
    const res = await icon(await project(repo));
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("image/svg+xml");
    expect(
      (await icon("00000000-0000-0000-0000-000000000000")).statusCode
    ).toBe(404);
  });
});
