import Fastify from "fastify";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
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
  it("answers 404 with no body for a project without an icon", async () => {
    for (const repoRoot of [root, "runner://rnr_icon/@session"]) {
      const res = await icon(await project(repoRoot));
      expect(res.statusCode).toBe(404);
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

// Main's behaviour for a project with a local folder, pinned before the
// route reads through the project's runner (T15c).
describe("GET /api/v1/projects/:id/icon: main's local behaviour", () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);

  it("serves the bytes with main's headers and keeps a durable copy", async () => {
    const repo = mkdtempSync(path.join(root, "bytes-"));
    writeFileSync(path.join(repo, "icon.png"), PNG);
    const id = await project(repo);
    const res = await icon(id);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.headers["cache-control"]).toBe("private, max-age=86400");
    expect(res.headers["content-security-policy"]).toBe(
      "default-src 'none'; style-src 'unsafe-inline'"
    );
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.rawPayload.equals(PNG)).toBe(true);
    const saved = (
      await pool.query<{ icon_data: Buffer; icon_mime: string }>(
        "SELECT icon_data, icon_mime FROM projects WHERE id=$1",
        [id]
      )
    ).rows[0]!;
    expect(saved.icon_mime).toBe("image/png");
    expect(saved.icon_data.equals(PNG)).toBe(true);
    // The copy outlives the file.
    unlinkSync(path.join(repo, "icon.png"));
    const again = await icon(id);
    expect(again.statusCode).toBe(200);
    expect(again.rawPayload.equals(PNG)).toBe(true);
  });

  it("serves an icon override before the repository's icon", async () => {
    const repo = mkdtempSync(path.join(root, "override-"));
    writeFileSync(path.join(repo, "favicon.svg"), "<svg/>");
    const id = await project(repo);
    const pixel = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      "base64"
    );
    await pool.query("UPDATE projects SET icon_override=$2 WHERE id=$1", [
      id,
      `data:image/png;base64,${pixel.toString("base64")}`,
    ]);
    const res = await icon(id);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.headers["cache-control"]).toBe("private, max-age=86400");
    expect(res.rawPayload.equals(pixel)).toBe(true);
  });

  it("answers an empty 404 for an unreadable, empty, oversized or escaping icon", async () => {
    const unreadable = mkdtempSync(path.join(root, "unreadable-"));
    writeFileSync(path.join(unreadable, "favicon.svg"), "<svg/>");
    chmodSync(path.join(unreadable, "favicon.svg"), 0o000);
    const empty = mkdtempSync(path.join(root, "empty-"));
    writeFileSync(path.join(empty, "favicon.svg"), "");
    const oversized = mkdtempSync(path.join(root, "oversized-"));
    writeFileSync(
      path.join(oversized, "icon.png"),
      Buffer.alloc(2 * 1024 * 1024 + 1)
    );
    const outside = mkdtempSync(path.join(root, "outside-"));
    const target = mkdtempSync(path.join(root, "target-"));
    writeFileSync(path.join(target, "real.svg"), "<svg/>");
    symlinkSync(
      path.join(target, "real.svg"),
      path.join(outside, "favicon.svg")
    );
    try {
      for (const repo of [unreadable, empty, oversized, outside]) {
        const id = await project(repo);
        const res = await icon(id);
        expect(res.statusCode, repo).toBe(404);
        expect(res.body).toBe("");
        expect(
          (
            await pool.query(
              "SELECT icon_data FROM projects WHERE id=$1 AND icon_data IS NOT NULL",
              [id]
            )
          ).rowCount
        ).toBe(0);
      }
    } finally {
      chmodSync(path.join(unreadable, "favicon.svg"), 0o644);
    }
  });

  it("answers an empty 404 for a folder that is gone and for any unknown id", async () => {
    const gone = mkdtempSync(path.join(root, "gone-"));
    const id = await project(gone);
    rmSync(gone, { recursive: true });
    for (const res of [
      await icon(id),
      await icon("not-a-uuid"),
      await icon("unknown-project"),
    ]) {
      expect(res.statusCode).toBe(404);
      expect(res.body).toBe("");
    }
  });
});
