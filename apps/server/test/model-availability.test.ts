import { enrolledRunnerSettings } from "../src/runners/settings-namespace.js";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { recordEngineModels } from "../src/agents/engine-models.js";
import {
  loadModelAvailability,
  recordListedModels,
  updateModelAvailability,
  settingsModelCatalog,
} from "../src/agents/model-availability.js";
import { toAgentConfigOptions } from "../src/agents/usage-report.js";
import { registerAgentUsageRoutes } from "../src/routes/agents/usage-routes.js";
import { registerSystemRoutes } from "../src/routes/system.js";
import {
  agentModelAvailability,
  agentModelCatalog,
  applyAgentConfigDefaults,
  describeAgentModelCatalog,
  forgetLearnedAgentModels,
  getAgentModelAvailability,
  getReportedModelHistory,
  selectableAgentModels,
  resolveAgentModelForUpdate,
  setLearnedAgentModels,
  validateAgentModel,
  validateAgentModelChoice,
} from "../src/shared/agent-models.js";
import { TemplateService } from "../src/templates/service.js";
import type { TemplateRecord } from "../src/templates/store.js";

/** The settings table, as far as getSetting and setSetting use it. */
function settingsPool(
  initial: Record<string, string> = {},
  runnerIds: string[] = []
) {
  const rows = new Map(Object.entries(initial));
  const query = vi.fn(async (sql: string, params: string[] = []) => {
    if (sql.includes("FROM runner_registrations"))
      return { rows: runnerIds.map((id) => ({ id })) };
    if (sql.includes("INSERT INTO settings")) rows.set(params[0]!, params[1]!);
    if (sql.includes("SELECT value FROM settings")) {
      const value = rows.get(params[0]!);
      return { rows: value === undefined ? [] : [{ value }] };
    }
    return { rows: [] };
  });
  return { pool: { query } as never, rows, query };
}

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const turnOff = (pool: never, model: string) =>
  updateModelAvailability(pool, "codex", { model, enabled: false });

beforeEach(() => {
  setLearnedAgentModels(
    "codex",
    ["sol", "astra", "luna"].map((id) => ({ id, label: id }))
  );
});
afterEach(() => forgetLearnedAgentModels());

describe("storing the filter", () => {
  it("has every model on until something is turned off", () => {
    expect(agentModelAvailability().codex).toEqual({
      autoEnable: true,
      disabled: [],
      unseen: [],
    });
    expect(validateAgentModelChoice("codex", "sol")).toBe("sol");
  });

  it("survives a restart", async () => {
    const { pool } = settingsPool();
    await turnOff(pool, "sol");
    await updateModelAvailability(pool, "codex", { autoEnable: false });
    forgetLearnedAgentModels();
    await loadModelAvailability(pool);
    expect(getAgentModelAvailability("codex")).toMatchObject({
      autoEnable: false,
      disabled: ["sol"],
    });
  });

  it("keeps both of two changes made at once", async () => {
    const { pool } = settingsPool();
    await Promise.all([turnOff(pool, "sol"), turnOff(pool, "astra")]);
    expect(getAgentModelAvailability("codex").disabled).toEqual([
      "sol",
      "astra",
    ]);
  });

  it("refuses to turn off the last model, even when raced", async () => {
    const { pool } = settingsPool();
    await turnOff(pool, "sol");
    const results = await Promise.allSettled([
      turnOff(pool, "astra"),
      turnOff(pool, "luna"),
    ]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
    expect(validateAgentModelChoice("codex", "luna")).toBe("luna");
  });

  it("refuses to turn off a model that isn't listed", async () => {
    const { pool } = settingsPool();
    await expect(turnOff(pool, "nope")).rejects.toThrow("not in the codex");
  });

  it("leaves the filter as it was when the write fails, and keeps working", async () => {
    const { pool, query } = settingsPool();
    query.mockRejectedValueOnce(new Error("database down"));
    await expect(turnOff(pool, "sol")).rejects.toThrow("database down");
    expect(getAgentModelAvailability("codex").disabled).toEqual([]);
    await turnOff(pool, "sol");
    expect(getAgentModelAvailability("codex").disabled).toEqual(["sol"]);
  });

  it("reads a corrupt entry as everything on", async () => {
    const { pool } = settingsPool({ "agent_model_availability:codex": "{no" });
    await loadModelAvailability(pool);
    expect(getAgentModelAvailability("codex").disabled).toEqual([]);
  });

  it("preserves main's old duplicate off-list bytes when a repeated list changes nothing", async () => {
    const raw = JSON.stringify({
      autoEnable: false,
      disabled: ["sol", "sol"],
      unseen: [],
      known: ["sol", "astra"],
    });
    const { pool, rows } = settingsPool({
      "agent_model_availability:codex": raw,
    });
    await loadModelAvailability(pool);
    expect(await recordListedModels(pool, "codex", ["sol", "astra"])).toBe(
      false
    );
    expect(rows.get("agent_model_availability:codex")).toBe(raw);
  });

  it("fails boot on a failed read, rather than turning everything on", async () => {
    const { pool, query } = settingsPool();
    query.mockRejectedValueOnce(new Error("database down"));
    await expect(loadModelAvailability(pool)).rejects.toThrow("database down");
  });
});

describe("new models", () => {
  it("takes an existing install's learned list as the baseline", async () => {
    const { pool } = settingsPool();
    await loadModelAvailability(pool);
    await recordListedModels(pool, "codex", ["sol", "astra", "luna", "next"]);
    expect(getAgentModelAvailability("codex").unseen).toEqual(["next"]);
  });

  it("takes the first list as the baseline on a fresh install", async () => {
    forgetLearnedAgentModels();
    const { pool } = settingsPool();
    await loadModelAvailability(pool);
    await updateModelAvailability(pool, "codex", { autoEnable: false });
    await recordListedModels(pool, "codex", ["sol", "astra"]);
    expect(getAgentModelAvailability("codex")).toMatchObject({
      unseen: [],
      disabled: [],
    });
  });

  it.each([
    { autoEnable: true, disabled: [] },
    { autoEnable: false, disabled: ["next"] },
  ])(
    "starts a new model by auto-enable: %j",
    async ({ autoEnable, disabled }) => {
      const { pool } = settingsPool();
      await loadModelAvailability(pool);
      await updateModelAvailability(pool, "codex", { autoEnable });
      await recordListedModels(pool, "codex", ["sol", "next"]);
      expect(getAgentModelAvailability("codex")).toMatchObject({
        disabled,
        unseen: ["next"],
      });
    }
  );

  it("doesn't call a model that went away and came back new", async () => {
    const { pool } = settingsPool();
    await loadModelAvailability(pool);
    await updateModelAvailability(pool, "codex", { autoEnable: false });
    await recordListedModels(pool, "codex", ["sol"]);
    await recordListedModels(pool, "codex", ["sol", "luna"]);
    expect(getAgentModelAvailability("codex")).toMatchObject({
      unseen: [],
      disabled: [],
    });
  });

  it("clears New once seen, without changing whether it is on", async () => {
    const { pool } = settingsPool();
    await loadModelAvailability(pool);
    await updateModelAvailability(pool, "codex", { autoEnable: false });
    await recordListedModels(pool, "codex", ["sol", "next"]);
    await updateModelAvailability(pool, "codex", { seen: ["next"] });
    expect(getAgentModelAvailability("codex")).toMatchObject({
      unseen: [],
      disabled: ["next"],
    });
  });

  it("is off before an engine's new list is published", async () => {
    const { pool, query } = settingsPool();
    await loadModelAvailability(pool);
    await updateModelAvailability(pool, "codex", { autoEnable: false });
    const store = query.getMockImplementation()!;
    query.mockImplementation(async (sql, params) => {
      if (params?.[0] === "agent_model_availability:codex")
        expect(agentModelCatalog().codex?.map((m) => m.id)).not.toContain(
          "next"
        );
      return store(sql, params);
    });
    const result = await recordEngineModels(
      { pool, logger: logger as never },
      { id: "agt_1", type: "codex", model: "sol" },
      [
        {
          id: "model",
          name: "Model",
          type: "select",
          currentValue: "sol",
          options: [
            { value: "sol", name: "sol" },
            { value: "next", name: "next" },
          ],
        },
      ]
    );
    expect(result.modelsChanged).toBe(true);
    expect(() => validateAgentModelChoice("codex", "next")).toThrow(
      "turned off"
    );
  });
});

describe("choosing a model", () => {
  beforeEach(() => turnOff(settingsPool().pool, "sol"));

  it("rejects a new choice and names what is on", () => {
    expect(() => validateAgentModelChoice("codex", "sol")).toThrow(
      'Model "sol" is turned off for codex in Settings → Agents. Choose one of astra, luna'
    );
    expect(() =>
      applyAgentConfigDefaults({ agentType: "codex", model: "sol" })
    ).toThrow("turned off");
  });

  it("only filters: the catalog, launches and Default don't change", () => {
    expect(agentModelCatalog().codex?.map((m) => m.id)).toEqual([
      "sol",
      "astra",
      "luna",
    ]);
    expect(validateAgentModel("codex", "sol")).toBe("sol");
    expect(validateAgentModelChoice("codex", undefined)).toBeUndefined();
  });

  it("only offers agents what is on", () => {
    expect(describeAgentModelCatalog(["codex"])).toBe(
      "Supported ids by agent type — codex: astra, luna."
    );
  });

  const update = (
    existingModel: string | null,
    inputModel?: string,
    existingAgentType: "codex" | "claude" = "codex"
  ) =>
    resolveAgentModelForUpdate({
      inputAgentType: "codex",
      inputModel,
      existingAgentType,
      existingModel,
    });

  it("keeps a saved choice that is sent back, or left out", () => {
    expect(update("sol", "sol")).toBe("sol");
    expect(update("sol")).toBe("sol");
  });

  it("won't let it be newly saved", () => {
    expect(() => update("astra", "sol")).toThrow("turned off");
    expect(() => update("sol", "sol", "claude")).toThrow("turned off");
    expect(update("sol", undefined, "claude")).toBeNull();
  });
});

describe("templates", () => {
  const stored = {
    id: "tmpl_1",
    name: "Saved",
    directory: "/tmp/repo",
    prompt: "Go",
    agentType: "codex",
    model: "sol",
    effort: null,
    allowFiles: true,
  } as TemplateRecord;

  const service = () => {
    const createAgent = vi.fn(async () => ({ id: "agt_1" }));
    const service = new TemplateService(
      {} as never,
      { createAgent } as never,
      logger as never
    );
    vi.spyOn(service.store, "getTemplate").mockResolvedValue(stored);
    return { service, createAgent };
  };

  beforeEach(() => turnOff(settingsPool().pool, "sol"));

  it.each([{}, { model: "sol" }])(
    "keeps launching a saved model that is off: %j",
    async (input) => {
      const { service: templates, createAgent } = service();
      await templates.launchTemplate({ templateId: "tmpl_1", ...input });
      expect(createAgent).toHaveBeenCalledWith(
        expect.objectContaining({ model: "sol" })
      );
    }
  );

  it("rejects an override to a model that is off", async () => {
    await turnOff(settingsPool().pool, "astra");
    const { service: templates, createAgent } = service();
    await expect(
      templates.launchTemplate({ templateId: "tmpl_1", model: "astra" })
    ).rejects.toThrow("turned off");
    expect(createAgent).not.toHaveBeenCalled();
  });

  it("keeps it on a copy, but not on a new template", async () => {
    const { service: templates } = service();
    const create = vi
      .spyOn(templates.store, "createTemplate")
      .mockImplementation(async (input) => ({ ...stored, ...input }) as never);
    expect(await templates.duplicateTemplate("tmpl_1", "Copy")).toMatchObject({
      name: "Copy",
      model: "sol",
    });
    await expect(templates.addTemplate(stored)).rejects.toThrow("turned off");
    expect(create).toHaveBeenCalledOnce();
  });
});

describe("a running agent's model switcher", () => {
  const option = (currentValue: string) => [
    {
      id: "model",
      name: "Model",
      type: "select" as const,
      currentValue,
      options: ["default", "sol", "astra", "luna"].map((value) => ({
        value,
        name: value,
      })),
    },
  ];

  it("offers what is on, plus the one in use", () => {
    const offered = (current: string) =>
      toAgentConfigOptions(option(current), ["sol"])[0]?.choices.map(
        (choice) => choice.value
      );
    expect(offered("astra")).toEqual(["default", "astra", "luna"]);
    expect(offered("sol")).toEqual(["default", "sol", "astra", "luna"]);
  });

  it.each([
    { current: "astra", value: "sol", status: 400 },
    { current: "sol", value: "sol", status: 200 },
    { current: "sol", value: "default", status: 200 },
  ])("switching %j", async ({ current, value, status }) => {
    await turnOff(settingsPool().pool, "sol");
    const setConfigOption = vi.fn(async () => option(value));
    const app = Fastify();
    await registerAgentUsageRoutes(app, {
      pool: {},
      appLog: logger,
      agentManager: {
        getAgent: async () => ({ id: "agt_1", type: "codex" }),
        getConfigOptions: () => option(current),
        setConfigOption,
      },
    } as never);
    const response = await app.inject({
      method: "PUT",
      url: "/api/v1/agents/agt_1/config",
      payload: { configId: "model", value },
    });
    expect(response.statusCode).toBe(status);
    expect(setConfigOption).toHaveBeenCalledTimes(status === 200 ? 1 : 0);
    await app.close();
  });
});

describe("settings route", () => {
  const server = async () => {
    const { pool } = settingsPool();
    const publishModelsChanged = vi.fn();
    const app = Fastify();
    await registerSystemRoutes(app, {
      pool,
      publishModelsChanged,
      appLog: logger,
      slackNotifier: {},
      engineBins: { claude: "claude", codex: "codex" },
    } as never);
    const patch = (payload: object) =>
      app.inject({
        method: "PATCH",
        url: "/api/v1/app/settings/agent-models",
        payload,
      });
    return { app, patch, publishModelsChanged };
  };

  it("pins main's exact no-runner catalog and PATCH response bytes", async () => {
    const { pool } = settingsPool();
    const codex = ["sol", "astra", "luna", "next"].map((id) => ({
      id,
      label: id,
    }));
    setLearnedAgentModels("codex", codex, "astra");
    setLearnedAgentModels("claude", [{ id: "c", label: "C" }], "c");
    setLearnedAgentModels("opencode", [{ id: "o", label: "O" }], "o");
    await recordListedModels(pool, "codex", ["sol", "astra", "luna"]);
    await updateModelAvailability(pool, "codex", {
      model: "sol",
      enabled: false,
    });
    await updateModelAvailability(pool, "codex", { autoEnable: false });
    await recordListedModels(pool, "codex", ["sol", "astra", "luna", "next"]);
    const app = Fastify();
    await registerSystemRoutes(app, {
      pool,
      appLog: logger,
      slackNotifier: {},
      engineBins: { claude: "claude", codex: "codex" },
    } as never);
    try {
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/api/v1/app/settings/agent-models",
          })
        ).body
      ).toBe(
        (await app.inject({ method: "GET", url: "/api/v1/agent-models" })).body
      );
      const availability = {
        claude: { autoEnable: true, disabled: [], unseen: [] },
        codex: {
          autoEnable: false,
          disabled: ["sol", "next"],
          unseen: ["next"],
        },
        opencode: { autoEnable: true, disabled: [], unseen: [] },
      };
      expect(
        (await app.inject({ method: "GET", url: "/api/v1/agent-models" })).body
      ).toBe(
        JSON.stringify({
          models: {
            codex,
            claude: [{ id: "c", label: "C" }],
            opencode: [{ id: "o", label: "O" }],
          },
          defaults: { codex: "astra", claude: "c", opencode: "o" },
          availability,
        })
      );
      expect(
        (
          await app.inject({
            method: "PATCH",
            url: "/api/v1/app/settings/agent-models",
            payload: { agentType: "codex", autoEnable: false },
          })
        ).body
      ).toBe(JSON.stringify({ availability }));
      expect(
        (
          await app.inject({
            method: "PATCH",
            url: "/api/v1/app/settings/agent-models",
            payload: { agentType: "codex", seen: ["next"] },
          })
        ).body
      ).toBe(
        JSON.stringify({
          availability: {
            ...availability,
            codex: { ...availability.codex, unseen: [] },
          },
        })
      );
    } finally {
      await app.close();
    }
  });

  it("saves a change, tells open clients and serves it with the catalog", async () => {
    const { app, patch, publishModelsChanged } = await server();
    const body = { agentType: "codex", model: "sol", enabled: false };
    expect((await patch(body)).statusCode).toBe(200);
    expect(publishModelsChanged).toHaveBeenCalledExactlyOnceWith("codex");
    const catalog = (
      await app.inject({ method: "GET", url: "/api/v1/agent-models" })
    ).json();
    expect(catalog.models.codex).toHaveLength(3);
    expect(catalog.availability.codex.disabled).toEqual(["sol"]);
    expect(catalog.availability.codex).not.toHaveProperty("known");
    await patch(body);
    expect(publishModelsChanged).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it.each([
    {},
    { agentType: "codex" },
    { agentType: "gemini", autoEnable: false },
    { agentType: "codex", model: "sol" },
    { agentType: "codex", autoEnable: false, seen: ["sol"] },
    { agentType: "codex", model: "unlisted", enabled: false },
  ])("rejects %j", async (body) => {
    const { app, patch } = await server();
    expect((await patch(body)).statusCode).toBe(400);
    await app.close();
  });
});

describe("shared choices and scoped reports", () => {
  const context = (runnerId: string) => ({
    runnerId,
    settings: enrolledRunnerSettings(runnerId),
  });
  it.each(
    [true, false].flatMap((autoEnable) =>
      ["local", "alpha", "beta"].map((origin) => ({ autoEnable, origin }))
    )
  )("applies the union truth table: %j", async ({ autoEnable, origin }) => {
    const { pool, rows } = settingsPool({}, ["alpha", "beta"]);
    await loadModelAvailability(pool, context("alpha"));
    await loadModelAvailability(pool, context("beta"));
    await recordListedModels(pool, "codex", ["base"]);
    await recordListedModels(pool, "codex", ["base"], context("alpha"));
    await updateModelAvailability(pool, "codex", { autoEnable });
    const report = (id: string, models: string[]) =>
      id === "local"
        ? recordListedModels(pool, "codex", models)
        : recordListedModels(pool, "codex", models, context(id));
    const models = ["base", "new"];
    for (const id of ["local", "alpha", "beta"])
      setLearnedAgentModels(
        "codex",
        models.map((id) => ({ id, label: id })),
        undefined,
        id
      );
    await report(origin, models);
    expect(selectableAgentModels("codex", origin).map((m) => m.id)).toEqual(
      autoEnable ? models : ["base"]
    );
    expect(getAgentModelAvailability("codex").disabled).toEqual(
      autoEnable ? [] : ["new"]
    );
    await updateModelAvailability(pool, "codex", {
      model: "new",
      enabled: true,
    });
    for (const id of ["local", "alpha", "beta"]) await report(id, models);
    for (const id of ["local", "alpha", "beta"])
      expect(selectableAgentModels("codex", id).map((m) => m.id)).toEqual(
        models
      );
    await updateModelAvailability(pool, "codex", {
      model: "new",
      enabled: false,
    });
    for (const id of ["local", "alpha", "beta"]) await report(id, models);
    for (const id of ["local", "alpha", "beta"])
      expect(selectableAgentModels("codex", id).map((m) => m.id)).toEqual([
        "base",
      ]);
    for (const key of [
      "runner:alpha:agent_model_availability:codex",
      "runner:beta:agent_model_availability:codex",
    ])
      expect(Object.keys(JSON.parse(rows.get(key)!)).sort()).toEqual([
        "known",
        "unseen",
      ]);
  });

  it("applies shared auto-enable to a registered runner's first globally unknown model", async () => {
    const { pool } = settingsPool({}, ["alpha"]);
    await loadModelAvailability(pool, context("alpha"));
    await updateModelAvailability(pool, "codex", { autoEnable: false });
    await recordListedModels(pool, "codex", ["first-remote"], context("alpha"));
    expect(getAgentModelAvailability("codex").disabled).toEqual([
      "first-remote",
    ]);
    expect(getReportedModelHistory("alpha", "codex").unseen).toEqual([
      "first-remote",
    ]);
  });

  it("settings unions current catalogs and new markers, while local pickers keep their catalog", async () => {
    const { pool } = settingsPool({}, ["alpha", "beta"]);
    await loadModelAvailability(pool, context("alpha"));
    await loadModelAvailability(pool, context("beta"));
    await recordListedModels(pool, "codex", ["sol", "astra", "luna"]);
    const effort = [
      {
        value: "high",
        name: "High",
        description: "Complete engine description",
      },
    ];
    setLearnedAgentModels(
      "codex",
      [{ id: "only-alpha", label: "Only Alpha", effort }],
      undefined,
      "alpha"
    );
    setLearnedAgentModels(
      "codex",
      [
        { id: "only-beta", label: "Only Beta" },
        { id: "only-alpha", label: "Other label" },
      ],
      undefined,
      "beta"
    );
    await recordListedModels(pool, "codex", ["only-alpha"], context("alpha"));
    await recordListedModels(
      pool,
      "codex",
      ["only-beta", "only-alpha"],
      context("beta")
    );
    const app = Fastify();
    await registerSystemRoutes(app, {
      pool,
      appLog: logger,
      slackNotifier: {},
      engineBins: { claude: "claude", codex: "codex" },
    } as never);
    try {
      const get = async (url: string) =>
        (await app.inject({ method: "GET", url })).json();
      const union = await get("/api/v1/app/settings/agent-models");
      expect(union.models.codex).toEqual([
        ...agentModelCatalog().codex!,
        { id: "only-alpha", label: "Only Alpha", effort },
        { id: "only-beta", label: "Only Beta" },
      ]);
      expect(union.availability.codex.unseen).toEqual([
        "sol",
        "astra",
        "luna",
        "only-alpha",
        "only-beta",
      ]);
      expect((await get("/api/v1/agent-models")).models.codex).toEqual(
        agentModelCatalog().codex
      );
      const patch = (change: object) =>
        app.inject({
          method: "PATCH",
          url: "/api/v1/app/settings/agent-models",
          payload: { agentType: "codex", ...change },
        });
      expect(
        (await patch({ model: "only-alpha", enabled: false })).statusCode
      ).toBe(200);
      expect(selectableAgentModels("codex", "alpha")).toEqual([]);
      expect(selectableAgentModels("codex", "beta").map((m) => m.id)).toEqual([
        "only-beta",
      ]);
      await patch({ model: "only-alpha", enabled: true });
      expect(selectableAgentModels("codex", "alpha")).toHaveLength(1);
      const seen = await patch({
        seen: ["sol", "astra", "luna", "only-alpha", "only-beta"],
      });
      expect(seen.json().availability.codex.unseen).toEqual([]);
      expect(getReportedModelHistory("alpha", "codex").unseen).toEqual([]);
      expect(getReportedModelHistory("beta", "codex").unseen).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
