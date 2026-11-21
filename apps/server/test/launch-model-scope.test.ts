import type { Pool } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { AgentManager } from "../src/agents/manager.js";
import type { AppConfig } from "../src/config.js";
import { JobService } from "../src/jobs/service.js";
import {
  forgetLearnedAgentModels,
  modelScopeFor,
  setRunnerModelCatalogSource,
  validateAgentModel,
} from "../src/shared/agent-models.js";
import { validateAgentEffort } from "../src/shared/agent-effort.js";
import { TaskService } from "../src/tasks/service.js";
import { TemplateService } from "../src/templates/service.js";
import type { TemplateRecord } from "../src/templates/store.js";
import { runTestMigrations, setupTestDb, teardownTestDb } from "./db/setup.js";

/**
 * Every launch caller checks a model id against the catalog of the machine
 * the agent will run on. "opus" is only in this Mac's seed catalog;
 * "runner-model" only in the online runner's.
 */
const LOCAL = "/repo/model-scope";
const ONLINE = "runner://online/@session";
const OFFLINE = "runner://offline/@session";
const LOCAL_ONLY = "opus";
const RUNNER_ONLY = "runner-model";

let pool: Pool;
let projectId: string;
const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: () => logger,
} as never;

beforeAll(async () => {
  pool = await setupTestDb();
  await runTestMigrations();
  projectId = (
    await pool.query<{ id: string }>(
      `INSERT INTO projects (id, name, repo_root, color) VALUES (gen_random_uuid(), 'Scope', $1, '#336699') RETURNING id`,
      [LOCAL]
    )
  ).rows[0]!.id;
});

afterAll(async () => {
  await teardownTestDb();
});

beforeEach(() => {
  forgetLearnedAgentModels();
  setRunnerModelCatalogSource(async (runnerId) =>
    runnerId === "online"
      ? {
          defaultModel: RUNNER_ONLY,
          models: [
            {
              id: RUNNER_ONLY,
              label: "Runner model",
              effort: [{ value: "turbo", name: "Turbo" }],
            },
          ],
        }
      : null
  );
});

afterEach(() => setRunnerModelCatalogSource(null));

function template(directory: string): TemplateRecord {
  const now = new Date().toISOString();
  return {
    id: `tpl_${directory.replace(/\W/g, "_")}`,
    projectId,
    directory,
    name: "Scope",
    description: null,
    prompt: "Build",
    agentType: "claude",
    model: null,
    effort: null,
    useWorktree: false,
    baseBranch: null,
    branchName: null,
    fullAccess: false,
    callable: true,
    allowFiles: true,
    selfImprove: false,
    createdAt: now,
    updatedAt: now,
  };
}

const templateById = (id: string) =>
  [LOCAL, ONLINE, OFFLINE].map(template).find((t) => t.id === id) ?? null;

function taskService() {
  return new TaskService({
    pool,
    filesRoot: "/tmp/dispatch-model-scope-files",
    getAgent: async () => null,
    getTemplate: async (id) => templateById(id),
    launchTemplate: async () => {
      throw new Error("not launched");
    },
    publishUiEvent: () => {},
    log: logger,
  } as unknown as ConstructorParameters<typeof TaskService>[0]);
}

const createAgent = vi.fn(async () => ({ id: "agt_scope" }));
const agentManager = { createAgent } as unknown as AgentManager;

let seq = 0;
type Caller = (cwd: string, model: string) => Promise<unknown>;
const callers: Record<string, { offline: "local" | "engine"; run: Caller }> = {
  "template create": {
    offline: "local",
    run: (directory, model) =>
      new TemplateService(pool, agentManager, logger).addTemplate({
        name: `scope-${++seq}`,
        directory,
        agentType: "claude",
        model,
      }),
  },
  "template launch": {
    offline: "local",
    run: (directory, model) =>
      new TemplateService(pool, agentManager, logger).launchTemplate({
        templateId: template(directory).id,
        resolvedTemplate: template(directory),
        model,
      }),
  },
  "job create": {
    offline: "local",
    run: (directory, model) =>
      new JobService(pool, agentManager, logger, {
        agentRuntime: "inert",
      } as AppConfig).addJob({
        name: `scope-${++seq}`,
        directory,
        prompt: "Run",
        agentType: "claude",
        model,
      }),
  },
  "task column trigger": {
    offline: "local",
    run: (directory, model) =>
      taskService().createColumn(projectId, {
        name: `Scope ${++seq}`,
        trigger: { templateId: template(directory).id, model },
      }),
  },
  "task model override": {
    offline: "local",
    run: (directory, model) =>
      taskService().createTask(
        {
          projectId,
          title: `Scope ${++seq}`,
          launchTemplateId: template(directory).id,
          launchAgentType: "claude",
          launchModel: model,
        },
        { kind: "user" }
      ),
  },
  // Create Agent, MCP launch_agent and reviewer launches share this check.
  "agent launch": {
    offline: "engine",
    run: async (cwd, model) =>
      validateAgentModel(
        "claude",
        model,
        await modelScopeFor(cwd, "claude", "engine")
      ),
  },
};

const cases = [
  { target: "local folder", cwd: LOCAL, model: LOCAL_ONLY, ok: true },
  { target: "local folder", cwd: LOCAL, model: RUNNER_ONLY, ok: false },
  { target: "runner with catalog", cwd: ONLINE, model: RUNNER_ONLY, ok: true },
  { target: "runner with catalog", cwd: ONLINE, model: LOCAL_ONLY, ok: false },
  // Without a catalog each caller keeps what it checked before.
  {
    target: "offline runner",
    cwd: OFFLINE,
    model: LOCAL_ONLY,
    ok: true,
  },
  {
    target: "offline runner",
    cwd: OFFLINE,
    model: RUNNER_ONLY,
    ok: "engine" as const,
  },
];

describe("placement-scoped model validation", () => {
  it.each(
    Object.entries(callers).flatMap(([caller, { offline, run }]) =>
      cases.map(({ ok, ...row }) => ({
        caller,
        run,
        ...row,
        ok: ok === "engine" ? offline === "engine" : ok,
      }))
    )
  )("$caller: $model on $target → ok=$ok", async ({ run, cwd, model, ok }) => {
    const result = run(cwd, model);
    if (ok) await expect(result).resolves.not.toThrow();
    else await expect(result).rejects.toThrow(/not supported/);
  });

  it("checks effort against the runner's levels for the model", async () => {
    const scope = await modelScopeFor(ONLINE, "claude", "local");
    expect(validateAgentEffort("claude", "turbo", RUNNER_ONLY, scope)).toBe(
      "turbo"
    );
    // The runner's default model applies when none is chosen.
    expect(() => validateAgentEffort("claude", "max", null, scope)).toThrow(
      /not supported for this model/
    );
    await expect(
      new TemplateService(pool, agentManager, logger).addTemplate({
        name: `scope-${++seq}`,
        directory: ONLINE,
        agentType: "claude",
        model: RUNNER_ONLY,
        effort: "max",
      })
    ).rejects.toThrow(/not supported for this model/);
  });
});
