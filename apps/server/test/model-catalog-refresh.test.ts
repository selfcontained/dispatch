import { validateAgentEffort } from "../src/shared/agent-effort.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { EngineCalls } from "../src/runners/local.js";
import {
  ModelCatalogRefresh,
  MODEL_REFRESH_AGE_MS,
  MODEL_REFRESH_BACKOFF_MS,
} from "../src/agents/model-catalog-refresh.js";
import { observeModelUpdates } from "../src/agents/engine-updates.js";
import {
  enrolledRunnerSettings,
  localRunnerSettings,
  namespaced,
} from "../src/runners/settings-namespace.js";
import {
  forgetLearnedAgentModels,
  getAgentModelOptions,
  readStoredModelCatalog,
  onStoredModelCatalogRead,
  onModelCatalogValidation,
  modelScopeFor,
  validateAgentModel,
  getLearnedAgentModels,
  setLearnedAgentModels,
} from "../src/shared/agent-models.js";
import { RunnerCallError } from "@dispatch/runner-protocol/contract";
import {
  recordEngineModels,
  readModelObservation,
} from "../src/agents/engine-models.js";
import type { AgentType } from "../src/shared/agent-types.js";
import type { Res } from "@dispatch/runner-protocol/contract";

const refreshers: ModelCatalogRefresh[] = [];
let stop: (() => void) | undefined;
let stopValidation: (() => void) | undefined;
afterEach(() => {
  stop?.();
  stopValidation?.();
  for (const service of refreshers.splice(0)) service.close();
  forgetLearnedAgentModels();
  vi.useRealTimers();
});
function fixture() {
  let now = Date.UTC(2026, 0, 1);
  const rows = new Map<string, string>();
  const pool = {
    query: vi.fn(async (sql: string, args: string[]) => {
      if (sql.includes("INSERT INTO settings")) rows.set(args[0]!, args[1]!);
      return {
        rows: rows.has(args[0]!) ? [{ value: rows.get(args[0]!) }] : [],
      };
    }),
  } as unknown as Pool;
  const listing = vi.fn(async (_input?: { model?: string }) => ({
    defaultModel: "new",
    models: [
      {
        id: "new",
        label: "New",
        effort: [
          { value: "high", name: "High", description: "Full description" },
        ],
      },
    ],
  }));
  const inventory = vi.fn(async () => ({
    entries: [
      { id: "codex", installed: true, signedIn: true, actions: ["login"] },
      { id: "opencode", installed: true, signedIn: null, actions: [] },
    ],
  }));
  const call = vi.fn(async (op: string, input?: { model?: string }) =>
    op === "engine.list" ? inventory() : listing(input)
  ) as unknown as EngineCalls["call"];
  let online = true,
    enabled = true,
    blocked = false;
  const learned = vi.fn(async (id, engine, result, settings, timestamp) => {
    rows.set(
      namespaced(settings, `agent_models_refresh:${engine}`),
      JSON.stringify({ refreshedAt: timestamp })
    );
    rows.set(
      namespaced(settings, `agent_models_observation:${engine}`),
      JSON.stringify({
        revision: 1,
        observedAt: timestamp,
        effort: Object.fromEntries(
          result.models
            .filter(
              (m: { id: string; effort?: unknown }) => m.effort !== undefined
            )
            .map((m: { id: string }) => [m.id, timestamp])
        ),
      })
    );
    setLearnedAgentModels(engine, result.models, result.defaultModel, id);
    return true;
  });
  const changed = vi.fn(),
    failed = vi.fn();
  const create = () => {
    const service = new ModelCatalogRefresh({
      pool,
      now: () => now,
      resolve: (id) => ({
        settings:
          id === "local" ? localRunnerSettings : enrolledRunnerSettings(id),
        online,
        enabled,
        blocked,
        calls: { call },
      }),
      learn: learned,
      changed,
      failed,
    });
    refreshers.push(service);
    return service;
  };
  const service = create();
  return {
    service,
    create,
    rows,
    listing,
    inventory,
    learned,
    changed,
    failed,
    call,
    advance: (ms: number) => {
      now += ms;
    },
    setOnline: (v: boolean) => {
      online = v;
    },
    setEnabled: (v: boolean) => {
      enabled = v;
    },
    setBlocked: (v: boolean) => {
      blocked = v;
    },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Real transaction/learning seam; only the engine process and SQL transport are fixtures. */
function orderingFixture() {
  let now = Date.now();
  const rows = new Map<string, string>();
  let transaction: Map<string, string> | undefined;
  const query = async (sql: string, args: string[] = []) => {
    if (sql === "BEGIN") transaction = new Map(rows);
    if (sql === "COMMIT" && transaction) {
      rows.clear();
      for (const [key, value] of transaction) rows.set(key, value);
      transaction = undefined;
    }
    if (sql === "ROLLBACK") transaction = undefined;
    if (sql.includes("FROM runner_registrations"))
      return { rows: [{ id: "alpha" }, { id: "beta" }] };
    const store = transaction ?? rows;
    if (sql.includes("INSERT INTO settings")) store.set(args[0]!, args[1]!);
    return {
      rows: store.has(args[0]!) ? [{ value: store.get(args[0]!) }] : [],
    };
  };
  const pool = {
    query,
    connect: async () => ({ query, release() {} }),
  } as unknown as Pool;
  const settings = (id: string) =>
    id === "local" ? localRunnerSettings : enrolledRunnerSettings(id);
  const listing = vi.fn(
    async (
      _id: string,
      input: { engine: string; model?: string }
    ): Promise<Res<"engine.models">> => ({
      current: input.model ?? "a",
      defaultModel: "a",
      models: [
        { id: "a", label: "A", effort: [] },
        { id: "b", label: "B" },
        { id: "c", label: "C" },
      ],
    })
  );
  const online = new Map<string, boolean>(),
    blocked = new Map<string, boolean>();
  const changed = vi.fn();
  const create = () => {
    const service = new ModelCatalogRefresh({
      pool,
      now: () => now,
      changed,
      resolve: (id) => ({
        settings: settings(id),
        online: online.get(id) !== false,
        enabled: true,
        blocked: blocked.get(id),
        calls: {
          call: async (
            op: string,
            input: { engine: string; model?: string }
          ) =>
            op === "engine.list"
              ? {
                  entries: ["claude", "codex", "opencode"].map((id) => ({
                    id,
                    installed: true,
                    signedIn: true,
                    actions: ["login"],
                  })),
                }
              : listing(id, input),
        } as never,
      }),
    });
    refreshers.push(service);
    return service;
  };
  const service = create();
  const report = async (id: string, engine: AgentType, model = "report") =>
    recordEngineModels(
      { pool, logger: { info() {} } as never },
      { id: "agent", type: engine, model: null },
      [
        {
          id: "model",
          name: "Model",
          type: "select",
          currentValue: model,
          options: [{ value: model, name: model }],
        },
      ],
      true,
      { runnerId: id, settings: settings(id) }
    );
  return {
    service,
    create,
    rows,
    pool,
    settings,
    listing,
    changed,
    online,
    blocked,
    report,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
async function flush() {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

describe("discovery FIFO and observation ordering", () => {
  it("serializes three cold engines and repeated reads never add duplicate work", async () => {
    const f = orderingFixture();
    const gate = deferred<Res<"engine.models">>();
    f.listing.mockReturnValueOnce(gate.promise);
    for (let i = 0; i < 100; i++)
      for (const engine of ["claude", "codex", "opencode"] as const)
        f.service.request("alpha", engine);
    await flush();
    expect(f.listing).toHaveBeenCalledTimes(1);
    gate.resolve({ current: "a", models: [{ id: "a", label: "A" }] });
    await Promise.all(
      ["claude", "codex", "opencode"].map((engine) =>
        f.service.settled("alpha", engine as AgentType)
      )
    );
    expect(f.listing.mock.calls.map(([, input]) => input.engine)).toEqual([
      "claude",
      "codex",
      "opencode",
    ]);
    for (const engine of ["claude", "codex", "opencode"] as const)
      expect(getLearnedAgentModels(engine, "alpha")).toBeDefined();
  });
  it.each(["fenced", "offline", "reported"])(
    "allows two runners in parallel but rechecks a queued runner when %s",
    async (reason) => {
      const f = orderingFixture();
      const gate = deferred<Res<"engine.models">>();
      f.listing
        .mockReturnValueOnce(gate.promise)
        .mockReturnValueOnce(gate.promise);
      f.service.request("alpha", "codex");
      f.service.request("alpha", "opencode");
      f.service.request("beta", "codex");
      await flush();
      expect(f.listing.mock.calls.map(([id]) => id)).toEqual(["alpha", "beta"]);
      if (reason === "fenced") f.blocked.set("alpha", true);
      if (reason === "offline") f.online.set("alpha", false);
      if (reason === "reported") await f.report("alpha", "opencode");
      gate.resolve({ current: "a", models: [{ id: "a", label: "A" }] });
      await Promise.all([
        f.service.settled("alpha", "opencode"),
        f.service.settled("beta", "codex"),
      ]);
      expect(f.listing).toHaveBeenCalledTimes(2);
    }
  );
  it("caps a cold validation's total wait at 40 seconds without blocking pickers", async () => {
    vi.useFakeTimers();
    const f = orderingFixture();
    f.listing.mockImplementation(() => new Promise(() => {}));
    f.service.request("alpha", "claude");
    f.service.request("alpha", "codex");
    const scope = f.service.validate("alpha", "opencode", {
      model: "unseeded",
    });
    let finished = false;
    void scope.then(() => {
      finished = true;
    });
    await vi.advanceTimersByTimeAsync(39_999);
    expect(finished).toBe(false);
    expect(readStoredModelCatalog("alpha", "opencode")).toEqual({
      defaultModel: null,
      models: [],
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(await scope).toBe(false);
  });
  it("uses the same validation deadline for queued never-observed effort", async () => {
    vi.useFakeTimers();
    const f = orderingFixture();
    f.service.request("alpha", "opencode");
    await f.service.settled("alpha", "opencode");
    f.listing.mockImplementation(() => new Promise(() => {}));
    f.service.request("alpha", "claude");
    f.service.request("alpha", "codex");
    const validated = f.service.validate("alpha", "opencode", {
      model: "b",
      effort: "high",
    });
    await vi.advanceTimersByTimeAsync(40_000);
    expect(await validated).toBe(false); // Engine scope, including effort validation.
  });
  it.each(["local", "alpha"])(
    "a %s report teaches effort age and a superseded effort fetch has no backoff",
    async (id) => {
      const f = orderingFixture();
      await f.report(id, "opencode");
      f.service.read(id, "opencode", "report");
      await f.service.settled(id, "opencode", "report");
      expect(f.listing).not.toHaveBeenCalled();
      const report = () =>
        recordEngineModels(
          { pool: f.pool, logger: { info() {} } as never },
          { id: "agent", type: "opencode", model: null },
          [
            {
              id: "model",
              name: "Model",
              type: "select",
              currentValue: "a",
              options: [
                { value: "a", name: "A" },
                { value: "b", name: "B" },
              ],
            },
          ],
          true,
          { runnerId: id, settings: f.settings(id) }
        );
      await report();
      const gate = deferred<Res<"engine.models">>();
      f.listing.mockReturnValueOnce(gate.promise);
      f.service.read(id, "opencode", "b");
      await flush();
      await report();
      const saved = new Map(f.rows);
      gate.resolve({
        current: "b",
        models: [{ id: "b", label: "Outdated", effort: [] }],
      });
      await f.service.settled(id, "opencode", "b");
      expect(f.rows).toEqual(saved);
      expect(f.changed).not.toHaveBeenCalled();
      f.service.read(id, "opencode", "b");
      await f.service.settled(id, "opencode", "b");
      expect(f.listing).toHaveBeenCalledTimes(2);
    }
  );
  it.each([
    ["local", undefined],
    ["alpha", undefined],
    ["local", "b"],
    ["alpha", "b"],
  ] as const)(
    "discards %s stale discovery (selected %s) after a committed report, including after restart",
    async (id, model) => {
      const f = orderingFixture();
      if (model) {
        f.service.request(id, "opencode");
        await f.service.settled(id, "opencode");
        f.changed.mockClear();
      }
      const gate = deferred<Res<"engine.models">>();
      f.listing.mockReturnValueOnce(gate.promise);
      f.service.request(id, "opencode", model);
      await flush();
      await f.report(id, "opencode");
      const saved = new Map(f.rows);
      gate.resolve({
        current: "stale",
        models: [{ id: "stale", label: "Stale" }],
      });
      await f.service.settled(id, "opencode", model);
      expect(f.rows).toEqual(saved);
      expect(getLearnedAgentModels("opencode", id)?.map((m) => m.id)).toEqual([
        "report",
      ]);
      expect(f.changed).not.toHaveBeenCalled();
      // A report resets the durable one-hour age; no stale-refresh backoff is stored.
      const restarted = f.create();
      restarted.request(id, "opencode");
      await restarted.settled(id, "opencode");
      expect(f.listing).toHaveBeenCalledTimes(model ? 2 : 1);
      expect(
        (await readModelObservation(f.pool, f.settings(id), "opencode"))
          .revision
      ).toBe(model ? 2 : 1);
      f.advance(MODEL_REFRESH_AGE_MS + 1000);
      restarted.request(id, "opencode");
      await restarted.settled(id, "opencode");
      expect(f.listing).toHaveBeenCalledTimes(model ? 3 : 2);
    }
  );
  it("persists effort ages across restart, preserves retained ages, and retries only a selected stale model", async () => {
    const f = orderingFixture();
    f.service.request("alpha", "opencode");
    await f.service.settled("alpha", "opencode");
    const initial = await readModelObservation(
      f.pool,
      f.settings("alpha"),
      "opencode"
    );
    expect(Object.keys(initial.effort)).toEqual(["a"]);
    f.advance(MODEL_REFRESH_AGE_MS / 2);
    f.listing.mockResolvedValueOnce({
      current: "b",
      models: [
        { id: "a", label: "A" },
        { id: "b", label: "B", effort: [] },
        { id: "c", label: "C" },
      ],
    });
    f.service.read("alpha", "opencode", "b");
    await f.service.settled("alpha", "opencode", "b");
    const observed = await readModelObservation(
      f.pool,
      f.settings("alpha"),
      "opencode"
    );
    expect(observed.effort.a).toBe(initial.effort.a);
    expect(observed.effort.b).not.toBe(initial.effort.a);
    const restarted = f.create();
    restarted.read("alpha", "opencode", "b");
    await restarted.settled("alpha", "opencode", "b");
    expect(f.listing).toHaveBeenCalledTimes(2);
    f.advance(MODEL_REFRESH_AGE_MS);
    // Simulate a fresh unrelated catalog observation: b alone is stale.
    f.rows.set(
      namespaced(f.settings("alpha"), "agent_models_refresh:opencode"),
      JSON.stringify({
        refreshedAt: new Date(
          Date.parse(observed.observedAt!) + MODEL_REFRESH_AGE_MS
        ).toISOString(),
      })
    );
    restarted.read("alpha", "opencode", "b");
    await restarted.settled("alpha", "opencode", "b");
    expect(f.listing.mock.calls.map(([, input]) => input.model)).toEqual([
      undefined,
      "b",
      "b",
    ]);
    expect(f.listing.mock.calls.some(([, input]) => input.model === "c")).toBe(
      false
    );
  });
  it.each(["local", "alpha"])(
    "returns %s selected effort immediately, serializes models and publishes updates",
    async (id) => {
      const f = orderingFixture();
      f.service.request(id, "opencode");
      await f.service.settled(id, "opencode");
      f.changed.mockClear();
      f.listing.mockClear();
      const gate = deferred<Res<"engine.models">>();
      f.listing
        .mockReturnValueOnce(gate.promise)
        .mockImplementationOnce(async () => ({
          current: "c",
          models: [
            { id: "a", label: "A", effort: [] },
            { id: "b", label: "B", effort: [{ value: "high", name: "High" }] },
            { id: "c", label: "C", effort: [] },
          ],
        }));
      stop = onStoredModelCatalogRead((runner, engine, model) =>
        f.service.read(runner, engine, model)
      );
      for (let i = 0; i < 50; i++) {
        expect(
          readStoredModelCatalog(id, "opencode", "b").models.find(
            (m) => m.id === "b"
          )?.effort
        ).toBeUndefined();
        readStoredModelCatalog(id, "opencode", "c");
      }
      await flush();
      expect(f.listing).toHaveBeenCalledTimes(1);
      gate.resolve({
        current: "b",
        models: [
          { id: "a", label: "A", effort: [] },
          { id: "b", label: "B", effort: [{ value: "high", name: "High" }] },
          { id: "c", label: "C" },
        ],
      });
      await f.service.settled(id, "opencode", "c");
      expect(f.listing.mock.calls.map(([, input]) => input.model)).toEqual([
        "b",
        "c",
      ]);
      expect(f.changed).toHaveBeenCalledWith(id, "opencode");
      expect(
        readStoredModelCatalog(id, "opencode", "b").models.find(
          (m) => m.id === "b"
        )?.effort?.[0]?.value
      ).toBe("high");
      await f.service.settled(id, "opencode", "b");
      expect(f.listing).toHaveBeenCalledTimes(2);
    }
  );
});

describe("stored model catalog revalidation", () => {
  it("returns the stored snapshot immediately and single-flights concurrent reads for an hour", async () => {
    const f = fixture();
    const pending = deferred<Awaited<ReturnType<typeof f.listing>>>();
    f.listing.mockReturnValueOnce(pending.promise);
    setLearnedAgentModels(
      "codex",
      [{ id: "old", label: "Old" }],
      "old",
      "alpha"
    );
    stop = onStoredModelCatalogRead((id, engine) =>
      f.service.request(id, engine)
    );
    for (let i = 0; i < 50; i++)
      expect(readStoredModelCatalog("alpha", "codex").defaultModel).toBe("old");
    await vi.waitFor(() => expect(f.listing).toHaveBeenCalledTimes(1));
    expect(f.learned).not.toHaveBeenCalled();
    pending.resolve({
      defaultModel: "new",
      models: [
        {
          id: "new",
          label: "New",
          effort: [
            { value: "high", name: "High", description: "Full description" },
          ],
        },
      ],
    });
    await f.service.settled("alpha", "codex");
    expect(
      readStoredModelCatalog("alpha", "codex").models[0]?.effort?.[0]
        ?.description
    ).toBe("Full description");
    f.advance(MODEL_REFRESH_AGE_MS - 1);
    f.service.request("alpha", "codex");
    expect(f.listing).toHaveBeenCalledTimes(1);
    f.advance(1);
    for (let i = 0; i < 50; i++) f.service.request("alpha", "codex");
    await f.service.settled("alpha", "codex");
    expect(f.listing).toHaveBeenCalledTimes(2);
  });
  it("persists successful age across a coordinator restart and treats corrupt timestamps as stale", async () => {
    const f = fixture();
    f.service.request("local", "codex");
    await f.service.settled("local", "codex");
    f.service.close();
    const restarted = f.create();
    restarted.request("local", "codex");
    await restarted.settled("local", "codex");
    expect(f.listing).toHaveBeenCalledTimes(1);
    f.rows.set("runner:beta:agent_models_refresh:codex", "{corrupt");
    restarted.request("beta", "codex");
    await restarted.settled("beta", "codex");
    expect(f.listing).toHaveBeenCalledTimes(2);
  });
  it("refreshes runners and engines independently without changing another catalog", async () => {
    const f = fixture();
    setLearnedAgentModels("codex", [{ id: "local", label: "Local" }], "local");
    setLearnedAgentModels(
      "codex",
      [{ id: "beta", label: "Beta" }],
      "beta",
      "beta"
    );
    f.service.request("alpha", "codex");
    f.service.request("alpha", "opencode");
    await Promise.all([
      f.service.settled("alpha", "codex"),
      f.service.settled("alpha", "opencode"),
    ]);
    expect(f.listing).toHaveBeenCalledTimes(2);
    expect(getAgentModelOptions("codex")[0]?.id).toBe("local");
    expect(getAgentModelOptions("codex", "beta")[0]?.id).toBe("beta");
    f.service.request("beta", "codex");
    await f.service.settled("beta", "codex");
    expect(f.listing).toHaveBeenCalledTimes(3);
  });
  it.each(["offline", "no spec", "frozen", "not installed", "not signed in"])(
    "does not start a listing when %s",
    async (reason) => {
      const f = fixture();
      if (reason === "offline") f.setOnline(false);
      if (reason === "no spec") f.setEnabled(false);
      if (reason === "frozen") f.setBlocked(true);
      if (reason === "not installed")
        f.inventory.mockResolvedValue({
          entries: [
            {
              id: "codex",
              installed: false,
              signedIn: true,
              actions: ["login"],
            },
          ],
        });
      if (reason === "not signed in")
        f.inventory.mockResolvedValue({
          entries: [
            {
              id: "codex",
              installed: true,
              signedIn: false,
              actions: ["login"],
            },
          ],
        });
      f.service.request("alpha", "codex");
      await f.service.settled("alpha", "codex");
      expect(f.listing).not.toHaveBeenCalled();
      expect(f.learned).not.toHaveBeenCalled();
    }
  );
  it.each(["failed", "fenced"])(
    "keeps stored values on %s and waits for the next read after backoff",
    async (kind) => {
      const f = fixture();
      setLearnedAgentModels(
        "codex",
        [{ id: "old", label: "Old" }],
        "old",
        "alpha"
      );
      f.listing.mockRejectedValueOnce(
        new RunnerCallError({
          code: kind === "fenced" ? "fenced" : "internal",
          message: "fixture",
        })
      );
      f.service.request("alpha", "codex");
      await f.service.settled("alpha", "codex");
      expect(getAgentModelOptions("codex", "alpha")[0]?.id).toBe("old");
      expect(f.learned).not.toHaveBeenCalled();
      expect(f.rows.size).toBe(0);
      f.advance(MODEL_REFRESH_BACKOFF_MS - 1);
      f.service.request("alpha", "codex");
      expect(f.listing).toHaveBeenCalledTimes(1);
      f.advance(1);
      expect(f.listing).toHaveBeenCalledTimes(1);
      f.service.request("alpha", "codex");
      await f.service.settled("alpha", "codex");
      expect(f.listing).toHaveBeenCalledTimes(2);
    }
  );
  it("bounds a non-cooperative transport and never publishes a late result", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const pending = deferred<Awaited<ReturnType<typeof f.listing>>>();
    f.listing.mockReturnValueOnce(pending.promise);
    f.service.request("alpha", "codex");
    await vi.advanceTimersByTimeAsync(20_001);
    await f.service.settled("alpha", "codex");
    expect(f.failed).toHaveBeenCalled();
    pending.resolve({ defaultModel: "late", models: [] });
    await Promise.resolve();
    expect(f.learned).not.toHaveBeenCalled();
  });
  it("invalidates fresh catalogs after successful actions and fences an older in-flight listing", async () => {
    const f = fixture();
    const pending = deferred<Awaited<ReturnType<typeof f.listing>>>();
    f.listing.mockReturnValueOnce(pending.promise);
    f.service.request("alpha", "codex");
    await vi.waitFor(() => expect(f.listing).toHaveBeenCalledTimes(1));
    f.service.invalidate("alpha", "codex");
    pending.resolve({ defaultModel: "stale", models: [] });
    await f.service.settled("alpha", "codex");
    expect(f.learned).toHaveBeenCalledTimes(1);
    expect(f.learned.mock.calls[0]?.[2].defaultModel).toBe("new");
    f.service.invalidate("alpha", "codex");
    await f.service.settled("alpha", "codex");
    expect(f.listing).toHaveBeenCalledTimes(3);
  });
  it("remembers invalidation while offline for the next read after reconnect", async () => {
    const f = fixture();
    f.service.request("alpha", "codex");
    await f.service.settled("alpha", "codex");
    f.setOnline(false);
    f.service.invalidate("alpha", "codex");
    await f.service.settled("alpha", "codex");
    expect(f.rows.get("runner:alpha:agent_models_refresh:codex")).toBe(
      '{"refreshedAt":null}'
    );
    expect(f.listing).toHaveBeenCalledTimes(1);
    f.setOnline(true);
    f.service.request("alpha", "codex");
    await f.service.settled("alpha", "codex");
    expect(f.listing).toHaveBeenCalledTimes(2);
  });
  it("observes a successful update only after persistence, not reads or failed commits", async () => {
    const records: any = {};
    let fail = false;
    const events: string[] = [];
    const store = observeModelUpdates(
      {
        async exclusive(work) {
          const value = await work(records);
          if (fail) throw Error("commit failed");
          events.push("commit");
          return value;
        },
      },
      (engine) => events.push(engine)
    );
    await store.exclusive(async (rows) => {
      rows.codex = { id: "one", status: "succeeded" } as never;
    });
    expect(events).toEqual(["commit", "codex"]);
    await store.exclusive(async () => {});
    expect(events).toEqual(["commit", "codex", "commit"]);
    fail = true;
    await expect(
      store.exclusive(async (rows) => {
        rows.codex = { id: "two", status: "succeeded" } as never;
      })
    ).rejects.toThrow();
    expect(events).toEqual(["commit", "codex", "commit"]);
  });
});

function validationFixture() {
  const f = fixture();
  stop = onStoredModelCatalogRead((id, engine) =>
    f.service.request(id, engine)
  );
  stopValidation = onModelCatalogValidation((id, engine, request) =>
    f.service.validate(id, engine, request)
  );
  return f;
}
const validationTargets = [
  { id: "local", target: "/tmp/validation" },
  { id: "alpha", target: "runner://alpha/@session" },
];
describe.each(validationTargets)(
  "first catalog validation on $id",
  ({ id, target }) => {
    it("accepts an unseeded OpenCode model after one shared first refresh; picker reads never wait", async () => {
      const f = validationFixture();
      const listing = deferred<Awaited<ReturnType<typeof f.listing>>>();
      f.listing.mockReturnValueOnce(listing.promise);
      const launches = Array.from({ length: 20 }, () =>
        modelScopeFor(target, "opencode", { model: "new" })
      );
      let done = false;
      void launches[0]!.then(() => {
        done = true;
      });
      await vi.waitFor(() => expect(f.listing).toHaveBeenCalledOnce());
      expect(done).toBe(false);
      expect(readStoredModelCatalog(id, "opencode").models).toEqual([]);
      listing.resolve({
        defaultModel: "new",
        models: [{ id: "new", label: "New", effort: [] }],
      });
      for (const scope of await Promise.all(launches))
        expect(validateAgentModel("opencode", "new", scope)).toBe("new");
      expect(f.listing).toHaveBeenCalledOnce();
    });
    it("uses main's exact rejection text after a successful first listing", async () => {
      const f = validationFixture();
      const scope = await modelScopeFor(target, "opencode", {
        model: "absent",
      });
      expect(() => validateAgentModel("opencode", "absent", scope)).toThrow(
        'Model "absent" is not supported for opencode. Choose a configured model or omit model for the CLI default.'
      );
      expect(f.listing).toHaveBeenCalledOnce();
    });
    it.each([
      "failed",
      "fenced",
      "timeout",
      "offline",
      "not installed",
      "not signed in",
    ])(
      "defers a first %s listing to the engine without caching a catalog",
      async (reason) => {
        const f = validationFixture();
        if (reason === "offline") f.setOnline(false);
        if (reason === "not installed")
          f.inventory.mockResolvedValue({
            entries: [
              {
                id: "codex",
                installed: false,
                signedIn: true,
                actions: ["login"],
              },
            ],
          });
        if (reason === "not signed in")
          f.inventory.mockResolvedValue({
            entries: [
              {
                id: "codex",
                installed: true,
                signedIn: false,
                actions: ["login"],
              },
            ],
          });
        if (reason === "failed" || reason === "fenced")
          f.listing.mockRejectedValueOnce(
            new RunnerCallError({
              code: reason === "fenced" ? "fenced" : "internal",
              message: "fixture",
            })
          );
        if (reason === "timeout") {
          vi.useFakeTimers();
          f.listing.mockReturnValueOnce(new Promise(() => {}));
        }
        const validation = modelScopeFor(target, "codex", {
          model: "provider/unseeded",
          effort: "unseen-effort",
        });
        if (reason === "timeout") await vi.advanceTimersByTimeAsync(20_001);
        const scope = await validation;
        expect(scope).toEqual({ kind: "engine" });
        expect(validateAgentModel("codex", "provider/unseeded", scope)).toBe(
          "provider/unseeded"
        );
        expect(
          validateAgentEffort(
            "codex",
            "unseen-effort",
            "provider/unseeded",
            scope
          )
        ).toBe("unseen-effort");
        expect(getLearnedAgentModels("codex", id)).toBeUndefined();
        expect(f.learned).not.toHaveBeenCalled();
        expect(
          readStoredModelCatalog(id, "codex").models.length
        ).toBeGreaterThan(0);
      }
    );
    it("rejects unknown models immediately against a taught catalog while revalidation waits", async () => {
      const f = validationFixture();
      setLearnedAgentModels(
        "opencode",
        [{ id: "known", label: "Known" }],
        "known",
        id
      );
      const listing = deferred<Awaited<ReturnType<typeof f.listing>>>();
      f.listing.mockReturnValueOnce(listing.promise);
      const scope = await modelScopeFor(target, "opencode", {
        model: "absent",
      });
      expect(() => validateAgentModel("opencode", "absent", scope)).toThrow(
        'Model "absent" is not supported for opencode. Choose a configured model or omit model for the CLI default.'
      );
      expect(readStoredModelCatalog(id, "opencode").models[0]?.id).toBe(
        "known"
      );
      listing.resolve({
        defaultModel: "new",
        models: [{ id: "new", label: "New", effort: [] }],
      });
      await f.service.settled(id, "opencode");
    });
    it("single-flights a first selected-model effort fetch, preserving the default", async () => {
      const f = validationFixture();
      setLearnedAgentModels(
        "opencode",
        [
          { id: "a", label: "A", effort: [] },
          { id: "b", label: "B" },
        ],
        "a",
        id
      );
      const settings =
        id === "local" ? localRunnerSettings : enrolledRunnerSettings(id);
      f.rows.set(
        namespaced(settings, "agent_models_refresh:opencode"),
        JSON.stringify({
          refreshedAt: new Date(Date.UTC(2026, 0, 1)).toISOString(),
        })
      );
      f.listing.mockImplementation(async (input) => ({
        defaultModel: "a",
        current: input?.model,
        models: [
          { id: "a", label: "A", effort: [] },
          {
            id: "b",
            label: "B",
            effort: [
              {
                value: "turbo",
                name: "Turbo",
                description: "Full description",
              },
            ],
          },
        ],
      }));
      const scopes = await Promise.all(
        Array.from({ length: 20 }, () =>
          modelScopeFor(target, "opencode", { model: " b ", effort: "turbo" })
        )
      );
      for (const scope of scopes)
        expect(validateAgentEffort("opencode", "turbo", "b", scope)).toBe(
          "turbo"
        );
      expect(f.listing).toHaveBeenCalledOnce();
      expect(f.listing).toHaveBeenCalledWith({
        engine: "opencode",
        model: "b",
      });
      expect(readStoredModelCatalog(id, "opencode").defaultModel).toBe("a");
      await modelScopeFor(target, "opencode", {
        model: " b ",
        effort: "turbo",
      });
      expect(f.listing).toHaveBeenCalledOnce();
    });
    it("keeps the engine freshness aligned with a foreground effort listing", async () => {
      const f = validationFixture();
      f.listing.mockResolvedValueOnce({
        defaultModel: "a",
        models: [
          { id: "a", label: "A", effort: [] },
          { id: "b", label: "B" },
        ],
      });
      await modelScopeFor(target, "opencode", { model: "a" });
      f.advance(MODEL_REFRESH_AGE_MS - 1000);
      f.listing.mockResolvedValueOnce({
        defaultModel: "a",
        current: "b",
        models: [
          { id: "a", label: "A", effort: [] },
          { id: "b", label: "B", effort: [{ value: "high", name: "High" }] },
        ],
      } as never);
      await modelScopeFor(target, "opencode", { model: "b", effort: "high" });
      expect(f.listing).toHaveBeenCalledTimes(2);
      f.advance(1000);
      readStoredModelCatalog(id, "opencode");
      await f.service.settled(id, "opencode");
      expect(f.listing).toHaveBeenCalledTimes(2);
      f.advance(MODEL_REFRESH_AGE_MS - 1000);
      readStoredModelCatalog(id, "opencode");
      await f.service.settled(id, "opencode");
      expect(f.listing).toHaveBeenCalledTimes(3);
    });
    it.each(["offline", "failed", "fenced", "timeout"])(
      "does not reject never-fetched effort after %s",
      async (reason) => {
        const f = validationFixture();
        setLearnedAgentModels("opencode", [{ id: "a", label: "A" }], "a", id);
        const settings =
          id === "local" ? localRunnerSettings : enrolledRunnerSettings(id);
        f.rows.set(
          namespaced(settings, "agent_models_refresh:opencode"),
          JSON.stringify({
            refreshedAt: new Date(Date.UTC(2026, 0, 1)).toISOString(),
          })
        );
        if (reason === "offline") f.setOnline(false);
        else if (reason === "timeout") {
          vi.useFakeTimers();
          f.listing.mockReturnValueOnce(new Promise(() => {}));
        } else
          f.listing.mockRejectedValueOnce(
            new RunnerCallError({
              code: reason === "fenced" ? "fenced" : "internal",
              message: "Fixture effort fetch failed",
            })
          );
        const pending = modelScopeFor(target, "opencode", {
          model: "a",
          effort: "unreported",
        });
        if (reason === "timeout") await vi.advanceTimersByTimeAsync(20_001);
        const scope = await pending;
        expect(validateAgentEffort("opencode", "unreported", "a", scope)).toBe(
          "unreported"
        );
        expect(
          getLearnedAgentModels("opencode", id)?.[0]?.effort
        ).toBeUndefined();
        expect(f.listing).toHaveBeenCalledTimes(reason === "offline" ? 0 : 1);
      }
    );
    it("rejects an unknown model immediately after a successful refresh, while an hourly refresh waits", async () => {
      const f = validationFixture();
      await modelScopeFor(target, "opencode", { model: "new" });
      f.advance(MODEL_REFRESH_AGE_MS);
      const listing = deferred<Awaited<ReturnType<typeof f.listing>>>();
      f.listing.mockReturnValueOnce(listing.promise);
      const scope = await modelScopeFor(target, "opencode", {
        model: "absent",
      });
      expect(() => validateAgentModel("opencode", "absent", scope)).toThrow(
        'Model "absent" is not supported for opencode. Choose a configured model or omit model for the CLI default.'
      );
      await vi.waitFor(() => expect(f.listing).toHaveBeenCalledTimes(2));
      listing.resolve({
        defaultModel: "new",
        models: [{ id: "new", label: "New", effort: [] }],
      });
      await f.service.settled(id, "opencode");
    });
  }
);
