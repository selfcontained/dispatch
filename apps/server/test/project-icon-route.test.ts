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

import type { AgentManager } from "../src/agents/manager.js";
import type { RemoteRunnerService } from "../src/agents/remote/service.js";
import { checkoutWorkload } from "./helpers/checkout-workload.js";
import {
  controllerPlacement,
  placementForRunner,
} from "../src/runners/placement.js";
import { registerAgentCrudRoutes } from "../src/routes/agents/crud-routes.js";
import type { AgentRouteDeps } from "../src/routes/agents/shared.js";
import { registerProjectRoutes } from "../src/routes/projects.js";
import type { TaskService } from "../src/tasks/service.js";
import { runTestMigrations, setupTestDb, teardownTestDb } from "./db/setup.js";

let pool: Pool;
let app: ReturnType<typeof Fastify>;
let root: string;
/** The checkout the fixture runner holds for each session it serves. */
const checkouts = new Map<string, string>();
const served: string[] = [];
// A fixture enrolled runner at the transport seam: it serves each session's
// launch checkout with the runner's own checkout workload.
const remote = {
  runnerDescriptions: () => [],
  call(
    _placement: unknown,
    op: string,
    request: { target: { session: string }; [key: string]: unknown }
  ) {
    const { target, ...rest } = request;
    served.push(`${op} ${String(target.session)}`);
    const directory = checkouts.get(String(target.session));
    if (!directory) return Promise.resolve(null);
    return checkoutWorkload.run(
      op as never,
      { directory, request: rest } as never
    );
  },
} as unknown as RemoteRunnerService;
const runnerAgents = new Map<string, object>();
const agents = {
  getAgent: async (id: string) => runnerAgents.get(id) ?? null,
  checkoutReadRunners: () => ({
    local: undefined,
    remote,
    child: () => undefined,
  }),
} as unknown as Pick<AgentManager, "getAgent" | "checkoutReadRunners">;

beforeAll(async () => {
  pool = await setupTestDb();
  await runTestMigrations();
  root = mkdtempSync(path.join(tmpdir(), "dispatch-project-icon-"));
  app = Fastify();
  await registerProjectRoutes(app, {
    pool,
    taskService: {} as TaskService,
    publishUiEvent: () => {},
    agents,
  });
  await registerAgentCrudRoutes(app, {
    pool,
    agentManager: agents,
  } as unknown as AgentRouteDeps);
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
    for (const repoRoot of [root, "/fixture/rnr_icon/checkout"]) {
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

describe("GET /api/v1/projects/:id/icon: a project with no folder", () => {
  async function repositoryProject(): Promise<string> {
    return (
      await pool.query<{ id: string }>(
        `INSERT INTO projects (id, name, repo_root, color, repository) VALUES (gen_random_uuid(), 'remote', NULL, '#336699', 'https://github.com/acme/' || gen_random_uuid()) RETURNING id`
      )
    ).rows[0]!.id;
  }
  async function runnerAgent(
    projectId: string,
    files: Record<string, string | Buffer>,
    createdAt: string
  ): Promise<string> {
    const id = `agt_${Math.random().toString(16).slice(2, 14)}`;
    const cwd = "/fixture/rnr_icon/checkout";
    await pool.query(
      `INSERT INTO agents (id, name, type, status, cwd, launch_cwd, project_id, runner_id, created_at)
       VALUES ($1, $1, 'claude', 'running', $2, $2, $3, 'rnr_icon', $4)`,
      [id, cwd, projectId, createdAt]
    );
    const checkout = mkdtempSync(path.join(root, "checkout-"));
    for (const [name, data] of Object.entries(files))
      writeFileSync(path.join(checkout, name), data);
    checkouts.set(id, checkout);
    runnerAgents.set(id, {
      id,
      cwd,
      launchCwd: cwd,
      worktreePath: null,
      workspacePath: null,
      gitContext: null,
      placement: placementForRunner("rnr_icon"),
    });
    return id;
  }

  it("shows the icon of its newest agent's checkout, read on that agent's runner", async () => {
    const id = await repositoryProject();
    await runnerAgent(id, { "favicon.svg": "<svg>old</svg>" }, "2026-01-01");
    const newest = await runnerAgent(
      id,
      { "logo.svg": "<svg>new</svg>" },
      "2026-02-01"
    );
    served.length = 0;
    const res = await icon(id);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("image/svg+xml");
    expect(res.headers["cache-control"]).toBe("private, max-age=86400");
    expect(res.body).toBe("<svg>new</svg>");
    expect(served.every((call) => call.endsWith(newest))).toBe(true);
    expect(served).toContain(`checkout.read ${newest}`);
    // The durable copy serves it from then on, as for a folder.
    checkouts.delete(newest);
    expect((await icon(id)).body).toBe("<svg>new</svg>");
  });

  it("answers main's empty 404 with no agent, no icon, or an oversized one", async () => {
    const none = await repositoryProject();
    const bare = await repositoryProject();
    await runnerAgent(bare, { "README.md": "x" }, "2026-01-01");
    const big = await repositoryProject();
    await runnerAgent(
      big,
      { "icon.png": Buffer.alloc(2 * 1024 * 1024 + 1) },
      "2026-01-01"
    );
    for (const id of [none, bare, big]) {
      const res = await icon(id);
      expect(res.statusCode).toBe(404);
      expect(res.body).toBe("");
    }
  });
});

// The agent icon route's cache key (T15c, ruling A): main's folder key on
// the controller's runner; on any other runner, the project's repository
// URL, or no key (a probe each time). A URL is never an absolute path, so
// the two key spaces cannot collide.
describe("GET /api/v1/agents/:id/repo-icon: the icon cache key", () => {
  const agentIcon = (id: string) =>
    app.inject({ method: "GET", url: `/api/v1/agents/${id}/repo-icon` });
  const keys = async (like: string) =>
    (
      await pool.query<{ cwd: string; icon_path: string | null }>(
        "SELECT cwd, icon_path FROM directory_icons WHERE cwd LIKE $1 ORDER BY cwd",
        [like]
      )
    ).rows;
  async function projectRow(
    repoRoot: string | null,
    repository: string | null
  ) {
    return (
      await pool.query<{ id: string }>(
        `INSERT INTO projects (id, name, repo_root, color, repository) VALUES (gen_random_uuid(), 'p', $1, '#336699', $2) RETURNING id`,
        [repoRoot, repository]
      )
    ).rows[0]!.id;
  }
  let n = 0;
  function onRunner(
    projectId: string | null,
    files: Record<string, string>
  ): string {
    const id = `agt_key${++n}${Math.random().toString(16).slice(2, 8)}`;
    const cwd = "/fixture/rnr_keys/checkout";
    const checkout = mkdtempSync(path.join(root, "key-checkout-"));
    for (const [name, data] of Object.entries(files))
      writeFileSync(path.join(checkout, name), data);
    checkouts.set(id, checkout);
    runnerAgents.set(id, {
      id,
      cwd,
      launchCwd: cwd,
      worktreePath: null,
      workspacePath: null,
      gitContext: null,
      projectId,
      placement: placementForRunner("rnr_keys"),
    });
    return id;
  }
  function onController(folder: string, projectId: string | null): string {
    const id = `agt_loc${++n}${Math.random().toString(16).slice(2, 8)}`;
    runnerAgents.set(id, {
      id,
      cwd: folder,
      launchCwd: folder,
      worktreePath: null,
      workspacePath: null,
      gitContext: null,
      baseBranch: null,
      projectId,
      placement: controllerPlacement,
    });
    return id;
  }

  it("gives two projects on one runner each their own answer", async () => {
    const url = (name: string) =>
      `https://github.com/acme/${name}-${Math.random().toString(16).slice(2)}`;
    for (const order of ["bare first", "icon first"]) {
      const withIcon = onRunner(await projectRow(null, url("icon")), {
        "favicon.svg": "<svg>mine</svg>",
      });
      const without = onRunner(await projectRow(null, url("bare")), {
        "README.md": "x",
      });
      const sequence =
        order === "bare first" ? [without, withIcon] : [withIcon, without];
      for (const id of sequence) {
        const res = await agentIcon(id);
        if (id === withIcon) {
          expect(res.statusCode, order).toBe(200);
          expect(res.body).toBe("<svg>mine</svg>");
        } else {
          expect(res.statusCode, order).toBe(404);
          expect(res.json()).toEqual({ error: "No repo icon." });
        }
      }
    }
    // Runner agents never key by a shared machine-local directory.
    expect(await keys("/fixture/rnr_keys/%")).toEqual([]);
  });

  it("keys a runner agent by its project's repository URL, never a path", async () => {
    const repository = `https://github.com/acme/url-${Math.random().toString(16).slice(2)}`;
    const id = onRunner(await projectRow(null, repository), {
      "logo.svg": "<svg/>",
    });
    expect((await agentIcon(id)).statusCode).toBe(200);
    const rows = await keys(repository);
    expect(rows).toEqual([{ cwd: repository, icon_path: "logo.svg" }]);
    expect(path.isAbsolute(rows[0]!.cwd)).toBe(false);
  });

  it("probes each time, with no entry, for a runner agent without a repository", async () => {
    const id = onRunner(null, { "favicon.svg": "<svg>one</svg>" });
    const before = await keys("%");
    expect((await agentIcon(id)).body).toBe("<svg>one</svg>");
    // The checkout changes: a second request sees it at once.
    rmSync(path.join(checkouts.get(id)!, "favicon.svg"));
    writeFileSync(path.join(checkouts.get(id)!, "logo.png"), "png");
    const again = await agentIcon(id);
    expect(again.statusCode).toBe(200);
    expect(again.body).toBe("png");
    expect(await keys("%")).toEqual(before);
  });

  it("keeps a local folder's entry and a runner agent's entry of that project apart, both ways", async () => {
    for (const order of ["runner first", "local first"]) {
      const folder = mkdtempSync(path.join(root, "shared-folder-"));
      writeFileSync(path.join(folder, "favicon.svg"), "<svg>local</svg>");
      const repository = `https://github.com/acme/shared-${Math.random().toString(16).slice(2)}`;
      const projectId = await projectRow(folder, repository);
      const local = onController(folder, projectId);
      // The runner's checkout is on another branch: a different icon, at a
      // path the local folder does not have.
      const runner = onRunner(projectId, { "brand.png": "runner-png" });
      const sequence =
        order === "runner first" ? [runner, local] : [local, runner];
      for (const id of sequence) {
        const res = await agentIcon(id);
        expect(res.statusCode, `${order} ${id}`).toBe(200);
        expect(res.body).toBe(id === local ? "<svg>local</svg>" : "runner-png");
      }
      expect(await keys(folder)).toEqual([
        { cwd: folder, icon_path: "favicon.svg" },
      ]);
      expect(await keys(repository)).toEqual([
        { cwd: repository, icon_path: "brand.png" },
      ]);
    }
  });
});
