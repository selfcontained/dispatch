import { createHash } from "node:crypto";
import Fastify from "fastify";
import type { Pool } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { setupTestDb, runTestMigrations, teardownTestDb } from "./db/setup.js";
import { setSetting } from "../src/db/settings.js";
import {
  registerPortfolioBoundary,
  registerPortfolioRoutes,
} from "../src/routes/portfolio.js";
import { PortfolioStore } from "../src/portfolio/store.js";

const token = `dpr_${"a".repeat(64)}`;
const grant = {
  id: "fixture",
  sha256: createHash("sha256").update(token).digest("hex"),
  projectIds: ["one", "two", "missing"],
  revoked: false,
  expiresAt: "2099-01-01T00:00:00.000Z",
};
const window = "from=2020-01-01T00:00:00Z&to=2025-01-01T00:00:00Z";
const headers = { authorization: `Bearer ${token}` };
let pool: Pool;
let app: ReturnType<typeof Fastify>;
beforeAll(async () => {
  pool = await setupTestDb();
  await runTestMigrations();
});
afterAll(async () => {
  await teardownTestDb();
});
beforeEach(async () => {
  await pool.query("TRUNCATE projects, agents CASCADE");
  await pool.query("DELETE FROM blocks");
  await setSetting(pool, "portfolio_readers_v1", JSON.stringify([grant]));
  await pool.query(
    `INSERT INTO projects(id,name,repo_root) VALUES ('one','Personal','/one'),('two','Second','/two'),('work','Work secret','/work')`
  );
  await pool.query(
    `INSERT INTO task_columns(id,project_id,key,name,position) VALUES ('c1','one','done','Done',0),('c2','two','todo','Todo',0),('cw','work','todo','Private',0)`
  );
  await pool.query(`INSERT INTO tasks(id,project_id,column_id,title,body,position,created_by_kind,archived_at,links)
    VALUES ('t1','one','c1','Archived','Acceptance criteria',0,'user',now(),'[{"kind":"pr","url":"https://example.com/pr/1","label":"PR"}]'),
    ('t2','two','c2','Other project','Second acceptance',0,'user',NULL,'[]'),
    ('tw','work','cw','Work secret','Never export',0,'user',NULL,'[]')`);
  await pool.query(`INSERT INTO agents(id,name,status,cwd,project_id,parent_agent_id,deleted_at) VALUES
    ('a1','Root','idle','/one','one',NULL,now()),('a2','Child','idle','/one','one','a1',now()),
    ('a3','Second','idle','/two','two',NULL,NULL),('aw','Private','idle','/work','work',NULL,NULL),
    ('unassociated','Unknown','idle','/one',NULL,'a1',NULL)`);
  await pool.query(`INSERT INTO blocks(id,stream_id,author_kind,author_agent_id,kind,origin,text,created_at,updated_at,thread_id,reply_to) VALUES
    ('00000000-0000-4000-8000-000000000001','a1','agent','a1','text','turn','Root outcome','2024-01-01','2024-01-01',NULL,NULL),
    ('00000000-0000-4000-8000-000000000002','a1','agent','a2','text','turn','Child outcome','2024-01-02','2024-01-02','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001'),
    ('00000000-0000-4000-8000-000000000003','t2','agent','a3','text','turn','Task outcome','2024-01-02','2024-01-02',NULL,NULL),
    ('00000000-0000-4000-8000-000000000004','aw','agent','aw','text','turn','Work secret','2024-01-02','2024-01-02',NULL,NULL),
    ('00000000-0000-4000-8000-000000000005','aw','agent','a1','text','turn','Cross-project placement','2024-01-02','2024-01-02',NULL,NULL),
    ('00000000-0000-4000-8000-000000000006','a1','agent','aw','text','turn','Cross-project author','2024-01-02','2024-01-02',NULL,NULL),
    ('00000000-0000-4000-8000-000000000007','a1','agent','unassociated','text','turn','Unknown membership','2024-01-02','2024-01-02',NULL,NULL),
    ('00000000-0000-4000-8000-000000000008','a1','agent','a1','launch',NULL,'Secret prompt','2024-01-02','2024-01-02',NULL,NULL),
    ('00000000-0000-4000-8000-000000000009','a1','agent','a1','text','turn','Upper boundary','2024-01-02','2025-01-01',NULL,NULL)`);
  await pool.query(`INSERT INTO blocks(id,stream_id,author_kind,author_agent_id,to_agent_id,kind,text,created_at,updated_at)
    VALUES ('00000000-0000-4000-8000-000000000010','a1','agent','a2','a1','text','Child report to parent','2024-01-02','2024-01-02')`);
  app = Fastify();
  registerPortfolioBoundary(app);
  await registerPortfolioRoutes(app, pool);
  // First-run mode: normal endpoints would be open, but this credential must
  // still be rejected globally, even with an otherwise authorized cookie.
  for (const method of ["GET", "POST", "PATCH", "DELETE", "PUT"] as const) {
    app.route({
      method,
      url: "/api/v1/tasks",
      handler: () => ({ mutationOrFullAccount: true }),
    });
  }
});

async function page(query = window) {
  const response = await app.inject({
    url: `/api/v1/portfolio/v1/export?${query}`,
    headers,
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json();
}

describe("portfolio export", () => {
  it("fixture consumer enumerates allowed boards, archived sessions and nested outcomes without duplicates", async () => {
    let query = `${window}&limit=2`;
    const records: any[] = [];
    do {
      const result = await page(query);
      const retry = await page(`cursor=${result.pageCursor}&limit=2`);
      expect(retry).toEqual(result);
      records.push(...result.records);
      if (!result.nextCursor) break;
      query = `cursor=${result.nextCursor}&limit=2`;
    } while (true);
    expect(new Set(records.map((r) => `${r.type}:${r.id}`)).size).toBe(
      records.length
    );
    expect(records.filter((r) => r.type === "task").map((r) => r.id)).toEqual([
      "t1",
      "t2",
    ]);
    expect(records.find((r) => r.id === "t1").data).toMatchObject({
      body: "Acceptance criteria",
      archivedAt: expect.any(String),
      columnId: "c1",
      links: [{ kind: "pr", url: "https://example.com/pr/1", label: "PR" }],
    });
    expect(records.find((r) => r.id === "missing")).toMatchObject({
      data: { scope: "unavailable" },
      createdAt: null,
    });
    expect(records.find((r) => r.id === "work").data).toEqual({
      scope: "excluded",
    });
    expect(
      records.filter((r) => r.type === "outcome").map((r) => r.data.text)
    ).toEqual([
      "Root outcome",
      "Child outcome",
      "Task outcome",
      "Child report to parent",
    ]);
    expect(records.find((r) => r.id === "a2").data).toMatchObject({
      parentId: "a1",
      archivedAt: expect.any(String),
    });
    expect(JSON.stringify(records)).not.toMatch(
      /Work secret|Cross-project|Unknown membership|Secret prompt|Upper boundary/
    );
    await app.close();
  });

  it("requires a scoped credential even without a password and rejects cross-project queries", async () => {
    for (const authorization of [
      undefined,
      "Bearer wrong",
      `Bearer ${token}x`,
    ]) {
      const response = await app.inject({
        url: `/api/v1/portfolio/v1/export?${window}`,
        headers: authorization ? { authorization } : {},
      });
      expect(response.statusCode).toBe(401);
    }
    expect(
      (
        await app.inject({
          url: `/api/v1/portfolio/v1/export?${window}&projectId=work`,
          headers,
        })
      ).statusCode
    ).toBe(400);
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"] as const) {
      for (const authorization of [`Bearer ${token}`, `bearer ${token}`]) {
        expect(
          (
            await app.inject({
              method,
              url: "/api/v1/tasks",
              headers: { authorization, cookie: "dispatch_session=valid" },
            })
          ).statusCode
        ).toBe(403);
      }
    }
    for (const method of ["POST", "PATCH", "DELETE", "PUT", "HEAD"] as const) {
      expect(
        (
          await app.inject({
            method,
            url: "/api/v1/portfolio/v1/export",
            headers,
          })
        ).statusCode
      ).toBe(403);
    }
    await app.close();
  });

  it("revokes existing cursors and binds every page to the current allowlist", async () => {
    const first = await page(`${window}&limit=1`);
    await setSetting(
      pool,
      "portfolio_readers_v1",
      JSON.stringify([{ ...grant, revoked: true }])
    );
    expect(
      (
        await app.inject({
          url: `/api/v1/portfolio/v1/export?cursor=${first.nextCursor}`,
          headers,
        })
      ).statusCode
    ).toBe(401);
    await setSetting(
      pool,
      "portfolio_readers_v1",
      JSON.stringify([{ ...grant, projectIds: ["one"] }])
    );
    expect(
      (
        await app.inject({
          url: `/api/v1/portfolio/v1/export?cursor=${first.nextCursor}`,
          headers,
        })
      ).statusCode
    ).toBe(410);
    await setSetting(
      pool,
      "portfolio_readers_v1",
      JSON.stringify([{ ...grant, expiresAt: "2000-01-01T00:00:00Z" }])
    );
    expect(
      (
        await app.inject({
          url: `/api/v1/portfolio/v1/export?${window}`,
          headers,
        })
      ).statusCode
    ).toBe(401);
    await app.close();
  });

  it("keeps a snapshot stable across updates/deletions; new exports honestly show missing retained sources", async () => {
    const first = await page(`${window}&limit=4`);
    const next = await page(`cursor=${first.nextCursor}`);
    await pool.query("DELETE FROM projects WHERE id='two'");
    await pool.query("UPDATE tasks SET title='Changed' WHERE id='t1'");
    expect(await page(`cursor=${first.nextCursor}`)).toEqual(next);
    const fresh = await page();
    expect(
      fresh.records.find((r: any) => r.type === "project" && r.id === "two")
        .data.scope
    ).toBe("unavailable");
    expect(fresh.records.find((r: any) => r.id === "t1").data.title).toBe(
      "Changed"
    );
    expect(fresh.coverage.deletions).toBe("unavailable_no_tombstone_log");
    await app.close();
  });

  it("bounds prose/links, marks truncation, withholds credential patterns and missing outcomes", async () => {
    await pool.query("UPDATE tasks SET body=$1, links=$2 WHERE id='t1'", [
      "x".repeat(5000),
      JSON.stringify(
        Array.from({ length: 21 }, () => ({
          kind: "url",
          label: "x",
          url: "https://example.com",
        }))
      ),
    ]);
    await pool.query(
      "UPDATE blocks SET text='api_key=private-credential' WHERE id='00000000-0000-4000-8000-000000000001'"
    );
    await pool.query(
      "UPDATE blocks SET text='' WHERE id='00000000-0000-4000-8000-000000000003'"
    );
    const result = await page();
    const task = result.records.find((r: any) => r.id === "t1");
    expect(task.data.body).toHaveLength(4096);
    expect(task.data).toMatchObject({
      bodyTruncated: true,
      linksTruncated: true,
    });
    expect(task.data.links).toHaveLength(20);
    expect(JSON.stringify(result)).not.toContain("private-credential");
    expect(
      result.records.find(
        (r: any) => r.id === "00000000-0000-4000-8000-000000000001"
      ).data.coverage
    ).toBe("withheld_sensitive_content");
    expect(
      result.records.find(
        (r: any) => r.id === "00000000-0000-4000-8000-000000000003"
      ).data.coverage
    ).toBe("unavailable");
    await app.close();
  });

  it("fails explicitly at snapshot record capacity instead of returning partial inventory", async () => {
    await pool.query(
      "INSERT INTO projects(id,name,repo_root) SELECT 'bulk-'||n,'Bulk','/bulk-'||n FROM generate_series(1,10001) n"
    );
    expect(
      (
        await app.inject({
          url: `/api/v1/portfolio/v1/export?${window}`,
          headers,
        })
      ).statusCode
    ).toBe(413);
    await app.close();
  });

  it("rejects malformed windows/cursors and unknown or expired snapshots", async () => {
    for (const query of [
      "limit=101",
      `${window}&cursor=bad`,
      "from=2025-01-01T00:00:00Z&to=2024-01-01T00:00:00Z",
    ]) {
      expect(
        (
          await app.inject({
            url: `/api/v1/portfolio/v1/export?${query}`,
            headers,
          })
        ).statusCode
      ).toBe(400);
    }
    expect(
      (
        await app.inject({
          url: `/api/v1/portfolio/v1/export?cursor=${"b".repeat(48)}:1`,
          headers,
        })
      ).statusCode
    ).toBe(410);
    const first = await page(`${window}&limit=1`);
    expect(
      (
        await app.inject({
          url: `/api/v1/portfolio/v1/export?cursor=${first.nextCursor}&from=2021-01-01T00:00:00Z`,
          headers,
        })
      ).statusCode
    ).toBe(400);
    await app.close();
  });

  it("expires cursors and bounds the total payload and snapshot slots", async () => {
    const first = await page(`${window}&limit=1`);
    const realNow = Date.now();
    const clock = vi
      .spyOn(Date, "now")
      .mockReturnValue(realNow + 16 * 60 * 1000);
    try {
      expect(
        (
          await app.inject({
            url: `/api/v1/portfolio/v1/export?cursor=${first.nextCursor}`,
            headers,
          })
        ).statusCode
      ).toBe(410);
    } finally {
      clock.mockRestore();
    }
    for (let i = 0; i < 8; i++) await page();
    expect(
      (
        await app.inject({
          url: `/api/v1/portfolio/v1/export?${window}`,
          headers,
        })
      ).statusCode
    ).toBe(429);
    await app.close();
  });

  it("fails explicitly at the byte capacity and rolls back the read transaction", async () => {
    await pool.query(`INSERT INTO tasks(id,project_id,column_id,title,body,position,created_by_kind)
      SELECT 'bulk-'||n,'one','c1','Bulk',repeat('x',4096),n,'user' FROM generate_series(1,2100) n`);
    expect(
      (
        await app.inject({
          url: `/api/v1/portfolio/v1/export?${window}`,
          headers,
        })
      ).statusCode
    ).toBe(413);
    expect(
      (await pool.query("SELECT count(*)::int AS n FROM tasks")).rows[0].n
    ).toBe(2103);
    await app.close();
  });

  it("store does not seed board columns or mutate any source", async () => {
    await pool.query("DELETE FROM tasks");
    await pool.query("DELETE FROM task_columns");
    await new PortfolioStore(pool).snapshot(
      ["one"],
      "2020-01-01T00:00:00Z",
      "2025-01-01T00:00:00Z"
    );
    expect(
      (await pool.query("SELECT count(*)::int AS n FROM task_columns")).rows[0]
        .n
    ).toBe(0);
    await app.close();
  });
});
