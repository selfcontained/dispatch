import {
  resolveSavedTarget,
  targetPlacement,
} from "../src/runners/saved-location.js";
import { readRepositoryRoot } from "./helpers/task-scope.js";
import { launchPersonaScope } from "../src/personas/persona-scope.js";
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
  getAgentModelOptions,
  modelScopeFor,
  setLearnedAgentModels,
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
const ONLINE = "online";
const OFFLINE = "offline";
const LOCAL_ONLY = "opus";
const RUNNER_ONLY = "runner-model";

let pool: Pool;
let projectId: string;
const loggerWarn = vi.fn();
const logger = {
  info: vi.fn(),
  warn: loggerWarn,
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
  loggerWarn.mockClear();
  // These cases exercise an authoritative catalog; cold validation is covered
  // by the real coordinator in model-catalog-refresh and reviewer fixtures.
  setLearnedAgentModels("claude", getAgentModelOptions("claude"));
  setLearnedAgentModels(
    "claude",
    [
      {
        id: RUNNER_ONLY,
        label: "Runner model",
        effort: [{ value: "turbo", name: "Turbo" }],
      },
    ],
    RUNNER_ONLY,
    "online"
  );
  setLearnedAgentModels(
    "claude",
    [{ id: RUNNER_ONLY, label: "Runner model" }],
    RUNNER_ONLY,
    "offline"
  );
});
afterEach(forgetLearnedAgentModels);

const fields = (directory: string) => ({
  directory: directory === LOCAL ? LOCAL : "",
  ...(directory !== LOCAL && { runner: directory }),
  projectId,
});
const location = (directory: string) =>
  resolveSavedTarget(fields(directory).directory, fields(directory));
function template(directory: string): TemplateRecord {
  const now = new Date().toISOString();
  return {
    id: `tpl_${directory.replace(/\W/g, "_")}`,
    projectId,
    ...location(directory),
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
    readRepositoryRoot,
    pool,
    filesRoot: "/tmp/dispatch-model-scope-files",
    getAgent: async () => null,
    getTemplate: async (id) => templateById(id),
    launchTemplate: async () => {
      throw new Error("not launched");
    },
    publishUiEvent: () => {},
    log: logger,
    personaScope: (target) =>
      launchPersonaScope({ checkoutReadRunners: () => ({}) } as never, target),
  } as unknown as ConstructorParameters<typeof TaskService>[0]);
}

const createAgent = vi.fn(async () => ({ id: "agt_scope" }));
const agentManager = { createAgent } as unknown as AgentManager;

let seq = 0;
type Caller = (cwd: string, model: string) => Promise<unknown>;
const callers: Record<string, { run: Caller }> = {
  "template create": {
    run: (directory, model) =>
      new TemplateService(pool, agentManager, logger).addTemplate({
        name: `scope-${++seq}`,
        ...fields(directory),
        agentType: "claude",
        model,
      }),
  },
  "template update": {
    run: async (directory, model) => {
      const service = new TemplateService(pool, agentManager, logger);
      const existing = await service.addTemplate({
        name: `scope-${++seq}`,
        ...fields(directory),
        agentType: "claude",
      });
      return service.updateTemplate(existing.id, { model });
    },
  },
  "template launch": {
    run: (directory, model) =>
      new TemplateService(pool, agentManager, logger).launchTemplate({
        templateId: template(directory).id,
        resolvedTemplate: template(directory),
        model,
      }),
  },
  "job create": {
    run: (directory, model) =>
      new JobService(pool, agentManager, logger, {
        agentRuntime: "inert",
      } as AppConfig).addJob({
        name: `scope-${++seq}`,
        ...fields(directory),
        prompt: "Run",
        agentType: "claude",
        model,
      }),
  },
  "job update": {
    run: async (directory, model) => {
      const service = new JobService(pool, agentManager, logger, {
        agentRuntime: "inert",
      } as AppConfig);
      const existing = await service.addJob({
        name: `scope-${++seq}`,
        ...fields(directory),
        prompt: "Run",
        agentType: "claude",
      });
      return service.updateJob({ jobId: existing.id, model });
    },
  },
  "task column trigger": {
    run: (directory, model) =>
      taskService().createColumn(projectId, {
        name: `Scope ${++seq}`,
        trigger: { templateId: template(directory).id, model },
      }),
  },
  "task model override": {
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
    run: async (cwd, model) =>
      validateAgentModel(
        "claude",
        model,
        await modelScopeFor(targetPlacement(location(cwd)), "claude")
      ),
  },
};

const cases = [
  { target: "local folder", cwd: LOCAL, model: LOCAL_ONLY, ok: true },
  { target: "local folder", cwd: LOCAL, model: RUNNER_ONLY, ok: false },
  { target: "runner with catalog", cwd: ONLINE, model: RUNNER_ONLY, ok: true },
  { target: "runner with catalog", cwd: ONLINE, model: LOCAL_ONLY, ok: false },
  { target: "offline runner", cwd: OFFLINE, model: "invalid model", ok: false },
  {
    target: "offline runner",
    cwd: OFFLINE,
    model: LOCAL_ONLY,
    ok: false,
  },
  {
    target: "offline runner",
    cwd: OFFLINE,
    model: RUNNER_ONLY,
    ok: true,
  },
];

describe("placement-scoped model validation", () => {
  it.each(
    Object.entries(callers).flatMap(([caller, { run }]) =>
      cases.map((row) => ({ caller, run, ...row }))
    )
  )("$caller: $model on $target → ok=$ok", async ({ run, cwd, model, ok }) => {
    const result = run(cwd, model);
    if (ok) await expect(result).resolves.not.toThrow();
    else await expect(result).rejects.toThrow(/not supported/);
    expect(loggerWarn).not.toHaveBeenCalled();
  });

  it("rechecks a stored task model when only the launch template changes", async () => {
    const service = taskService();
    const task = await service.createTask(
      {
        projectId,
        title: `Scope ${++seq}`,
        launchTemplateId: template(LOCAL).id,
        launchAgentType: "claude",
        launchModel: LOCAL_ONLY,
      },
      { kind: "user" }
    );
    await expect(
      service.updateTask(
        task.id,
        { launchTemplateId: template(ONLINE).id },
        { kind: "user" }
      )
    ).rejects.toThrow(/Model "opus" is not supported for claude/);
    expect(await service.getTaskDetail(task.id)).toMatchObject({
      launchTemplateId: template(LOCAL).id,
      launchModel: LOCAL_ONLY,
    });
    // An offline runner still validates against its stored catalog.
    await expect(
      service.updateTask(
        task.id,
        { launchTemplateId: template(OFFLINE).id },
        { kind: "user" }
      )
    ).rejects.toThrow(/not supported/);
  });

  it("accepts a well-formed task model before the project has a launch target", async () => {
    const bare = (
      await pool.query<{ id: string }>(
        `INSERT INTO projects (id, name, repo_root, color) VALUES (gen_random_uuid(), 'Bare', $1, '#336699') RETURNING id`,
        [`${LOCAL}-bare-${++seq}`]
      )
    ).rows[0]!.id;
    const service = taskService();
    await expect(
      service.createTask(
        {
          projectId: bare,
          title: "Runner-only model",
          launchAgentType: "claude",
          launchModel: RUNNER_ONLY,
        },
        { kind: "user" }
      )
    ).resolves.toMatchObject({ launchModel: RUNNER_ONLY });
    await expect(
      service.createTask(
        {
          projectId: bare,
          title: "Malformed model",
          launchAgentType: "claude",
          launchModel: "invalid model",
        },
        { kind: "user" }
      )
    ).rejects.toThrow(/not supported/);
  });

  it("checks effort against the runner's levels for the model", async () => {
    const scope = await modelScopeFor(
      targetPlacement(location(ONLINE)),
      "claude"
    );
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
        ...fields(ONLINE),
        agentType: "claude",
        model: RUNNER_ONLY,
        effort: "max",
      })
    ).rejects.toThrow(/not supported for this model/);
  });
});
