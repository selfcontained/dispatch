import {
  loadModelAvailability,
  updateModelAvailability,
} from "../src/agents/model-availability.js";
import {
  getAgentModelAvailability,
  getReportedModelHistory,
  modelChoicesForRunner,
} from "../src/shared/agent-models.js";
import { enrolledRunnerSettings } from "../src/runners/settings-namespace.js";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  loadLearnedAgentModels,
  modelOptionOf,
  recordEngineModels,
} from "../src/agents/engine-models.js";
import {
  agentModelDefaults,
  forgetLearnedAgentModels,
  getAgentModelOptions,
} from "../src/shared/agent-models.js";

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as import("fastify").FastifyBaseLogger;

const modelOption = (
  currentValue: string,
  options: SessionConfigOption extends infer T
    ? T extends { type: "select" }
      ? T["options"]
      : never
    : never
): SessionConfigOption => ({
  id: "model",
  name: "Model",
  category: "model",
  type: "select",
  currentValue,
  options,
});

describe("modelOptionOf", () => {
  it("reads a flat model option", () => {
    expect(
      modelOptionOf([
        {
          id: "mode",
          name: "Mode",
          category: "mode",
          type: "select",
          currentValue: "code",
          options: [{ value: "code", name: "Code" }],
        },
        modelOption("gpt-5.5", [
          { value: "gpt-5.5", name: "GPT-5.5" },
          { value: "gpt-6-astra", name: "GPT-6 Astra" },
        ]),
      ])
    ).toEqual({
      current: "gpt-5.5",
      choices: [
        { id: "gpt-5.5", label: "GPT-5.5" },
        { id: "gpt-6-astra", label: "GPT-6 Astra" },
      ],
    });
  });

  it("leaves the engine's own default entry out; the picker has one", () => {
    expect(
      modelOptionOf([
        modelOption("claude-fable-5-1[1m]", [
          { value: "default", name: "Default (recommended)" },
          { value: "claude-fable-5-1[1m]", name: "Fable 5.1" },
        ]),
      ])
    ).toEqual({
      current: "claude-fable-5-1[1m]",
      choices: [{ id: "claude-fable-5-1[1m]", label: "Fable 5.1" }],
    });
  });

  it("flattens grouped choices in the engine's order, naming each within its group", () => {
    expect(
      modelOptionOf([
        modelOption("gpt-6-astra", [
          {
            group: "gpt",
            name: "GPT",
            options: [
              { value: "gpt-6-astra", name: "6 Astra" },
              { value: "gpt-5.5", name: "GPT 5.5" },
            ],
          },
          {
            group: "older",
            name: "Older",
            options: [{ value: "gpt-4.1", name: "Older 4.1" }],
          },
        ]),
      ])?.choices
    ).toEqual([
      { id: "gpt-6-astra", label: "GPT-6 Astra" },
      { id: "gpt-5.5", label: "GPT 5.5" },
      { id: "gpt-4.1", label: "Older 4.1" },
    ]);
  });

  it("puts back the GPT family codex-acp strips from its model names", () => {
    // codex-acp 1.12's createModelConfigOption, verbatim in shape: a flat
    // list whose names come from formatModelDisplayName, which drops the
    // leading "gpt-" ("gpt-5.6-sol" -> "5.6 Sol").
    const published: SessionConfigOption = {
      id: "model",
      name: "Model",
      description: "Model Codex uses for the session",
      category: "model",
      type: "select",
      currentValue: "gpt-6-astra",
      options: [
        { value: "gpt-6-astra", name: "6 Astra", description: "Flagship" },
        { value: "gpt-5.6-sol", name: "5.6 Sol", description: null },
        {
          value: "gpt-5.3-codex-spark",
          name: "5.3 Codex Spark",
          description: null,
        },
      ],
    };
    expect(modelOptionOf([published])?.choices).toEqual([
      { id: "gpt-6-astra", label: "GPT-6 Astra" },
      { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
      { id: "gpt-5.3-codex-spark", label: "GPT-5.3 Codex Spark" },
    ]);
  });

  it("is null when the engine publishes no model option", () => {
    expect(modelOptionOf([])).toBeNull();
    expect(
      modelOptionOf([
        { id: "model", name: "Model", type: "boolean", currentValue: true },
      ])
    ).toBeNull();
  });
});

describe("recordEngineModels", () => {
  afterEach(() => forgetLearnedAgentModels());

  const pool = () => ({ query: vi.fn().mockResolvedValue({ rows: [] }) });

  it("round-trips main's local key, exact labels, default and effort descriptions", async () => {
    const values = new Map<string, string>();
    const p = {
      query: vi.fn(async (sql: string, args: string[]) => {
        if (sql.includes("INSERT INTO settings"))
          values.set(args[0]!, args[1]!);
        return {
          rows: values.has(args[0]!) ? [{ value: values.get(args[0]!) }] : [],
        };
      }),
    };
    const effort: SessionConfigOption = {
      id: "effort",
      name: "Effort",
      type: "select",
      currentValue: "high",
      options: [
        {
          value: "high",
          name: "High",
          description: "Engine's full description",
        },
      ],
    };
    await recordEngineModels(
      { pool: p as never, logger },
      { id: "a", type: "codex", model: null },
      [
        modelOption("gpt-a", [
          { value: "gpt-a", name: "1 A" },
          { value: "gpt-b", name: "B" },
        ]),
        effort,
      ]
    );
    await recordEngineModels(
      { pool: p as never, logger },
      { id: "b", type: "codex", model: "gpt-b" },
      [
        modelOption("gpt-b", [
          { value: "gpt-a", name: "1 A" },
          { value: "gpt-b", name: "B" },
        ]),
        effort,
      ]
    );
    const expected = getAgentModelOptions("codex");
    expect(expected[0]).toEqual({
      id: "gpt-a",
      label: "GPT-1 A",
      effort: [
        {
          value: "high",
          name: "High",
          description: "Engine's full description",
        },
      ],
    });
    expect([...values.keys()]).toEqual([
      "agent_model_availability:codex",
      "agent_models:codex",
    ]);
    expect(agentModelDefaults().codex).toBe("gpt-a");
    forgetLearnedAgentModels();
    await loadLearnedAgentModels(p as never);
    expect(getAgentModelOptions("codex")).toEqual(expected);
    expect(agentModelDefaults().codex).toBe("gpt-a");
  });

  it.each([
    "{broken",
    "null",
    '{"models":null}',
    '{"models":[{"id":"default-model"},{"id":"other-model"}]}',
  ])("ignores corrupt or old main storage: %s", async (raw) => {
    const before = getAgentModelOptions("codex");
    const p = { query: vi.fn(async () => ({ rows: [{ value: raw }] })) };
    await loadLearnedAgentModels(p as never);
    expect(getAgentModelOptions("codex")).toEqual(before);
    expect(agentModelDefaults().codex).toBeUndefined();
  });

  it("loads a runner's own key without changing the local catalog", async () => {
    const before = getAgentModelOptions("codex");
    const p = {
      query: vi.fn(async (_sql: string, args: string[]) => ({
        rows:
          args[0] === "runner:runner-a:agent_models:codex"
            ? [
                {
                  value: JSON.stringify({
                    models: [{ id: "runner-model", label: "Runner" }],
                    defaultModel: "runner-model",
                  }),
                },
              ]
            : [],
      })),
    };
    await loadLearnedAgentModels(
      p as never,
      "runner-a",
      enrolledRunnerSettings("runner-a")
    );
    expect(getAgentModelOptions("codex")).toEqual(before);
    expect(getAgentModelOptions("codex", "runner-a")).toEqual([
      { id: "runner-model", label: "Runner" },
    ]);
    expect(agentModelDefaults("runner-a").codex).toBe("runner-model");
    expect(
      p.query.mock.calls.every(([, args]) =>
        args[0]?.startsWith("runner:runner-a:agent_models:")
      )
    ).toBe(true);
  });

  it("isolates report history and catalogs while applying the shared off-list across restart", async () => {
    const rows = new Map<string, string>();
    const p = {
      query: vi.fn(async (sql: string, args: string[]) => {
        if (sql.includes("INSERT INTO settings")) rows.set(args[0]!, args[1]!);
        return {
          rows: rows.has(args[0]!) ? [{ value: rows.get(args[0]!) }] : [],
        };
      }),
    };
    const deps = { pool: p as never, logger };
    const report = (id: string) => [modelOption(id, [{ value: id, name: id }])];
    await recordEngineModels(deps, { id: "l", type: "codex", model: null }, [
      modelOption("local-a", [
        { value: "local-a", name: "Local" },
        { value: "local-off", name: "Off" },
      ]),
    ]);
    await updateModelAvailability(p as never, "codex", { autoEnable: false });
    await updateModelAvailability(p as never, "codex", {
      model: "local-off",
      enabled: false,
    });
    const localHistory = JSON.stringify(getAgentModelAvailability("codex"));
    const localStored = rows.get("agent_model_availability:codex");
    const localCatalog = rows.get("agent_models:codex");
    const context = {
      runnerId: "runner-a",
      settings: enrolledRunnerSettings("runner-a"),
    };
    await recordEngineModels(
      deps,
      { id: "r", type: "codex", model: null },
      report("runner-a"),
      true,
      context
    );
    await recordEngineModels(
      deps,
      { id: "r", type: "codex", model: "runner-a" },
      report("runner-b"),
      true,
      context
    );
    const sharedAfter = {
      ...JSON.parse(localHistory),
      disabled: ["local-off", "runner-a", "runner-b"],
    };
    expect(getAgentModelAvailability("codex")).toEqual(sharedAfter);
    expect(JSON.parse(rows.get("agent_model_availability:codex")!)).toEqual({
      ...JSON.parse(localStored!),
      disabled: sharedAfter.disabled,
    });
    expect(rows.get("agent_models:codex")).toBe(localCatalog);
    expect(getAgentModelOptions("codex").map((m) => m.id)).toEqual([
      "local-a",
      "local-off",
    ]);
    expect(getAgentModelOptions("codex", "runner-a").map((m) => m.id)).toEqual([
      "runner-b",
    ]);
    expect(modelChoicesForRunner("runner-a", "codex")).toEqual({
      autoEnable: false,
      disabled: ["local-off", "runner-a", "runner-b"],
    });
    const historyKey = "runner:runner-a:agent_model_availability:codex";
    expect(JSON.parse(rows.get(historyKey)!)).toEqual({
      known: ["runner-a", "runner-b"],
      unseen: ["runner-a", "runner-b"],
    });
    const runnerStored = rows.get("runner:runner-a:agent_models:codex");
    const runnerHistory = rows.get(historyKey);
    await recordEngineModels(
      deps,
      { id: "l", type: "codex", model: null },
      report("local-b")
    );
    expect(rows.get(historyKey)).toBe(runnerHistory);
    expect(rows.get("runner:runner-a:agent_models:codex")).toBe(runnerStored);
    expect(getAgentModelOptions("codex", "runner-a").map((m) => m.id)).toEqual([
      "runner-b",
    ]);
    forgetLearnedAgentModels();
    await loadLearnedAgentModels(p as never);
    await loadModelAvailability(p as never);
    await loadLearnedAgentModels(
      p as never,
      context.runnerId,
      context.settings
    );
    await loadModelAvailability(p as never, context);
    expect(getAgentModelOptions("codex").map((m) => m.id)).toEqual(["local-b"]);
    expect(getAgentModelOptions("codex", "runner-a").map((m) => m.id)).toEqual([
      "runner-b",
    ]);
    expect(getReportedModelHistory("runner-a", "codex")).toEqual(
      JSON.parse(runnerHistory!)
    );
    expect(agentModelDefaults("runner-a").codex).toBe("runner-a");
  });

  it("manager learns a runner report through the same catalog path", async () => {
    const { AgentManager } = await import("../src/agents/manager.js");
    const { placementForRunner } = await import("../src/runners/placement.js");
    const p = pool();
    const before = getAgentModelOptions("codex");
    const agent = {
      id: "runner-agent",
      type: "codex",
      model: "runner-model",
      effort: null,
      cwd: "runner://runner-a/workspace",
      placement: placementForRunner("runner-a"),
    };
    const manager = {
      pool: p,
      logger,
      getAgent: async () => agent,
      checkoutReadRunners: () => ({}),
      modelsLearnedListeners: [],
    };
    const apply = (
      AgentManager.prototype as unknown as {
        applyEngineConfig(
          this: unknown,
          id: string,
          options: SessionConfigOption[],
          learn: boolean
        ): Promise<void>;
      }
    ).applyEngineConfig;
    await apply.call(
      manager,
      agent.id,
      [
        modelOption("runner-model", [
          { value: "runner-model", name: "Runner" },
        ]),
      ],
      true
    );
    expect(getAgentModelOptions("codex")).toEqual(before);
    expect(getAgentModelOptions("codex", "runner-a").map((m) => m.id)).toEqual([
      "runner-model",
    ]);
    expect(p.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO settings"),
      ["runner:runner-a:agent_models:codex", expect.any(String)]
    );
  });

  it("stores the running model on the agent and the list for its type", async () => {
    const p = pool();
    const result = await recordEngineModels(
      { pool: p as never, logger },
      { id: "agt_1", type: "claude", model: null },
      [
        modelOption("claude-opus-5", [
          { value: "claude-opus-5", name: "Opus 5" },
          { value: "claude-sonnet-5", name: "Sonnet 5" },
        ]),
      ]
    );
    expect(result).toEqual({ modelChanged: true, modelsChanged: true });
    expect(getAgentModelOptions("claude").map((o) => o.id)).toEqual([
      "claude-opus-5",
      "claude-sonnet-5",
    ]);
    const sql = p.query.mock.calls.map((c) => String(c[0]));
    expect(sql.some((q) => q.includes("INSERT INTO settings"))).toBe(true);
    const update = p.query.mock.calls.find((c) =>
      String(c[0]).includes("UPDATE agents SET model")
    );
    expect(update?.[1]).toEqual(["agt_1", "claude-opus-5"]);
    const stored = p.query.mock.calls.find(
      (c) =>
        String(c[0]).includes("INSERT INTO settings") &&
        (c[1] as string[])[0] === "agent_models:claude"
    )?.[1] as [string, string];
    expect(JSON.parse(stored[1]).models).toHaveLength(2);
  });

  it("records a workload session model without learning it as a native option", async () => {
    const p = pool();
    const before = getAgentModelOptions("claude");
    const result = await recordEngineModels(
      { pool: p as never, logger },
      { id: "agt_remote", type: "claude", model: null },
      [
        modelOption("runner/model", [
          { value: "runner/model", name: "Runner model" },
        ]),
      ],
      false
    );
    expect(result).toEqual({ modelChanged: true, modelsChanged: false });
    expect(getAgentModelOptions("claude")).toEqual(before);
    expect(p.query).toHaveBeenCalledTimes(1);
    expect(p.query).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE agents"),
      ["agt_remote", "runner/model"]
    );
  });

  it("records an override's session model without learning its catalog", async () => {
    const p = pool();
    const catalog = getAgentModelOptions("codex");
    const result = await recordEngineModels(
      { pool: p as never, logger },
      { id: "agt_1", type: "codex", model: null },
      [
        modelOption("default-model", [
          { value: "default-model", name: "Fake" },
        ]),
      ],
      false
    );
    expect(result).toEqual({ modelChanged: true, modelsChanged: false });
    expect(p.query).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("UPDATE agents SET model"),
      ["agt_1", "default-model"]
    );
    expect(getAgentModelOptions("codex")).toEqual(catalog);
    expect(agentModelDefaults().codex).toBeUndefined();
  });

  it("ignores the old fake catalog at boot and replaces it on a real report", async () => {
    const p = pool();
    const catalog = getAgentModelOptions("codex");
    const stored = {
      defaultModel: "default-model",
      models: [{ id: "default-model" }, { id: "other-model" }],
    };
    p.query.mockImplementation((_sql, args) =>
      Promise.resolve({
        rows:
          args[0] === "agent_models:codex"
            ? [{ value: JSON.stringify(stored) }]
            : [],
      })
    );
    await loadLearnedAgentModels(p as never);
    expect(getAgentModelOptions("codex")).toEqual(catalog);
    expect(agentModelDefaults().codex).toBeUndefined();

    await recordEngineModels(
      { pool: p as never, logger },
      { id: "agt_real", type: "codex", model: null },
      [
        modelOption("gpt-6.1-sol", [
          { value: "gpt-6.1-sol", name: "GPT-6.1 Sol" },
        ]),
      ]
    );
    expect(getAgentModelOptions("codex").map(({ id }) => id)).toEqual([
      "gpt-6.1-sol",
    ]);
    expect(p.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO settings"),
      [
        "agent_models:codex",
        expect.stringContaining('"defaultModel":"gpt-6.1-sol"'),
      ]
    );
  });

  it("leaves the agent alone when the engine runs what it already says", async () => {
    const p = pool();
    const result = await recordEngineModels(
      { pool: p as never, logger },
      { id: "agt_1", type: "codex", model: "gpt-5.5" },
      [modelOption("gpt-5.5", [{ value: "gpt-5.5", name: "GPT-5.5" }])]
    );
    // One model is not the seed's six, so the catalog did change.
    expect(result).toEqual({ modelChanged: false, modelsChanged: true });
    expect(
      p.query.mock.calls.some((c) => String(c[0]).includes("UPDATE agents"))
    ).toBe(false);
  });

  it("does nothing for an engine with no model option", async () => {
    const p = pool();
    const result = await recordEngineModels(
      { pool: p as never, logger },
      { id: "agt_1", type: "claude", model: null },
      []
    );
    expect(result).toEqual({ modelChanged: false, modelsChanged: false });
    expect(p.query).not.toHaveBeenCalled();
  });

  it("reports the list changed only when it differs from the catalog in force", async () => {
    const report = [
      modelOption("gpt-5.5", [
        { value: "gpt-5.5", name: "5.5" },
        { value: "gpt-6-astra", name: "6 Astra" },
      ]),
    ];
    const agent = { id: "agt_1", type: "codex" as const, model: "gpt-5.5" };
    const first = await recordEngineModels(
      { pool: pool() as never, logger },
      agent,
      report
    );
    const again = await recordEngineModels(
      { pool: pool() as never, logger },
      agent,
      report
    );
    expect(first.modelsChanged).toBe(true);
    expect(again.modelsChanged).toBe(false);
  });
  it("learns exact per-model effort choices, persists them, and refreshes changed capabilities", async () => {
    const p = pool();
    const deps = { pool: p as never, logger };
    const models = [
      { value: "a", name: "A" },
      { value: "b", name: "B" },
    ];
    const effort = (values: string[]): SessionConfigOption => ({
      id: "reasoning",
      category: "thought_level",
      type: "select",
      name: "Effort",
      currentValue: values[0]!,
      options: values.map((value) => ({ value, name: `Engine ${value}` })),
    });
    await recordEngineModels(
      deps,
      { id: "agt_1", type: "codex", model: null },
      [modelOption("a", models), effort(["default", "future"])]
    );
    expect(agentModelDefaults().codex).toBe("a");
    expect(getAgentModelOptions("codex")).toEqual([
      {
        id: "a",
        label: "A",
        effort: [{ value: "future", name: "Engine future" }],
      },
      { id: "b", label: "B" },
    ]);
    await recordEngineModels(deps, { id: "agt_1", type: "codex", model: "b" }, [
      modelOption("b", models),
      effort(["ultra"]),
    ]);
    expect(getAgentModelOptions("codex")[0]?.effort?.[0]?.value).toBe("future");
    expect(getAgentModelOptions("codex")[1]?.effort?.[0]?.value).toBe("ultra");
    const updated = await recordEngineModels(
      deps,
      { id: "agt_1", type: "codex", model: "b" },
      [modelOption("b", models), effort(["ultra", "new"])]
    );
    expect(updated.modelsChanged).toBe(true);
    const writes = p.query.mock.calls.filter((call) =>
      String(call[0]).includes("INSERT INTO settings")
    );
    const stored = (writes.at(-1)?.[1] as string[])[1]!;
    forgetLearnedAgentModels();
    const reload = {
      query: vi.fn().mockImplementation((_sql, args) =>
        Promise.resolve({
          rows: args[0] === "agent_models:codex" ? [{ value: stored }] : [],
        })
      ),
    };
    await loadLearnedAgentModels(reload as never);
    expect(agentModelDefaults().codex).toBe("a");
    expect(
      getAgentModelOptions("codex")[1]?.effort?.map((choice) => choice.value)
    ).toEqual(["ultra", "new"]);
  });
});

it("persists changed live effort and clears it when the model stops offering effort", async () => {
  const { recordEngineEffort } = await import("../src/agents/engine-models.js");
  const pool = { query: vi.fn().mockResolvedValue({ rows: [] }) };
  await recordEngineEffort(pool as never, { id: "a", effort: "high" }, [
    {
      id: "effort",
      name: "Effort",
      type: "select",
      currentValue: "low",
      options: [{ value: "low", name: "Low" }],
    },
  ]);
  expect(pool.query).toHaveBeenLastCalledWith(
    expect.stringContaining("SET effort"),
    ["a", "low"]
  );
  await recordEngineEffort(pool as never, { id: "a", effort: "low" }, []);
  expect(pool.query).toHaveBeenLastCalledWith(
    expect.stringContaining("SET effort"),
    ["a", null]
  );
});
