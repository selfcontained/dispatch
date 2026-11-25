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
import type { Pool } from "pg";
import { setupTestDb, teardownTestDb, runTestMigrations } from "./db/setup.js";
import {
  recordEngineModels,
  recordDiscoveredModels,
  loadLearnedAgentModels,
} from "../src/agents/engine-models.js";
import { loadModelAvailability } from "../src/agents/model-availability.js";
import {
  agentModelCatalog,
  agentModelAvailability,
  agentModelDefaults,
  forgetLearnedAgentModels,
  getReportedModelHistory,
} from "../src/shared/agent-models.js";
import {
  localRunnerSettings,
  enrolledRunnerSettings,
  namespaced,
} from "../src/runners/settings-namespace.js";

let pool: Pool;
beforeAll(async () => {
  pool = await setupTestDb();
  await runTestMigrations();
});
afterAll(teardownTestDb);
afterEach(forgetLearnedAgentModels);
beforeEach(async () => {
  await pool.query("DELETE FROM settings");
});

const logger = { info: vi.fn() } as never;
describe("atomic catalog learning", () => {
  it.each(["local report", "runner report", "refresh"] as const)(
    "publishes nothing on a failed %s write, then allows the next observation",
    async (source) => {
      const runnerId = source === "runner report" ? "atomic-fixture" : "local";
      const settings =
        source === "runner report"
          ? enrolledRunnerSettings(runnerId)
          : localRunnerSettings;
      const context = { runnerId, settings };
      const catalogKey = namespaced(settings, "agent_models:codex");
      const historyKey = namespaced(settings, "agent_model_availability:codex");
      const refreshKey = namespaced(settings, "agent_models_refresh:codex");
      await pool.query("INSERT INTO settings(key,value) VALUES ($1,$2)", [
        catalogKey,
        JSON.stringify({
          models: [{ id: "old", label: "Old" }],
          defaultModel: "old",
          seenAt: "2026-01-01T00:00:00Z",
        }),
      ]);
      await pool.query(
        "INSERT INTO settings(key,value) VALUES ('agent_model_availability:codex',$1)",
        [
          JSON.stringify({
            autoEnable: false,
            disabled: [],
            known: ["old"],
            unseen: [],
          }),
        ]
      );
      if (source === "runner report")
        await pool.query("INSERT INTO settings(key,value) VALUES ($1,$2)", [
          historyKey,
          JSON.stringify({ known: ["old"], unseen: [] }),
        ]);
      await loadLearnedAgentModels(pool, runnerId, settings);
      await loadModelAvailability(pool);
      if (source === "runner report")
        await loadModelAvailability(pool, context);
      const beforeRows = (
        await pool.query("SELECT key,value FROM settings ORDER BY key")
      ).rows;
      const before = JSON.stringify({
        models: agentModelCatalog(runnerId),
        defaults: agentModelDefaults(runnerId),
        availability: agentModelAvailability(),
        history: getReportedModelHistory(runnerId, "codex"),
      });
      let fail = true;
      const failingKey = source === "refresh" ? refreshKey : catalogKey;
      const proxy = {
        query: pool.query.bind(pool),
        async connect() {
          const client = await pool.connect();
          return {
            release: () => client.release(),
            query(sql: string, args: string[]) {
              if (
                fail &&
                sql.includes("INSERT INTO settings") &&
                args[0] === failingKey
              ) {
                fail = false;
                return Promise.reject(
                  new Error("fixture durable write failed")
                );
              }
              return client.query(sql, args);
            },
          };
        },
      } as unknown as Pool;
      const observe = () =>
        source === "refresh"
          ? recordDiscoveredModels(
              proxy,
              "codex",
              {
                current: "new",
                defaultModel: "new",
                models: [
                  {
                    id: "new",
                    label: "New",
                    effort: [
                      {
                        value: "high",
                        name: "High",
                        description: "Full description",
                      },
                    ],
                  },
                ],
              },
              context,
              "2026-11-25T00:00:00Z"
            )
          : recordEngineModels(
              { pool: proxy, logger },
              { id: "fixture", type: "codex", model: "new" },
              [
                {
                  id: "model",
                  name: "Model",
                  type: "select",
                  currentValue: "new",
                  options: [{ value: "new", name: "New" }],
                },
              ],
              true,
              context
            );
      await expect(observe()).rejects.toThrow("fixture durable write failed");
      expect(
        (await pool.query("SELECT key,value FROM settings ORDER BY key")).rows
      ).toEqual(beforeRows);
      expect(
        JSON.stringify({
          models: agentModelCatalog(runnerId),
          defaults: agentModelDefaults(runnerId),
          availability: agentModelAvailability(),
          history: getReportedModelHistory(runnerId, "codex"),
        })
      ).toBe(before);
      await observe();
      expect(
        agentModelCatalog(runnerId).codex?.map((model) => model.id)
      ).toEqual(["new"]);
      expect(agentModelAvailability().codex?.disabled).toEqual(["new"]);
    }
  );
});
