/**
 * Job and template tools as an agent calls them, through the real MCP
 * transport and services. The controller's file system and process spawns are
 * recorded: a runner agent must not cause either on a path it names.
 */
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
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

import { JobService } from "../src/jobs/service.js";
import { registerMcpRoutes } from "../src/routes/mcp.js";
import { TemplateService } from "../src/templates/service.js";
import { runTestMigrations, setupTestDb, teardownTestDb } from "./db/setup.js";

const disk = vi.hoisted(() => {
  const calls: string[] = [];
  function record<T extends object>(module: T): T {
    const wrap = (value: unknown) =>
      typeof value === "function"
        ? new Proxy(value, {
            apply(target, self, args: unknown[]) {
              // Where it points: paths, argv and cwd, never file contents.
              for (const arg of args.slice(0, 3)) {
                if (typeof arg === "string") calls.push(arg);
                else if (Array.isArray(arg)) calls.push(arg.join(" "));
                else if (arg && typeof arg === "object" && "cwd" in arg)
                  calls.push(String(arg.cwd));
              }
              return Reflect.apply(target, self, args);
            },
          })
        : value;
    return Object.fromEntries(
      Object.entries(module).map(([name, value]) => [
        name,
        /^[a-z]/.test(name) ? wrap(value) : value,
      ])
    ) as T;
  }
  return { calls, record };
});
vi.mock("node:fs/promises", async (original) => disk.record(await original()));
vi.mock("node:fs", async (original) => disk.record(await original()));
vi.mock("node:child_process", async (original) =>
  disk.record(await original())
);

const HOME = "runner://rnr_test/@session";
const tools = [
  "create_job",
  "update_job",
  "create_template",
  "update_template",
];
const routes = ["agent", "job"] as const;

let app: FastifyInstance;
let origin: string;
let pool: Pool;
let root: string;
let projectId: string;
let otherProjectId: string;
let caller: { cwd: string; projectId: string | null };
let inRun: boolean;
const inspectCheckout = vi.fn();

function persona(body: string) {
  return `---\ntype: task\nname: Builder\ndescription: Builds\n---\n${body}`;
}

async function controllerFolder(name: string) {
  const folder = path.join(root, name);
  await mkdir(path.join(folder, ".agents/personas"), { recursive: true });
  await writeFile(
    path.join(folder, ".agents/personas/secret.md"),
    persona("controller instructions")
  );
  return folder;
}

async function call(
  tool: string,
  args: Record<string, unknown>,
  route: (typeof routes)[number] = "agent"
) {
  inRun = route === "job";
  const endpoint = inRun
    ? "/api/mcp/jobs/run_1/agt_caller"
    : "/api/mcp/agt_caller";
  // A real socket: the transport's close timer needs one after the response.
  const response = await fetch(origin + endpoint, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: tool, arguments: args },
    }),
  });
  const body = await response.text();
  const data = body.match(/^data: (.*)$/m)?.[1] ?? body;
  const { result } = JSON.parse(data);
  return { error: result.isError === true, text: result.content[0].text };
}

/** Arguments for a create, or for an update of a record stored at `stored`. */
async function argsFor(tool: string, stored: string) {
  const name = randomUUID();
  if (tool.startsWith("create")) return { name };
  const id = randomUUID();
  await pool.query(
    `INSERT INTO templates (id, name, directory, prompt) VALUES ($1, $2, $3, 'work')`,
    [id, name, stored]
  );
  if (tool === "update_template") return { templateId: id };
  const jobId = randomUUID();
  await pool.query(
    `INSERT INTO jobs (id, name, directory, prompt, template_id) VALUES ($1, $2, $3, 'work', $4)`,
    [jobId, name, stored, id]
  );
  return { jobId };
}

async function saved(tool: string, args: Record<string, unknown>) {
  const table = tool.endsWith("_job") ? "jobs" : "templates";
  const [column, value] = args.name
    ? ["name", args.name]
    : ["id", args.jobId ?? args.templateId];
  const { rows } = await pool.query(
    `SELECT directory, persona FROM ${table} WHERE ${column} = $1`,
    [value]
  );
  return rows[0] ?? null;
}

beforeAll(async () => {
  pool = await setupTestDb();
  await runTestMigrations();
  root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "save-boundary-"))
  );
  const project = async (name: string) =>
    (
      await pool.query(
        `INSERT INTO projects (id, name, repo_root, color) VALUES (gen_random_uuid(), $1, $2, '#336699') RETURNING id`,
        [name, await controllerFolder(name)]
      )
    ).rows[0].id;
  projectId = await project("project");
  otherProjectId = await project("other-project");

  const logger = { info() {}, warn() {}, error() {}, debug() {} } as never;
  const manager = {
    getAgent: async () => ({
      id: "agt_caller",
      name: "Caller",
      type: "codex",
      status: "running",
      fullAccess: false,
      worktreePath: null,
      workspacePath: null,
      ...caller,
    }),
    permitsRemoteAgentMcp: () => true,
    remoteRepoOperation: () => undefined,
    readRepoManifest: async () => null,
    inspectCheckout,
  };
  const jobService = new JobService(
    pool,
    manager as never,
    logger,
    {} as never
  );
  vi.spyOn(jobService, "getActiveRunForAgent").mockImplementation(async () =>
    inRun ? ({ id: "run_1" } as never) : null
  );
  app = Fastify();
  await registerMcpRoutes(app, {
    pool,
    config: { authToken: "test" },
    getBearerToken: () => null,
    agentManager: manager,
    jobService,
    templateService: new TemplateService(pool, manager as never, logger),
    mcpMethodNotAllowed: () => ({}),
  } as unknown as Parameters<typeof registerMcpRoutes>[1]);
  origin = await app.listen({ host: "127.0.0.1", port: 0 });
});

beforeEach(() => {
  caller = { cwd: HOME, projectId: null };
  inspectCheckout.mockReset().mockImplementation(async (_agent, query) => {
    if (query.kind === "roots")
      return { kind: "roots", checkoutRoot: null, repositoryRoot: null };
    if (query.kind === "readFile")
      return {
        kind: "readFile",
        content:
          query.path === ".agents/personas/runner-builder.md"
            ? persona("runner instructions")
            : null,
      };
    throw new Error(`Unexpected runner query: ${query.kind}`);
  });
});

afterAll(async () => {
  await app.close();
  await teardownTestDb();
  await rm(root, { recursive: true, force: true });
});

describe.each(routes)("a runner agent on the %s route", (route) => {
  it.each(tools)(
    "%s refuses a controller folder unread, whether or not it exists",
    async (tool) => {
      const present = await controllerFolder(`${route}-${tool}`);
      const missing = path.join(root, `${route}-${tool}-missing`);
      const results = [];
      for (const directory of [present, missing]) {
        const args = await argsFor(tool, HOME);
        disk.calls.length = 0;
        const result = await call(
          tool,
          { ...args, directory, persona: "secret" },
          route
        );
        expect(disk.calls.filter((entry) => entry.includes(root))).toEqual([]);
        expect(result.error).toBe(true);
        expect(result.text).toContain("own workspace");
        expect(result.text).not.toContain(root);
        expect((await saved(tool, args))?.persona ?? null).toBeNull();
        results.push(result);
      }
      expect(results[0]).toEqual(results[1]);
    }
  );

  it.each(tools)(
    "%s resolves a persona for its workspace from the runner",
    async (tool) => {
      caller.projectId = projectId;
      const args = await argsFor(tool, HOME);
      disk.calls.length = 0;
      const result = await call(
        tool,
        { ...args, projectId, persona: "runner-builder" },
        route
      );
      expect(result.error, result.text).toBe(false);
      expect(inspectCheckout).toHaveBeenCalledWith(
        expect.objectContaining({ id: "agt_caller", cwd: HOME }),
        { kind: "readFile", path: ".agents/personas/runner-builder.md" }
      );
      expect(disk.calls.filter((entry) => entry.includes(root))).toEqual([]);
      expect(await saved(tool, args)).toEqual({
        directory: HOME,
        persona: "runner-builder",
      });
    }
  );
});

describe("a runner agent", () => {
  it.each(tools)("%s refuses every other kind of folder", async (tool) => {
    for (const directory of [
      "~",
      "relative/folder",
      "/",
      ` ${root}`,
      "runner://rnr_other/@session",
      "runner://rnr_test/elsewhere",
      "runner://broken",
    ]) {
      const args = await argsFor(tool, HOME);
      // No persona: the folder alone would later become a controller launch.
      const result = await call(tool, { ...args, directory });
      expect(result.error, directory).toBe(true);
      expect(result.text).toContain("own workspace");
    }
  });

  it.each(tools)("%s refuses another project", async (tool) => {
    caller.projectId = projectId;
    const args = await argsFor(tool, HOME);
    disk.calls.length = 0;
    const result = await call(tool, {
      ...args,
      projectId: otherProjectId,
      persona: "secret",
    });
    expect(result.error).toBe(true);
    expect(result.text).toContain("own project");
    expect(disk.calls.filter((entry) => entry.includes(root))).toEqual([]);
  });

  it.each(["update_job", "update_template"])(
    "%s does not resolve a persona in a stored controller folder",
    async (tool) => {
      const folder = await controllerFolder(`stored-${tool}`);
      const args = await argsFor(tool, folder);
      disk.calls.length = 0;
      // A persona the runner has, so only the folder can be what refuses it.
      const result = await call(tool, { ...args, persona: "runner-builder" });
      expect(disk.calls.filter((entry) => entry.includes(root))).toEqual([]);
      expect(result.error).toBe(true);
      expect(result.text).toContain("own workspace");
      expect(result.text).not.toContain(root);
    }
  );
});

describe("a local agent", () => {
  it.each(tools)("%s still reads the folder it names", async (tool) => {
    caller.cwd = root;
    const folder = await controllerFolder(`local-${tool}`);
    const args = await argsFor(tool, root);
    disk.calls.length = 0;
    const result = await call(tool, {
      ...args,
      directory: folder,
      persona: "secret",
    });
    expect(result.error, result.text).toBe(false);
    // Also proves the recorder sees the reads the runner cases assert absent.
    expect(disk.calls).toContain(
      path.join(folder, ".agents/personas/secret.md")
    );
    expect(await saved(tool, args)).toEqual({
      directory: folder,
      persona: "secret",
    });
  });
});
