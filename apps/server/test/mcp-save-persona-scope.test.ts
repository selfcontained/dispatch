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

import type { AgentManager } from "../src/agents/manager.js";
import { placementForRunner } from "../src/runners/placement.js";
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

const HOME = "/srv/checkout";
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
let jobService: JobService;
let templateService: TemplateService;
const createAgent = vi.fn<AgentManager["createAgent"]>();
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
  if (stored === HOME)
    await pool.query(
      "UPDATE templates SET directory='', location=$2 WHERE id=$1",
      [id, { runner: "rnr_test", projectId }]
    );
  if (tool === "update_template") return { templateId: id };
  const jobId = randomUUID();
  await pool.query(
    `INSERT INTO jobs (id, name, directory, prompt, template_id) VALUES ($1, $2, $3, 'work', $4)`,
    [jobId, name, stored, id]
  );
  if (stored === HOME)
    await pool.query("UPDATE jobs SET directory='', location=$2 WHERE id=$1", [
      jobId,
      { runner: "rnr_test", projectId },
    ]);
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
    await mkdtemp(path.join(os.tmpdir(), "save-persona-scope-"))
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
    checkoutReadRunners: () => ({}),
    getAgent: async () => ({
      id: "agt_caller",
      name: "Caller",
      type: "codex",
      status: "running",
      fullAccess: false,
      worktreePath: null,
      workspacePath: null,
      placement: placementForRunner(caller.cwd === HOME ? "rnr_test" : "local"),
      ...caller,
    }),
    permitsRemoteAgentMcp: () => true,
    readRepoManifest: async () => null,
    inspectCheckout,
    createAgent,
  };
  jobService = new JobService(pool, manager as never, logger, {} as never);
  vi.spyOn(jobService, "getActiveRunForAgent").mockImplementation(async () =>
    inRun ? ({ id: "run_1" } as never) : null
  );
  templateService = new TemplateService(pool, manager as never, logger);
  app = Fastify();
  await registerMcpRoutes(app, {
    pool,
    config: { authToken: "test" },
    getBearerToken: () => null,
    agentManager: manager,
    jobService,
    templateService,
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
  await jobService.shutdown();
  await teardownTestDb();
  await rm(root, { recursive: true, force: true });
});

describe.each(routes)("a runner agent on the %s route", (route) => {
  it.each(tools)(
    "%s resolves a persona in its workspace even when saving to another project",
    async (tool) => {
      caller.projectId = projectId;
      const args = await argsFor(tool, HOME);
      disk.calls.length = 0;
      const result = await call(
        tool,
        { ...args, projectId: otherProjectId, persona: "runner-builder" },
        route
      );
      expect(result.error, result.text).toBe(false);
      expect(inspectCheckout).toHaveBeenCalledWith(
        expect.objectContaining({ id: "agt_caller", cwd: HOME }),
        { kind: "readFile", path: ".agents/personas/runner-builder.md" }
      );
      expect(disk.calls.filter((entry) => entry.includes(root))).toEqual([]);
      expect(await saved(tool, args)).toEqual({
        directory: "",
        persona: "runner-builder",
      });
    }
  );
});

describe.each(["runner", "local"])("a %s agent", (location) => {
  it.each(tools)("%s still reads the folder it names", async (tool) => {
    if (location === "local") caller.cwd = root;
    const folder = await controllerFolder(`local-${tool}`);
    const args = await argsFor(tool, root);
    disk.calls.length = 0;
    const result = await call(tool, {
      ...args,
      directory: folder,
      persona: "secret",
    });
    expect(result.error, result.text).toBe(false);
    expect(disk.calls).toContain(
      path.join(folder, ".agents/personas/secret.md")
    );
    expect(await saved(tool, args)).toEqual({
      directory: folder,
      persona: "secret",
    });
  });
});

it.each(["update_job", "update_template"])(
  "%s resolves a persona in the stored controller folder for a runner caller",
  async (tool) => {
    const folder = await controllerFolder(`stored-${tool}`);
    const args = await argsFor(tool, folder);
    const result = await call(tool, { ...args, persona: "secret" });
    expect(result.error, result.text).toBe(false);
    expect(await saved(tool, args)).toEqual({
      directory: folder,
      persona: "secret",
    });
  }
);

it.each(["job", "template"])(
  "saves and launches a runner caller's %s on its project",
  async (kind) => {
    caller.projectId = projectId;
    const name = `creator-${kind}`;
    const reply = await call(`create_${kind}`, { name, prompt: "Work." });
    expect(reply.error, reply.text).toBe(false);
    const table = kind === "job" ? "jobs" : "templates";
    const {
      rows: [saved],
    } = await pool.query(
      `SELECT id, directory, location FROM ${table} WHERE name = $1`,
      [name]
    );
    expect(saved).toMatchObject({
      directory: "",
      location: { runner: "rnr_test", projectId },
    });
    createAgent.mockRejectedValueOnce(new Error("launch captured"));
    const launch =
      kind === "job"
        ? jobService.runJob({ jobId: saved.id, wait: false })
        : templateService.launchTemplate({ templateId: saved.id });
    await expect(launch).rejects.toThrow("launch captured");
    expect(createAgent.mock.lastCall?.[0]).toMatchObject({
      cwd: "",
      placement: placementForRunner("rnr_test"),
      projectId,
      repository: expect.any(Object),
    });
  }
);

it.each(["job", "template"])(
  "accepts controller and offline runner selections for a %s",
  async (kind) => {
    caller.projectId = projectId;
    const table = kind === "job" ? "jobs" : "templates";
    for (const runner of ["local", "offline-runner"]) {
      const name = `${runner}-${kind}`;
      const reply = await call(`create_${kind}`, {
        name,
        runner,
        prompt: "Work.",
      });
      expect(reply.error, reply.text).toBe(false);
      const directory = runner === "local" ? path.join(root, "project") : "";
      expect(
        (
          await pool.query(
            `SELECT directory, location FROM ${table} WHERE name = $1`,
            [name]
          )
        ).rows
      ).toEqual([
        {
          directory,
          location:
            runner === "local"
              ? { runner, path: directory }
              : { runner, projectId },
        },
      ]);
    }
  }
);
